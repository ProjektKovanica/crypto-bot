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

function getUsdcAvailableBalance(balance) {
    // 1) USDⓈ-M futures specifično: info.assets[*].availableBalance
    // Kod nekih account konfiguracija CCXT mapira USDC.free=0, ali availableBalance postoji.
    try {
        const assets = balance?.info?.assets;
        if (Array.isArray(assets) && assets.length > 0) {
            // Prioritet USDC asset, zatim 'U' (USDⓈ agregat)
            const usdcAsset = assets.find(a => String(a.asset).toUpperCase() === 'USDC');
            if (usdcAsset && usdcAsset.availableBalance != null) {
                const v = Number(usdcAsset.availableBalance);
                if (Number.isFinite(v) && v > 0) return { value: v, source: 'info.assets.USDC.availableBalance' };
            }

            const usdSMAsset = assets.find(a => String(a.asset).toUpperCase() === 'U');
            if (usdSMAsset && usdSMAsset.availableBalance != null) {
                const v = Number(usdSMAsset.availableBalance);
                if (Number.isFinite(v) && v > 0) return { value: v, source: 'info.assets.U.availableBalance' };
            }
        }
    } catch (_) {}

    // 2) CCXT unified free map
    const freeUsdcMap = Number(balance?.free?.USDC);
    if (Number.isFinite(freeUsdcMap) && freeUsdcMap > 0) {
        return { value: freeUsdcMap, source: 'free.USDC' };
    }

    // 3) CCXT coin object
    const freeUsdcObj = Number(balance?.USDC?.free);
    if (Number.isFinite(freeUsdcObj) && freeUsdcObj > 0) {
        return { value: freeUsdcObj, source: 'USDC.free' };
    }

    // 4) fallback total (zadnje utočište za dijagnostiku)
    const totalUsdcMap = Number(balance?.total?.USDC);
    if (Number.isFinite(totalUsdcMap) && totalUsdcMap > 0) {
        return { value: totalUsdcMap, source: 'total.USDC(fallback)' };
    }

    const totalUsdcObj = Number(balance?.USDC?.total);
    if (Number.isFinite(totalUsdcObj) && totalUsdcObj > 0) {
        return { value: totalUsdcObj, source: 'USDC.total(fallback)' };
    }

    return { value: 0, source: 'none' };
}

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

        const usdcResolved = getUsdcAvailableBalance(balance);
        const usdcBalance = usdcResolved.value;

        console.log(
            `\n[${new Date().toISOString()}] Balans: $${Number(usdcBalance || 0).toFixed(2)} | Skeniram... (source=${usdcResolved.source})`
        );

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
