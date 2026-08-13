const { sendTelegramMessage } = require('../notifier');

async function evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance) {
    const { currentPrice, rsi, ema, macd } = indicators;
    
    // Uvjeti za LONG
    const isUptrend = currentPrice > ema;
    const isOversold = rsi < 40; 
    const isBullishMomentum = macd.histogram > 0;

    // Uvjeti za SHORT
    const isDowntrend = currentPrice < ema;
    const isOverbought = rsi > 60;
    const isBearishMomentum = macd.histogram < 0;

    const riskSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('RISK_PERCENT');
    const riskPercent = parseFloat(riskSetting.value) / 100;
    const maxLossAmount = usdcBalance * riskPercent; 
    const slPercent = 0.03; 

    // --- LOGIKA ZA LONG ---
    if (isUptrend && isOversold && isBullishMomentum) {
        const slPrice = currentPrice * (1 - slPercent);
        const tpPrice = currentPrice * (1 + (slPercent * 2));
        const lossPerCoin = currentPrice - slPrice;
        let positionSize = maxLossAmount / lossPerCoin;

        positionSize = Number(exchange.amountToPrecision(symbol, positionSize));
        const formattedSL = Number(exchange.priceToPrecision(symbol, slPrice));
        const formattedTP = Number(exchange.priceToPrecision(symbol, tpPrice));

        if (positionSize * currentPrice < 10) return;

        try {
            const params = { stopLossPrice: formattedSL, takeProfitPrice: formattedTP };
            await exchange.createMarketOrder(symbol, 'buy', positionSize, undefined, params);
            
            const insertTrade = db.prepare(`
                INSERT INTO active_positions (symbol, entry_price, size, side, stop_loss, take_profit)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            insertTrade.run(symbol, currentPrice, positionSize, 'buy', formattedSL, formattedTP);

            const msg = `🟢 <b>NOVI LONG TRADE</b>\n\n<b>Par:</b> ${symbol}\n<b>Ulaz:</b> $${currentPrice}\n<b>SL:</b> $${formattedSL}\n<b>TP:</b> $${formattedTP}\n<b>Veličina:</b> ${positionSize}`;
            await sendTelegramMessage(msg);
        } catch (error) {
            console.error(`❌ Greška pri otvaranju LONG za ${symbol}:`, error.message);
        }
    }

    // --- LOGIKA ZA SHORT ---
    else if (isDowntrend && isOverbought && isBearishMomentum) {
        const slPrice = currentPrice * (1 + slPercent); // Za short je SL iznad cijene
        const tpPrice = currentPrice * (1 - (slPercent * 2)); // TP je ispod cijene
        const lossPerCoin = slPrice - currentPrice;
        let positionSize = maxLossAmount / lossPerCoin;

        positionSize = Number(exchange.amountToPrecision(symbol, positionSize));
        const formattedSL = Number(exchange.priceToPrecision(symbol, slPrice));
        const formattedTP = Number(exchange.priceToPrecision(symbol, tpPrice));

        if (positionSize * currentPrice < 10) return;

        try {
            const params = { stopLossPrice: formattedSL, takeProfitPrice: formattedTP };
            await exchange.createMarketOrder(symbol, 'sell', positionSize, undefined, params);
            
            const insertTrade = db.prepare(`
                INSERT INTO active_positions (symbol, entry_price, size, side, stop_loss, take_profit)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            insertTrade.run(symbol, currentPrice, positionSize, 'sell', formattedSL, formattedTP);

            const msg = `🔴 <b>NOVI SHORT TRADE</b>\n\n<b>Par:</b> ${symbol}\n<b>Ulaz:</b> $${currentPrice}\n<b>SL:</b> $${formattedSL}\n<b>TP:</b> $${formattedTP}\n<b>Veličina:</b> ${positionSize}`;
            await sendTelegramMessage(msg);
        } catch (error) {
            console.error(`❌ Greška pri otvaranju SHORT za ${symbol}:`, error.message);
        }
    }
}

module.exports = { evaluateAndTrade };
