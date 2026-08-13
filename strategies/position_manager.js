const { sendTelegramMessage } = require('../notifier');
const { ATR } = require('technicalindicators');

async function syncPositions(exchange, db) {
    try {
        const dbPositions = db.prepare('SELECT * FROM active_positions').all();
        if (dbPositions.length === 0) return;

        const fetchPositions = await exchange.fetchPositions();
        const activeBinancePositions = fetchPositions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

        for (const pos of dbPositions) {
            const isStillActive = activeBinancePositions.some(p => p.symbol === pos.symbol);

            if (!isStillActive) {
                const ticker = await exchange.fetchTicker(pos.symbol);
                const exitPrice = ticker.last;

                let pnl = pos.side === 'buy' ? (exitPrice - pos.entry_price) * pos.size : (pos.entry_price - exitPrice) * pos.size;

                const insertTrade = db.prepare(`
                    INSERT INTO trades (symbol, market_type, side, price, amount, realized_pnl)
                    VALUES (?, 'future', ?, ?, ?, ?)
                `);
                insertTrade.run(pos.symbol, pos.side === 'buy' ? 'sell' : 'buy', exitPrice, pos.size, pnl);

                const deletePos = db.prepare('DELETE FROM active_positions WHERE id = ?');
                deletePos.run(pos.id);

                const statusIcon = pnl >= 0 ? '✅' : '❌';
                const pnlText = pnl >= 0 ? `+ $${pnl.toFixed(2)}` : `- $${Math.abs(pnl).toFixed(2)}`;
                const msg = `${statusIcon} <b>POZICIJA ZATVORENA</b>\n\n<b>Par:</b> ${pos.symbol}\n<b>Izlaz:</b> $${exitPrice}\n<b>PnL:</b> <b>${pnlText}</b>`;
                await sendTelegramMessage(msg);
            }
        }
    } catch (error) {
        console.error('Greška pri sinkronizaciji pozicija:', error.message);
    }
}

