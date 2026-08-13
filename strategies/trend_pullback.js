const { sendTelegramMessage, tradeKeyboard } = require('../notifier');

// ── Kelly Criterion (half-Kelly) ────────────────────────────────────────────
// Vraća udio portfelja za uložiti na temelju prošlih trejdova za dani simbol.
// Koristi settings.RISK_PERCENT kao fallback (minimalni/maksimalni cap).
function calcKellyRiskPercent(db, symbol, defaultRiskPercent) {
    try {
        const trades = db.prepare(
            "SELECT realized_pnl FROM trades WHERE symbol = ? ORDER BY timestamp DESC LIMIT 100"
        ).all(symbol);

        if (trades.length < 10) return defaultRiskPercent; // nema dovoljno podataka

        const wins   = trades.filter(t => t.realized_pnl > 0);
        const losses = trades.filter(t => t.realized_pnl <= 0);
        if (wins.length === 0 || losses.length === 0) return defaultRiskPercent;

        const winRate  = wins.length / trades.length;
        const lossRate = 1 - winRate;
        const avgWin   = wins.reduce((s, t) => s + t.realized_pnl, 0) / wins.length;
        const avgLoss  = Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0) / losses.length);
        if (avgLoss === 0) return defaultRiskPercent;

        const R = avgWin / avgLoss;
        const kelly = (winRate * R - lossRate) / R;
        const halfKelly = kelly / 2; // pola-Kelly radi sigurnosti

        // Cap: između 0.5× i 2× defaultnog rizika
        const minRisk = defaultRiskPercent * 0.5;
        const maxRisk = defaultRiskPercent * 2;
        return Math.min(maxRisk, Math.max(minRisk, halfKelly * 100));
    } catch (_) {
        return defaultRiskPercent;
    }
}

// ── Provjera funding rate-a ──────────────────────────────────────────────────
// Vraća true ako je funding rate nepovoljan za danu stranu.
// LONG: funding > +0.05% skupo je (plaćaš) → preskoči
// SHORT: funding < -0.05% skupo je (plaćaš) → preskoči
async function isFundingRateUnfavorable(exchange, symbol, side) {
    try {
        // CCXT: fetchFundingRate(symbol) → { fundingRate }
        const fr = await exchange.fetchFundingRate(symbol);
        const rate = fr?.fundingRate;
        if (rate == null || isNaN(rate)) return false;
        if (side === 'buy'  && rate >  0.0005) return true;  // > +0.05%
        if (side === 'sell' && rate < -0.0005) return true;  // < -0.05%
        return false;
    } catch (_) {
        return false; // ne blokiraj trejd ako API greška
    }
}

// ── Provjera blackout sati ───────────────────────────────────────────────────
// TRADING_HOURS format: "HH:MM-HH:MM" UTC (npr. "06:00-20:00")
function isWithinTradingHours(hoursStr) {
    if (!hoursStr || hoursStr === 'disabled') return true;
    try {
        const [startStr, endStr] = hoursStr.split('-');
        const now = new Date();
        const [sh, sm] = startStr.split(':').map(Number);
        const [eh, em] = endStr.split(':').map(Number);
        const nowMins  = now.getUTCHours() * 60 + now.getUTCMinutes();
        const startMins = sh * 60 + sm;
        const endMins   = eh * 60 + em;
        if (startMins <= endMins) {
            return nowMins >= startMins && nowMins < endMins;
        }
        // Prelaz ponoći
        return nowMins >= startMins || nowMins < endMins;
    } catch (_) {
        return true;
    }
}

