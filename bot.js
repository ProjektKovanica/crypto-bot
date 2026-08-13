require('dotenv').config();
const ccxt = require('ccxt');

const { startServer } = require('./server');
const { db, isDailyDrawdownBreached } = require('./db');
const { TRADING_PAIRS } = require('./config');
const { getIndicators } = require('./strategies/indicators');
const { evaluateAndTrade } = require('./strategies/trend_pullback');
const { syncPositions, monitorTrailingStops } = require('./strategies/position_manager');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
  options: { defaultType: 'future' }
});

let isCycleRunning = false;
let cycleCounter = 0;
let tradingPaused = false;

// stanje bota za API/server/dashboard
const botState = {
  cycleCounter: 0,
  isCycleRunning: false,
  lastCycleStartedAt: null,
  lastCycleEndedAt: null,
  lastPrices: {},
  tradingPaused: false
};
global.botState = botState;

function getUsdcAvailableBalance(balance) {
  try {
    const assets = balance?.info?.assets;
    if (Array.isArray(assets) && assets.length > 0) {
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

  const freeUsdcMap = Number(balance?.free?.USDC);
  if (Number.isFinite(freeUsdcMap) && freeUsdcMap > 0) return { value: freeUsdcMap, source: 'free.USDC' };

  const freeUsdcObj = Number(balance?.USDC?.free);
  if (Number.isFinite(freeUsdcObj) && freeUsdcObj > 0) return { value: freeUsdcObj, source: 'USDC.free' };

  const totalUsdcMap = Number(balance?.total?.USDC);
  if (Number.isFinite(totalUsdcMap) && totalUsdcMap > 0) return { value: totalUsdcMap, source: 'total.USDC(fallback)' };

  const totalUsdcObj = Number(balance?.USDC?.total);
  if (Number.isFinite(totalUsdcObj) && totalUsdcObj > 0) return { value: totalUsdcObj, source: 'USDC.total(fallback)' };

  return { value: 0, source: 'none' };
}

async function checkMarkets() {
  if (isCycleRunning) {
    console.warn('⏳ Preskačem ciklus: prethodni još traje.');
    return;
  }

  if (tradingPaused) {
    console.log('⏸️ Trading paused (memory flag), preskačem ciklus.');
    return;
  }

  isCycleRunning = true;
  const cycleId = ++cycleCounter;
  const startedAt = Date.now();
  botState.isCycleRunning = true;
  botState.cycleCounter = cycleId;
  botState.lastCycleStartedAt = new Date().toISOString();

  try {
    const botStatus = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
    if (!botStatus || botStatus.value === 'false') {
      console.log(`[CYCLE ${cycleId}] BOT_ACTIVE=false, preskačem.`);
      return;
    }

    console.log(`[CYCLE ${cycleId}] ▶ Start ${new Date().toISOString()}`);

    console.log(`[CYCLE ${cycleId}] Sync pozicija...`);
    await syncPositions(exchange, db);

    console.log(`[CYCLE ${cycleId}] Fetch balance...`);
    const balance = await exchange.fetchBalance();

    const usdcResolved = getUsdcAvailableBalance(balance);
    const usdcBalance = usdcResolved.value;

    console.log(`\n[${new Date().toISOString()}] Balans: $${Number(usdcBalance || 0).toFixed(2)} | Skeniram... (source=${usdcResolved.source})`);

    if (usdcBalance < 20) {
      console.log(`[CYCLE ${cycleId}] Nedovoljan free USDC (${usdcBalance}). Minimum je 20.`);
      return;
    }

    if (isDailyDrawdownBreached(db, usdcBalance)) {
      console.warn(`[CYCLE ${cycleId}] ⛔ Dnevni drawdown limit dostignut — preskačem novi entry.`);
      return;
    }

    const cooldownSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('COOLDOWN_SECONDS');
    const cooldownMs = (cooldownSetting ? parseInt(cooldownSetting.value, 10) : 300) * 1000;

    const maxPosSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('MAX_CONCURRENT_POSITIONS');
    const maxConcurrent = maxPosSetting ? parseInt(maxPosSetting.value, 10) : 3;

    for (const symbol of TRADING_PAIRS) {
      try {
        const openCount = db.prepare('SELECT COUNT(*) as c FROM active_positions').get().c;
        if (openCount >= maxConcurrent) {
          console.log(`[CYCLE ${cycleId}] ${symbol} preskočen: dostignut cap pozicija (${openCount}/${maxConcurrent})`);
          continue;
        }

        const existingPosition = db.prepare('SELECT id FROM active_positions WHERE symbol = ?').get(symbol);
        if (existingPosition) {
          console.log(`[CYCLE ${cycleId}] ${symbol} preskočen: već otvorena pozicija.`);
          continue;
        }

        const cooldownRow = db.prepare('SELECT last_trade_ts FROM symbol_cooldown WHERE symbol = ?').get(symbol);
        if (cooldownRow) {
          const elapsed = Date.now() - cooldownRow.last_trade_ts;
          if (elapsed < cooldownMs) {
            const remainingSec = Math.ceil((cooldownMs - elapsed) / 1000);
            console.log(`[CYCLE ${cycleId}] ${symbol} preskočen: cooldown aktivan (još ${remainingSec}s)`);
            continue;
          }
        }

        console.log(`[CYCLE ${cycleId}] ${symbol} -> dohvat indikatora...`);
        const indicators = await getIndicators(exchange, symbol, '15m', 100);

        if (
          !indicators ||
          indicators.currentPrice == null ||
          indicators.rsi == null ||
          indicators.rsiPrev == null ||
          indicators.ema == null ||
          !indicators.macd ||
          indicators.macd.histogram == null
        ) {
          console.log(`[CYCLE ${cycleId}] ${symbol} preskočen: indikatori nepotpuni.`);
          continue;
        }

        console.log(
          `[CYCLE ${cycleId}] ${symbol} indikatori OK | price=${indicators.currentPrice} rsi=${indicators.rsi?.toFixed(2)} ema=${indicators.ema?.toFixed(4)} macdHist=${indicators.macd.histogram?.toFixed(6)} adx=${indicators.adx?.toFixed(1)} mtfBull=${indicators.mtfBullish} mtfBear=${indicators.mtfBearish} vol=${indicators.currentVolume?.toFixed(0)} volSMA=${indicators.volumeSMA?.toFixed(0)}`
        );

        botState.lastPrices[symbol] = indicators.currentPrice;
        await evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance, cycleId);
      } catch (symbolError) {
        console.error(`[CYCLE ${cycleId}] Greška na ${symbol}:`, symbolError.message);
      }

      await sleep(300);
    }
  } catch (error) {
    console.error(`[CYCLE ${cycleId}] Greška u glavnoj petlji:`, error.message);
  } finally {
    const durationMs = Date.now() - startedAt;
    console.log(`[CYCLE ${cycleId}] ■ Kraj ciklusa (${durationMs} ms)`);
    isCycleRunning = false;
    botState.isCycleRunning = false;
    botState.lastCycleEndedAt = new Date().toISOString();
  }
}

async function startBot() {
  startServer(exchange);

  setInterval(() => {
    console.log(`[HEARTBEAT] ${new Date().toISOString()} Bot proces aktivan.`);
  }, 60000);

  try {
    console.log('⏳ Učitavam markete...');
    await exchange.loadMarkets();
    console.log('✅ Marketi učitani. Pokrećem trading petlju (15s).');

    await checkMarkets();
    setInterval(checkMarkets, 15000);

    setInterval(() => monitorTrailingStops(exchange, db), 30000);
  } catch (error) {
    console.error('Kritična greška:', error.message);
    process.exit(1);
  }
}

startBot();
