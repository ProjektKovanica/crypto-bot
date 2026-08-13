/**
 * backtest.js — Simulacija strategije na historijskim podacima
 *
 * Korištenje:
 *   node backtest.js [symbol] [timeframe] [limit] [startBalance]
 *
 * Primjer:
 *   node backtest.js BTC/USDC 15m 2000 1000
 *
 * Opcije (ENV):
 *   BINANCE_API_KEY, BINANCE_SECRET — opciono (javni endpoint ne zahtijeva auth)
 */

require('dotenv').config();
const ccxt = require('ccxt');
const { RSI, EMA, MACD, ATR, ADX, SMA } = require('technicalindicators');

const SYMBOL        = process.argv[2] || 'BTC/USDC';
const TIMEFRAME     = process.argv[3] || '15m';
const LIMIT         = parseInt(process.argv[4]) || 1000;
const START_BALANCE = parseFloat(process.argv[5]) || 1000;

// ── Postavke strategije (iste kao u botu) ─────────────────────────────────
const RISK_PERCENT         = 2.0;       // % balansa po trejdu
const MAX_LEVERAGE         = 10;
const LIQUIDATION_SAFETY   = 0.5;
const SL_ATR_MULT          = 1.5;
const TP_ATR_MULT          = 3.0;
const RSI_OVERSOLD         = 40;
const RSI_OVERBOUGHT       = 60;
const ADX_MIN              = 25;
const MAKER_FEE            = 0.0002;    // 0.02% taker fee po strani
const FUNDING_INTERVAL_8H  = 0.0001;   // simulirani funding 0.01% / 8h

