const { RSI, EMA, MACD, ATR } = require('technicalindicators');

async function getIndicators(exchange, symbol, timeframe = '15m', limit = 100) {
    try {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        const closes = ohlcv.map(candle => candle[4]);
        const highs  = ohlcv.map(candle => candle[2]);
        const lows   = ohlcv.map(candle => candle[3]);

        const rsiResult  = RSI.calculate({ values: closes, period: 14 });
        const emaResult  = EMA.calculate({ values: closes, period: 50 });
        const macdResult = MACD.calculate({
            values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
            SimpleMAOscillator: false, SimpleMASignal: false
        });
        const atrResult  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });

        return {
            currentPrice: closes[closes.length - 1],
            rsi: rsiResult[rsiResult.length - 1],
            rsiPrev: rsiResult[rsiResult.length - 2] ?? null,
            ema: emaResult[emaResult.length - 1],
            macd: macdResult[macdResult.length - 1],
            atr: atrResult[atrResult.length - 1] ?? null
        };
    } catch (error) {
        console.error(`Greška indikatora za ${symbol}:`, error.message);
        return null;
    }
}

module.exports = { getIndicators };
