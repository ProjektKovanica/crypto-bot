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

let isCycleRunning = false;
let cycleCounter = 0;

async function checkMarkets() {
    if (isCycleRunning) {
        console.warn('⏳ Preskačem ciklus: prethodni još traje.');
        return;
    }

    isCycleRunning = true;
    const cycleId = ++cycleCounter;
    const startedAt = Date.now();

    try {
        const botStatus = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
        if (!botStatus || botStatus.value === 'false') {
            console.log(`[CYCLE ${cycleId}] BOT_ACTIVE=false, preskačem.`);
            return;
        }

        console.log(`[CYCLE ${cycleId}] ▶ Start ${new Date().toISOString()}`);

        // sync postojećih pozicija sa burzom prije svakog ciklusa
        // (hvata SL/TP zatvaranja koja su se desila na burzi bez znanja bota)
        console.log(`[CYCLE ${cycleId}] Sync pozicija...`);
        await syncPositions(exchange, db);

        console.log(`[CYCLE ${cycleId}] Fetch balance...`);
        const balance = await exchange.fetchBalance();

        // free balance, ne total - margina već zaključana u otvorenim pozicijama
        // se time ne broji ponovno pri računanju veličine nove pozicije
        const usdcBalance = balance['USDC'] ? balance['USDC'].free : 0;

        console.log(`\n[${new Date().toISOString()}] Balans: $${Number(usdcBalance || 0).toFixed(2)} | Skeniram...`);

        if (usdcBalance < 20) {
            console.log(`[CYCLE ${cycleId}] Nedovoljan free USDC (${usdcBalance}). Minimum je 20.`);
            return;
        }

        for (const symbol of TRADING_PAIRS) {
            try {
                const existingPosition = db.prepare('SELECT id FROM active_positions WHERE symbol = ?').get(symbol);
                if (existingPosition) {
                    console.log(`[CYCLE ${cycleId}] ${symbol} preskočen: već otvorena pozicija.`);
                    continue;
                }

                console.log(`[CYCLE ${cycleId}] ${symbol} -> dohvat indikatora...`);
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
                    console.log(`[CYCLE ${cycleId}] ${symbol} preskočen: indikatori nepotpuni.`);
                    continue;
                }

                console.log(
                    `[CYCLE ${cycleId}] ${symbol} indikatori OK | price=${indicators.currentPrice} rsi=${indicators.rsi} ema=${indicators.ema} macdHist=${indicators.macd.histogram}`
                );

                await evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance);
            } catch (symbolError) {
                console.error(`[CYCLE ${cycleId}] Greška na ${symbol}:`, symbolError.message);
            }

            // pauza između parova da ne pucamo Binance rate limit
            await sleep(300);
        }
    } catch (error) {
        console.error(`[CYCLE ${cycleId}] Greška u glavnoj petlji:`, error.message);
    } finally {
        const durationMs = Date.now() - startedAt;
        console.log(`[CYCLE ${cycleId}] ■ Kraj ciklusa (${durationMs} ms)`);
        isCycleRunning = false;
    }
}

async function startBot() {
    startServer(exchange);

    // heartbeat da potvrdi da proces živi čak i kad nema trejdova
    setInterval(() => {
        console.log(`[HEARTBEAT] ${new Date().toISOString()} Bot proces aktivan.`);
    }, 60000);

    try {
        console.log('⏳ Učitavam markete...');
        await exchange.loadMarkets();
        console.log('✅ Marketi učitani. Pokrećem trading petlju (15s).');

        // pokreni odmah prvi ciklus, pa onda periodično
        await checkMarkets();
        setInterval(checkMarkets, 15000);
    } catch (error) {
        console.error('Kritična greška:', error.message);
        process.exit(1);
    }
}

startBot();