// ── Trailing Stop monitor ────────────────────────────────────────────────────
// Pokreće se periodično iz bot.js (neovisno od entry ciklusa).
// Za svaku aktivnu poziciju:
//   1. Provjerava je li cijena prešla 1.5% u profitu → aktivira trailing
//   2. Pomiče SL na 1×ATR ispod/iznad najviše/najniže dosegnute cijene
//   3. Ako cijena padne ispod novog trailing SL → zatvara poziciju po marketu
async function monitorTrailingStops(exchange, db) {
    try {
        const positions = db.prepare('SELECT * FROM active_positions').all();
        if (positions.length === 0) return;

        for (const pos of positions) {
            try {
                const ticker = await exchange.fetchTicker(pos.symbol);
                const currentPrice = ticker.last;
                if (!currentPrice) continue;

                const unrealizedPct = pos.side === 'buy'
                    ? (currentPrice - pos.entry_price) / pos.entry_price
                    : (pos.entry_price - currentPrice) / pos.entry_price;

                // Ažuriraj unrealized_pnl i highest_price u bazi
                const unrealizedPnl = pos.side === 'buy'
                    ? (currentPrice - pos.entry_price) * pos.size
                    : (pos.entry_price - currentPrice) * pos.size;

                db.prepare('UPDATE active_positions SET unrealized_pnl = ? WHERE id = ?')
                  .run(unrealizedPnl, pos.id);

                // Trailing se aktivira tek kad je pozicija >= 1.5% u profitu
                if (unrealizedPct < 0.015) continue;

                // Ažuriraj highest/lowest seen price
                const newHigh = pos.side === 'buy'
                    ? Math.max(currentPrice, pos.highest_price ?? pos.entry_price)
                    : null;
                const newLow  = pos.side === 'sell'
                    ? Math.min(currentPrice, pos.lowest_price ?? pos.entry_price)
                    : null;

                if (pos.side === 'buy' && newHigh != null) {
                    db.prepare('UPDATE active_positions SET highest_price = ? WHERE id = ?').run(newHigh, pos.id);
                } else if (pos.side === 'sell' && newLow != null) {
                    db.prepare('UPDATE active_positions SET lowest_price = ? WHERE id = ?').run(newLow, pos.id);
                }

                // Fetch ATR za trailing SL korak (1×ATR)
                const ohlcv = await exchange.fetchOHLCV(pos.symbol, '15m', undefined, 20);
                const highs  = ohlcv.map(c => c[2]);
                const lows   = ohlcv.map(c => c[3]);
                const closes = ohlcv.map(c => c[4]);
                const atrRes  = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
                const atr     = atrRes[atrRes.length - 1];
                if (!atr) continue;

                const trailingSL = pos.side === 'buy'
                    ? (pos.highest_price ?? pos.entry_price) - atr
                    : (pos.lowest_price  ?? pos.entry_price) + atr;

                // Pomakni SL samo ako je novi SL bolji od starog
                const currentSL  = pos.stop_loss;
                const shouldMove = pos.side === 'buy'
                    ? trailingSL > currentSL
                    : trailingSL < currentSL;

                if (shouldMove) {
                    db.prepare('UPDATE active_positions SET stop_loss = ? WHERE id = ?').run(trailingSL, pos.id);
                    console.log(`[TRAILING] ${pos.symbol} SL pomaknut na $${trailingSL.toFixed(4)} (1×ATR=${atr.toFixed(4)})`);
                }

                // Ako je cijena probila trailing SL → zatvori poziciju po marketu
                const hitStop = pos.side === 'buy' ? currentPrice <= trailingSL : currentPrice >= trailingSL;
                if (hitStop) {
                    console.log(`[TRAILING] ${pos.symbol} cijena=$${currentPrice} probila trailing SL=$${trailingSL.toFixed(4)} → zatvaranje`);
                    await forceClosePosition(exchange, db, pos.symbol);
                }
            } catch (posErr) {
                console.error(`[TRAILING] Greška za ${pos.symbol}:`, posErr.message);
            }
        }
    } catch (error) {
        console.error('[TRAILING] Greška u trailing stop monitoru:', error.message);
    }
}

// ── Premjesti SL na breakeven ────────────────────────────────────────────────
async function moveSLToBreakeven(exchange, db, symbol) {
    try {
        const pos = db.prepare('SELECT * FROM active_positions WHERE symbol = ?').get(symbol);
        if (!pos) return { success: false, error: `Nema aktivne pozicije za ${symbol}` };

        // postavi SL na entry_price (breakeven)
        const bePrice = Number(exchange.priceToPrecision(symbol, pos.entry_price));
        db.prepare('UPDATE active_positions SET stop_loss = ? WHERE id = ?').run(bePrice, pos.id);

        console.log(`[SL→BE] ${symbol} SL pomaknut na breakeven $${bePrice}`);
        const msg = `🔒 <b>SL → Breakeven</b>\n\n<b>Par:</b> ${symbol}\n<b>Breakeven:</b> $${bePrice}`;
        await sendTelegramMessage(msg);
        return { success: true, breakeven: bePrice };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function forceClosePosition(exchange, db, symbol) {
    try {
        const pos = db.prepare('SELECT * FROM active_positions WHERE symbol = ?').get(symbol);
        if (!pos) throw new Error(`Nema aktivne pozicije za ${symbol}`);

        const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
        await exchange.createMarketOrder(symbol, closeSide, pos.size, undefined, { reduceOnly: true });

        await syncPositions(exchange, db);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function closeAllPositions(exchange, db) {
    const positions = db.prepare('SELECT symbol FROM active_positions').all();
    const results = [];
    for (const pos of positions) {
        const result = await forceClosePosition(exchange, db, pos.symbol);
        results.push({ symbol: pos.symbol, ...result });
    }
    return results;
}

module.exports = { syncPositions, forceClosePosition, closeAllPositions, monitorTrailingStops, moveSLToBreakeven };
