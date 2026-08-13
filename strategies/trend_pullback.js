const { sendTelegramMessage } = require('../notifier');

async function evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance) {
    // KRITIČNO #2: ne otvaraj novu poziciju ako već postoji aktivna za ovaj par.
    // Bez ovoga je moguć dupli entry ako se uvjeti opet poklope prije nego
    // se DB/burza stignu sinkronizirati.
    const existingPosition = db.prepare('SELECT id FROM active_positions WHERE symbol = ?').get(symbol);
    if (existingPosition) return;

    // Bonus: hard cap na broj istovremeno otvorenih pozicija (settings.MAX_CONCURRENT_POSITIONS)
    const maxPosSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('MAX_CONCURRENT_POSITIONS');
    const maxConcurrent = maxPosSetting ? parseInt(maxPosSetting.value, 10) : 3;
    const openCount = db.prepare('SELECT COUNT(*) as c FROM active_positions').get().c;
    if (openCount >= maxConcurrent) return;

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

    const maxLevSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('MAX_LEVERAGE');
    const safetySetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('LIQUIDATION_SAFETY_FACTOR');
    const maxLeverage = maxLevSetting ? parseInt(maxLevSetting.value, 10) : 10;
    const safetyFactor = safetySetting ? parseFloat(safetySetting.value) : 0.5;

    // Dinamički leverage: teoretski maksimalni leverage prije nego likvidacija
    // "sustigne" stop-loss je otprilike 1/slPercent (npr. 3% SL -> ~33x).
    // Množimo sa safetyFactor da ostavimo buffer (fees, funding, slippage, fitilj),
    // i cappamo na MAX_LEVERAGE kao tvrdu granicu.
    const rawLeverage = Math.floor(safetyFactor / slPercent);
    const leverage = Math.min(maxLeverage, Math.max(1, rawLeverage));

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
            try {
                await exchange.setLeverage(leverage, symbol);
            } catch (levErr) {
                console.warn(`⚠️  Leverage već postavljen ili nije podržan za ${symbol}:`, levErr.message);
            }

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
        const slPrice = currentPrice * (1 + slPercent);
        const tpPrice = currentPrice * (1 - (slPercent * 2));
        const lossPerCoin = slPrice - currentPrice;
        let positionSize = maxLossAmount / lossPerCoin;

        positionSize = Number(exchange.amountToPrecision(symbol, positionSize));
        const formattedSL = Number(exchange.priceToPrecision(symbol, slPrice));
        const formattedTP = Number(exchange.priceToPrecision(symbol, tpPrice));

        if (positionSize * currentPrice < 10) return;

        try {
            try {
                await exchange.setLeverage(leverage, symbol);
            } catch (levErr) {
                console.warn(`⚠️  Leverage već postavljen ili nije podržan za ${symbol}:`, levErr.message);
            }

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
