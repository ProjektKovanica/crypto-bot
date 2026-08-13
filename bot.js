require('dotenv').config();
const ccxt = require('ccxt');
const { startServer } = require('./server');
const { db } = require('./db');
const { getIndicators } = require('./strategies/indicators');
const { evaluateAndTrade } = require('./strategies/trend_pullback');
const { syncPositions } = require('./strategies/position_manager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

// NAPOMENA: server.js ima svoj TRADING_PAIRS bez BNB/USDC (vidi popravak niže) -
// ako se ne poklapaju, dashboard dropdown neće nužno pokazivati sve parove kojima bot trguje.
const TRADING_PAIRS = ['BTC/USDC', 'ETH/USDC', 'BNB/USDC', 'XRP/USDC', 'SOL/USDC', 'DOGE/USDC'];

async function checkMarkets() {
    const botStatus = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
    if (!botStatus || botStatus.value === 'false') return;

    try {
        // sync postojećih pozicija sa burzom prije svakog ciklusa
        // (hvata SL/TP zatvaranja koja su se desila na burzi bez znanja bota)
        await syncPositions(exchange, db);

        const balance = await exchange.fetchBalance();
        // free balance, ne total - margina već zaključana u otvorenim pozicijama
        // se time ne broji ponovno pri računanju veličine nove pozicije
        const usdcBalance = balance['USDC'] ? balance['USDC'].free : 0;

        if (usdcBalance < 20) return;

        console.log(`\n[${new Date().toISOString()}] Balans: $${usdcBalance.toFixed(2)} | Skeniram...`);

        for (const symbol of TRADING_PAIRS) {
            try {
                const indicators = await getIndicators(exchange, symbol, '15m', 100);

                // puna provjera - ne samo da indicators postoji, nego da su
                // rsi/ema/macd.histogram stvarno izračunati (rani start = nema dosta svijeća)
                if (
                    !indicators ||
                    indicators.currentPrice == null ||
                    indicators.rsi == null ||
                    indicators.ema == null ||
                    !indicators.macd ||
                    indicators.macd.histogram == null
                ) {
                    continue;
                }

                // preskoči par ako već ima otvorenu poziciju (dodatna provjera postoji i u trend_pullback.js)
                const existingPosition = db.prepare('SELECT id FROM active_positions WHERE symbol = ?').get(symbol);
                if (existingPosition) continue;

                await evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance);
            } catch (symbolError) {
                console.error(`Greška na ${symbol}:`, symbolError.message);
            }

            // pauza između parova da ne pucamo Binance rate limit
            await sleep(300);
        }
    } catch (error) {
        console.error('Greška u glavnoj petlji:', error.message);
    }
}

async function startBot() {
    startServer(exchange);
    try {
        await exchange.loadMarkets();
        setInterval(checkMarkets, 15000);
    } catch (error) {
        console.error('Kritična greška:', error.message);
        process.exit(1);
    }
}

startBot();
