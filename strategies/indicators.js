const { RSI, EMA, MACD, ATR, ADX, SMA } = require('technicalindicators');

// Izračun indikatora za jedan timeframe
function calcIndicators(ohlcv) {
    const closes  = ohlcv.map(c => c[4]);
    const highs   = ohlcv.map(c => c[2]);
    const lows    = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);

    const rsiResult  = RSI.calculate({ values: closes, period: 14 });
    const emaResult  = EMA.calculate({ values: closes, period: 50 });
    const macdResult = MACD.calculate({
        values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false
    });
    const atrResult  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const adxResult  = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const volSMA     = SMA.calculate({ values: volumes, period: 20 });

    return {
        currentPrice: closes[closes.length - 1],
        rsi:          rsiResult[rsiResult.length - 1],
        rsiPrev:      rsiResult[rsiResult.length - 2] ?? null,
        ema:          emaResult[emaResult.length - 1],
        macd:         macdResult[macdResult.length - 1],
        atr:          atrResult[atrResult.length - 1] ?? null,
        adx:          adxResult[adxResult.length - 1]?.adx ?? null,
        currentVolume: volumes[volumes.length - 1],
        volumeSMA:    volSMA[volSMA.length - 1] ?? null
    };
}

async function getIndicators(exchange, symbol, timeframe = '15m', limit = 100) {
    try {
        // Fetch 15m, 1h i 4h paralelno radi potvrde trenda
        const [ohlcv15m, ohlcv1h, ohlcv4h] = await Promise.all([
            exchange.fetchOHLCV(symbol, timeframe, undefined, limit),
            exchange.fetchOHLCV(symbol, '1h', undefined, 60),
            exchange.fetchOHLCV(symbol, '4h', undefined, 60)
        ]);

        const base = calcIndicators(ohlcv15m);

        // Viši timeframeovi — samo cijena i EMA za MTF trend potvrdu
        const ema1h = EMA.calculate({ values: ohlcv1h.map(c => c[4]), period: 50 });
        const ema4h = EMA.calculate({ values: ohlcv4h.map(c => c[4]), period: 50 });

        const price1h = ohlcv1h[ohlcv1h.length - 1][4];
        const price4h = ohlcv4h[ohlcv4h.length - 1][4];

        return {
            ...base,
            // MTF trend potvrda: da li je cijena iznad/ispod EMA na višim TF
            mtfBullish: price1h > ema1h[ema1h.length - 1] && price4h > ema4h[ema4h.length - 1],
            mtfBearish: price1h < ema1h[ema1h.length - 1] && price4h < ema4h[ema4h.length - 1]
        };
    } catch (error) {
        console.error(`Greška indikatora za ${symbol}:`, error.message);
        return null;
    }
}

module.exports = { getIndicators };
