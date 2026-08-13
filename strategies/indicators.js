const { RSI, EMA, MACD } = require('technicalindicators');

async function getIndicators(exchange, symbol, timeframe = '15m', limit = 100) {
    try {
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
        const closes = ohlcv.map(candle => candle[4]);

        const rsiResult = RSI.calculate({ values: closes, period: 14 });
        const emaResult = EMA.calculate({ values: closes, period: 50 });
        const macdResult = MACD.calculate({
            values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
            SimpleMAOscillator: false, SimpleMASignal: false
        });

        return {
            currentPrice: closes[closes.length - 1],
            rsi: rsiResult[rsiResult.length - 1],
            ema: emaResult[emaResult.length - 1],
            macd: macdResult[macdResult.length - 1]
        };
    } catch (error) {
        console.error(`Greška indikatora za ${symbol}:`, error.message);
        return null;
    }
}

module.exports = { getIndicators };