async function run() {
    const exchange = new ccxt.binance({
        apiKey: process.env.BINANCE_API_KEY || '',
        secret: process.env.BINANCE_SECRET || '',
        enableRateLimit: true,
        options: { defaultType: 'future' }
    });

    console.log(`\n⏳ Dohvat ${LIMIT} ${TIMEFRAME} svijeća za ${SYMBOL}...`);
    let ohlcv;
    try {
        await exchange.loadMarkets();
        ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, LIMIT);
    } catch (err) {
        console.error('❌ Greška pri dohvatu podataka:', err.message);
        process.exit(1);
    }

    console.log(`✅ Dohvaćeno ${ohlcv.length} svijeća. Pokrećem backtest...\n`);

    const closes  = ohlcv.map(c => c[4]);
    const highs   = ohlcv.map(c => c[2]);
    const lows    = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);
    const times   = ohlcv.map(c => c[0]);

    // Izračunaj sve indikatore odjednom
    const rsiArr  = RSI.calculate({ values: closes, period: 14 });
    const emaArr  = EMA.calculate({ values: closes, period: 50 });
    const macdArr = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
    const atrArr  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const adxArr  = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const volSMA  = SMA.calculate({ values: volumes, period: 20 });

    // Poravnaj nizove na isti offset (najduži lag je ADX/MACD ~34 svijeća)
    const offset = ohlcv.length - Math.min(rsiArr.length, emaArr.length, macdArr.length, atrArr.length, adxArr.length, volSMA.length);

    let balance    = START_BALANCE;
    let position   = null;   // { side, entry, sl, tp, size, leverage, highestPrice, lowestPrice }
    let trades     = [];
    let maxBalance = START_BALANCE;
    let maxDrawdown = 0;

    for (let i = 0; i < Math.min(rsiArr.length, emaArr.length, macdArr.length, atrArr.length, adxArr.length, volSMA.length); i++) {
        const globalIdx = i + offset;
        const price   = closes[globalIdx];
        const rsi     = rsiArr[i];
        const rsiPrev = i > 0 ? rsiArr[i - 1] : null;
        const ema     = emaArr[i];
        const macd    = macdArr[i];
        const atr     = atrArr[i];
        const adx     = adxArr[i]?.adx;
        const vol     = volumes[globalIdx];
        const vSMA    = volSMA[i];
        const ts      = new Date(times[globalIdx]).toISOString();

        // ── Upravljanje otvorenom pozicijom ──────────────────────────────────
        if (position) {
            // Simulirani funding (svaka 8h ~ 3 perioda od 15m... zaokruženo: svaka 32 candle)
            if (i % 32 === 0) {
                const fundingCost = position.size * price * FUNDING_INTERVAL_8H;
                balance -= fundingCost;
            }

            // Trailing stop: aktivira se kad >= 1.5% u profitu
            const unrealPct = position.side === 'buy'
                ? (price - position.entry) / position.entry
                : (position.entry - price) / position.entry;

            if (unrealPct >= 0.015) {
                if (position.side === 'buy') {
                    position.highestPrice = Math.max(price, position.highestPrice ?? position.entry);
                    const trailSL = position.highestPrice - atr;
                    if (trailSL > position.sl) position.sl = trailSL;
                } else {
                    position.lowestPrice = Math.min(price, position.lowestPrice ?? position.entry);
                    const trailSL = position.lowestPrice + atr;
                    if (trailSL < position.sl) position.sl = trailSL;
                }
            }

            // SL/TP provjera
            let closed = false;
            let exitPrice = price;
            let exitReason = '';

            if (position.side === 'buy') {
                if (price <= position.sl) { exitPrice = position.sl; exitReason = 'SL'; closed = true; }
                else if (price >= position.tp) { exitPrice = position.tp; exitReason = 'TP'; closed = true; }
            } else {
                if (price >= position.sl) { exitPrice = position.sl; exitReason = 'SL'; closed = true; }
                else if (price <= position.tp) { exitPrice = position.tp; exitReason = 'TP'; closed = true; }
            }

            if (closed) {
                const rawPnl = position.side === 'buy'
                    ? (exitPrice - position.entry) * position.size
                    : (position.entry - exitPrice) * position.size;
                const fees = position.size * exitPrice * MAKER_FEE * 2; // entry + exit
                const netPnl = rawPnl - fees;
                balance += netPnl;
                maxBalance = Math.max(maxBalance, balance);
                const dd = (maxBalance - balance) / maxBalance * 100;
                if (dd > maxDrawdown) maxDrawdown = dd;

                trades.push({
                    ts, symbol: SYMBOL, side: position.side,
                    entry: position.entry, exit: exitPrice,
                    pnl: netPnl, reason: exitReason, balance
                });
                position = null;
            }
        }

        // ── Entry uvjeti (samo ako nema otvorene pozicije) ──────────────────
        if (position) continue;
        if (adx == null || adx < ADX_MIN) continue;       // ADX filter
        if (vSMA != null && vol < vSMA) continue;          // Volume filter

        const isUptrend   = price > ema;
        const isDowntrend = price < ema;
        const isOversold  = rsi < RSI_OVERSOLD;
        const isOverbought = rsi > RSI_OVERBOUGHT;
        const bullMom     = macd?.histogram > 0;
        const bearMom     = macd?.histogram < 0;
        const rsiRising   = rsiPrev != null && rsi > rsiPrev;
        const rsiFalling  = rsiPrev != null && rsi < rsiPrev;

        const slDist  = atr * SL_ATR_MULT;
        const tpDist  = atr * TP_ATR_MULT;
        const slPct   = slDist / price;
        const rawLev  = Math.floor(LIQUIDATION_SAFETY / slPct);
        const leverage = Math.min(MAX_LEVERAGE, Math.max(1, rawLev));

        const maxLoss = balance * (RISK_PERCENT / 100);

        if (isUptrend && isOversold && bullMom && rsiRising) {
            const sl   = price - slDist;
            const tp   = price + tpDist;
            const size = maxLoss / slDist;
            const entryFees = size * price * MAKER_FEE;
            balance -= entryFees;
            position = { side: 'buy', entry: price, sl, tp, size, leverage };
        } else if (isDowntrend && isOverbought && bearMom && rsiFalling) {
            const sl   = price + slDist;
            const tp   = price - tpDist;
            const size = maxLoss / slDist;
            const entryFees = size * price * MAKER_FEE;
            balance -= entryFees;
            position = { side: 'sell', entry: price, sl, tp, size, leverage };
        }
    }

    // ── Rezultati ──────────────────────────────────────────────────────────
    const wins   = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate   = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 0;
    const avgWin    = wins.length > 0 ? (wins.reduce((s,t) => s+t.pnl,0) / wins.length).toFixed(2) : 0;
    const avgLoss   = losses.length > 0 ? (losses.reduce((s,t) => s+t.pnl,0) / losses.length).toFixed(2) : 0;
    const profitFactor = losses.length > 0 && Math.abs(losses.reduce((s,t) => s+t.pnl,0)) > 0
        ? (wins.reduce((s,t) => s+t.pnl,0) / Math.abs(losses.reduce((s,t) => s+t.pnl,0))).toFixed(2)
        : '∞';

    console.log('═══════════════════════════════════════════════');
    console.log(`  BACKTEST: ${SYMBOL} | ${TIMEFRAME} | ${LIMIT} svijeća`);
    console.log('═══════════════════════════════════════════════');
    console.log(`  Početni balans:    $${START_BALANCE.toFixed(2)}`);
    console.log(`  Završni balans:    $${balance.toFixed(2)}`);
    console.log(`  Ukupni PnL:        ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${((totalPnl/START_BALANCE)*100).toFixed(1)}%)`);
    console.log(`  Maks. drawdown:    ${maxDrawdown.toFixed(1)}%`);
    console.log('───────────────────────────────────────────────');
    console.log(`  Ukupno trejdova:   ${trades.length}`);
    console.log(`  Pobjednih (W):     ${wins.length}`);
    console.log(`  Gubitnih  (L):     ${losses.length}`);
    console.log(`  Win rate:          ${winRate}%`);
    console.log(`  Avg win:           +$${avgWin}`);
    console.log(`  Avg loss:          $${avgLoss}`);
    console.log(`  Profit factor:     ${profitFactor}`);
    console.log('═══════════════════════════════════════════════\n');

    if (trades.length > 0) {
        console.log('Zadnjih 10 trejdova:');
        trades.slice(-10).forEach(t => {
            const icon = t.pnl >= 0 ? '✅' : '❌';
            console.log(`  ${icon} ${t.ts.slice(0,16)} ${t.side.toUpperCase()} entry=$${t.entry.toFixed(2)} exit=$${t.exit.toFixed(2)} pnl=${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} [${t.reason}] bal=$${t.balance.toFixed(2)}`);
        });
    } else {
        console.log('Nema trejdova u odabranom periodu.');
    }
}

run().catch(err => {
    console.error('Greška:', err.message);
    process.exit(1);
});
