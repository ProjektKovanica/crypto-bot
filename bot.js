require('dotenv').config();
const ccxt = require('ccxt');
const { startServer } = require('./server');
const { db } = require('./db');
const { getIndicators } = require('./strategies/indicators');
const { evaluateAndTrade } = require('./strategies/trend_pullback');
const { syncPositions } = require('./strategies/position_manager');

const exchange = new ccxt.binance({
    apiKey: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
    enableRateLimit: true,
    options: { defaultType: 'future' }
});

const TRADING_PAIRS = ['BTC/USDC', 'ETH/USDC', 'BNB/USDC', 'XRP/USDC', 'SOL/USDC', 'DOGE/USDC'];

async function checkMarkets() {
    const botStatus = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
    if (botStatus.value === 'false') return; 

    try {
        await syncPositions(exchange, db);

        const balance = await exchange.fetchBalance();
        const usdcBalance = balance['USDC'] ? balance['USDC'].free : 0;

        if (usdcBalance < 20) return;

        console.log(`\n[${new Date().toISOString()}] Balans: $${usdcBalance.toFixed(2)} | Skeniram...`);
        
        for (const symbol of TRADING_PAIRS) {
            const indicators = await getIndicators(exchange, symbol, '15m', 100);
            
            if (indicators) {
                const existingPosition = db.prepare('SELECT id FROM active_positions WHERE symbol = ?').get(symbol);
                if (existingPosition) continue;

                await evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance);
            }
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