async function evaluateAndTrade(exchange, db, symbol, indicators, usdcBalance, cycleId) {
    const tag = cycleId ? `[CYCLE ${cycleId}]` : '[TRADE]';

    // Dupli entry guard (sekundarna provjera, primarno je u bot.js)
    const existingPosition = db.prepare('SELECT id FROM active_positions WHERE symbol = ?').get(symbol);
    if (existingPosition) {
        console.log(`${tag} ${symbol} SKIP: aktivna pozicija već postoji (id=${existingPosition.id})`);
        return;
    }

    // Cap na broj pozicija
    const maxPosSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('MAX_CONCURRENT_POSITIONS');
    const maxConcurrent = maxPosSetting ? parseInt(maxPosSetting.value, 10) : 3;
    const openCount = db.prepare('SELECT COUNT(*) as c FROM active_positions').get().c;
    if (openCount >= maxConcurrent) {
        console.log(`${tag} ${symbol} SKIP: dostignut maks. broj pozicija (${openCount}/${maxConcurrent})`);
        return;
    }

    // ── Blackout sati ──────────────────────────────────────────────────────
    const hoursSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('TRADING_HOURS');
    const hoursStr = hoursSetting ? hoursSetting.value : 'disabled';
    if (!isWithinTradingHours(hoursStr)) {
        console.log(`${tag} ${symbol} SKIP: izvan trading sati (${hoursStr} UTC)`);
        return;
    }

    const { currentPrice, rsi, rsiPrev, ema, macd, atr, adx,
            currentVolume, volumeSMA, mtfBullish, mtfBearish } = indicators;

    // ── Soft filters (warn but don't block) ─────────────────────────────
    const adxThreshold = 25;
    const adxOk = adx == null || adx >= adxThreshold;
    if (!adxOk) {
        console.log(`${tag} ${symbol} ⚠️ ADX=${adx.toFixed(1)} < ${adxThreshold} (ranging market, ali nastavljam)`);
    }

    const volumeOk = volumeSMA == null || currentVolume == null || currentVolume >= volumeSMA;
    if (!volumeOk) {
        console.log(`${tag} ${symbol} ⚠️ volumen ispod SMA (${currentVolume?.toFixed(0)} < ${volumeSMA?.toFixed(0)}, ali nastavljam)`);
    }

    // ── Uvjeti za LONG ────────────────────────────────────────────────────
    const isUptrend          = currentPrice > ema;
    const isOversold         = rsi < 40;
    const isBullishMomentum  = macd.histogram > 0;
    const isRsiRising        = rsiPrev != null && rsi > rsiPrev;

    // ── Uvjeti za SHORT ───────────────────────────────────────────────────
    const isDowntrend        = currentPrice < ema;
    const isOverbought       = rsi > 60;
    const isBearishMomentum  = macd.histogram < 0;
    const isRsiFalling       = rsiPrev != null && rsi < rsiPrev;

    // Minimum core conditions needed (out of 4) to trigger entry
    const MIN_CORE_CONDITIONS = 3;

    // ── Postavke ──────────────────────────────────────────────────────────
    const riskSetting   = db.prepare('SELECT value FROM settings WHERE key = ?').get('RISK_PERCENT');
    const defaultRisk   = parseFloat(riskSetting.value);
    const kellyRisk     = calcKellyRiskPercent(db, symbol, defaultRisk);
    const riskPercent   = kellyRisk / 100;
    const maxLossAmount = usdcBalance * riskPercent;

    const maxLevSetting    = db.prepare('SELECT value FROM settings WHERE key = ?').get('MAX_LEVERAGE');
    const safetySetting    = db.prepare('SELECT value FROM settings WHERE key = ?').get('LIQUIDATION_SAFETY_FACTOR');
    const maxLeverage      = maxLevSetting ? parseInt(maxLevSetting.value, 10) : 10;
    const safetyFactor     = safetySetting ? parseFloat(safetySetting.value) : 0.5;

    // ── ATR-based SL/TP ───────────────────────────────────────────────────
    // SL = 1.5 × ATR | TP = 3 × ATR (2:1 R:R)
    // Fallback na 3% ako ATR nije dostupan
    const atrSlMult = 1.5;
    const atrTpMult = 3.0;
    const slDistance = atr != null ? atr * atrSlMult : currentPrice * 0.03;
    const tpDistance = atr != null ? atr * atrTpMult : currentPrice * 0.06;
    const slPercent  = slDistance / currentPrice; // za leverage izračun

    // Dinamički leverage baziran na ATR SL udaljenosti
    const rawLeverage = Math.floor(safetyFactor / slPercent);
    const leverage    = Math.min(maxLeverage, Math.max(1, rawLeverage));

    // ── LONG logika ───────────────────────────────────────────────────────
    const longCoreCount = [isUptrend, isOversold, isBullishMomentum, isRsiRising].filter(Boolean).length;
    if (longCoreCount >= MIN_CORE_CONDITIONS) {
        // MTF potvrda: soft filter (upozorenje, ne blokira)
        if (!mtfBullish) {
            console.log(`${tag} ${symbol} ⚠️ LONG: MTF potvrda nije zadovoljena (1h/4h downtrend), ali nastavljam`);
        }

        // Funding rate provjera
        if (await isFundingRateUnfavorable(exchange, symbol, 'buy')) {
            console.log(`${tag} ${symbol} SKIP LONG: funding rate nepovoljan za LONG`);
            return;
        }

        console.log(`${tag} ${symbol} SIGNAL LONG (${longCoreCount}/4 conditions) | uptrend=${isUptrend} oversold=${isOversold} bullMom=${isBullishMomentum} rsiRising=${isRsiRising} adx=${adx?.toFixed(1)} mtfBullish=${mtfBullish} kelly=${kellyRisk.toFixed(2)}% | price=${currentPrice} rsi=${rsi?.toFixed(2)} atr=${atr?.toFixed(4)}`);

        const slPrice = currentPrice - slDistance;
        const tpPrice = currentPrice + tpDistance;
        const lossPerCoin = currentPrice - slPrice;
        let positionSize = maxLossAmount / lossPerCoin;

        positionSize = Number(exchange.amountToPrecision(symbol, positionSize));
        const formattedSL = Number(exchange.priceToPrecision(symbol, slPrice));
        const formattedTP = Number(exchange.priceToPrecision(symbol, tpPrice));

        if (positionSize * currentPrice < 10) {
            console.log(`${tag} ${symbol} SKIP LONG: pozicija premala ($${(positionSize * currentPrice).toFixed(2)} < $10)`);
            return;
        }

        try {
            try { await exchange.setLeverage(leverage, symbol); } catch (levErr) {
                console.warn(`⚠️  Leverage greška za ${symbol}:`, levErr.message);
            }

            const params = { stopLossPrice: formattedSL, takeProfitPrice: formattedTP };
            await exchange.createMarketOrder(symbol, 'buy', positionSize, undefined, params);

            db.prepare(`INSERT INTO active_positions (symbol, entry_price, size, side, stop_loss, take_profit) VALUES (?, ?, ?, ?, ?, ?)`)
              .run(symbol, currentPrice, positionSize, 'buy', formattedSL, formattedTP);

            db.prepare('INSERT OR REPLACE INTO symbol_cooldown (symbol, last_trade_ts) VALUES (?, ?)').run(symbol, Date.now());

            console.log(`${tag} ${symbol} OPEN LONG | entry=$${currentPrice} sl=$${formattedSL} tp=$${formattedTP} size=${positionSize} lev=${leverage}x atr=${atr?.toFixed(4)}`);

            const msg = `🟢 <b>NOVI LONG TRADE</b>\n\n<b>Par:</b> ${symbol}\n<b>Ulaz:</b> $${currentPrice}\n<b>SL:</b> $${formattedSL} (1.5×ATR)\n<b>TP:</b> $${formattedTP} (3×ATR)\n<b>Veličina:</b> ${positionSize}\n<b>Leverage:</b> ${leverage}x\n<b>Kelly rizik:</b> ${kellyRisk.toFixed(2)}%`;
            await sendTelegramMessage(msg, tradeKeyboard(symbol));
        } catch (error) {
            console.error(`${tag} ${symbol} ❌ Greška pri otvaranju LONG:`, error.message);
        }
    }

    // ── SHORT logika ──────────────────────────────────────────────────────
    const shortCoreCount = [isDowntrend, isOverbought, isBearishMomentum, isRsiFalling].filter(Boolean).length;
    if (longCoreCount < MIN_CORE_CONDITIONS && shortCoreCount >= MIN_CORE_CONDITIONS) {
        // MTF potvrda: soft filter (upozorenje, ne blokira)
        if (!mtfBearish) {
            console.log(`${tag} ${symbol} ⚠️ SHORT: MTF potvrda nije zadovoljena (1h/4h uptrend), ali nastavljam`);
        }

        // Funding rate provjera
        if (await isFundingRateUnfavorable(exchange, symbol, 'sell')) {
            console.log(`${tag} ${symbol} SKIP SHORT: funding rate nepovoljan za SHORT`);
            return;
        }

        console.log(`${tag} ${symbol} SIGNAL SHORT (${shortCoreCount}/4 conditions) | downtrend=${isDowntrend} overbought=${isOverbought} bearMom=${isBearishMomentum} rsiFalling=${isRsiFalling} adx=${adx?.toFixed(1)} mtfBearish=${mtfBearish} kelly=${kellyRisk.toFixed(2)}% | price=${currentPrice} rsi=${rsi?.toFixed(2)} atr=${atr?.toFixed(4)}`);

        const slPrice = currentPrice + slDistance;
        const tpPrice = currentPrice - tpDistance;
        const lossPerCoin = slPrice - currentPrice;
        let positionSize = maxLossAmount / lossPerCoin;

        positionSize = Number(exchange.amountToPrecision(symbol, positionSize));
        const formattedSL = Number(exchange.priceToPrecision(symbol, slPrice));
        const formattedTP = Number(exchange.priceToPrecision(symbol, tpPrice));

        if (positionSize * currentPrice < 10) {
            console.log(`${tag} ${symbol} SKIP SHORT: pozicija premala ($${(positionSize * currentPrice).toFixed(2)} < $10)`);
            return;
        }

        try {
            try { await exchange.setLeverage(leverage, symbol); } catch (levErr) {
                console.warn(`⚠️  Leverage greška za ${symbol}:`, levErr.message);
            }

            const params = { stopLossPrice: formattedSL, takeProfitPrice: formattedTP };
            await exchange.createMarketOrder(symbol, 'sell', positionSize, undefined, params);

            db.prepare(`INSERT INTO active_positions (symbol, entry_price, size, side, stop_loss, take_profit) VALUES (?, ?, ?, ?, ?, ?)`)
              .run(symbol, currentPrice, positionSize, 'sell', formattedSL, formattedTP);

            db.prepare('INSERT OR REPLACE INTO symbol_cooldown (symbol, last_trade_ts) VALUES (?, ?)').run(symbol, Date.now());

            console.log(`${tag} ${symbol} OPEN SHORT | entry=$${currentPrice} sl=$${formattedSL} tp=$${formattedTP} size=${positionSize} lev=${leverage}x atr=${atr?.toFixed(4)}`);

            const msg = `🔴 <b>NOVI SHORT TRADE</b>\n\n<b>Par:</b> ${symbol}\n<b>Ulaz:</b> $${currentPrice}\n<b>SL:</b> $${formattedSL} (1.5×ATR)\n<b>TP:</b> $${formattedTP} (3×ATR)\n<b>Veličina:</b> ${positionSize}\n<b>Leverage:</b> ${leverage}x\n<b>Kelly rizik:</b> ${kellyRisk.toFixed(2)}%`;
            await sendTelegramMessage(msg, tradeKeyboard(symbol));
        } catch (error) {
            console.error(`${tag} ${symbol} ❌ Greška pri otvaranju SHORT:`, error.message);
        }
    }

    // ── Nema signala ──────────────────────────────────────────────────────
    if (longCoreCount < MIN_CORE_CONDITIONS && shortCoreCount < MIN_CORE_CONDITIONS) {
        console.log(
            `${tag} ${symbol} NO SIGNAL | uptrend=${isUptrend} oversold=${isOversold} bullMom=${isBullishMomentum} rsiRising=${isRsiRising}` +
            ` | downtrend=${isDowntrend} overbought=${isOverbought} bearMom=${isBearishMomentum} rsiFalling=${isRsiFalling}` +
            ` | adx=${adx?.toFixed(1)} mtfBull=${mtfBullish} mtfBear=${mtfBearish}` +
            ` | price=${currentPrice} rsi=${rsi?.toFixed(2)} rsiPrev=${rsiPrev?.toFixed(2) ?? 'n/a'} ema=${ema?.toFixed(4)} macdHist=${macd?.histogram?.toFixed(6)} atr=${atr?.toFixed(4)} vol=${currentVolume?.toFixed(0)} volSMA=${volumeSMA?.toFixed(0)}`
        );
    }
}

module.exports = { evaluateAndTrade };
