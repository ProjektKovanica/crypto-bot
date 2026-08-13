const { sendTelegramMessage } = require('../notifier');

async function syncPositions(exchange, db) {
    try {
        const dbPositions = db.prepare('SELECT * FROM active_positions').all();
        if (dbPositions.length === 0) return;

        const fetchPositions = await exchange.fetchPositions();
        const activeBinancePositions = fetchPositions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

        for (const pos of dbPositions) {
            const binancePos = activeBinancePositions.find(p => p.symbol === pos.symbol);

            if (!binancePos) {
                // Position is closed on Binance — record in trade history
                const ticker = await exchange.fetchTicker(pos.symbol);
                const exitPrice = ticker.last;

                // Use Binance-reported realized PnL if accessible via info, else compute from prices
                let pnl;
                try {
                    const income = await exchange.fetchIncome({ symbol: pos.symbol, incomeType: 'REALIZED_PNL', limit: 5 });
                    if (income && income.length > 0) {
                        pnl = income.reduce((sum, r) => sum + parseFloat(r.income || 0), 0);
                    }
                } catch (_) {}

                if (pnl == null) {
                    pnl = pos.side === 'buy'
                        ? (exitPrice - pos.entry_price) * pos.size
                        : (pos.entry_price - exitPrice) * pos.size;
                }

                db.prepare(`
                    INSERT INTO trades (symbol, market_type, side, price, amount, realized_pnl)
                    VALUES (?, 'future', ?, ?, ?, ?)
                `).run(pos.symbol, pos.side === 'buy' ? 'sell' : 'buy', exitPrice, pos.size, pnl);

                db.prepare('DELETE FROM active_positions WHERE id = ?').run(pos.id);

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

// Novo: pravi "zatvori sve" - koristi se za EMERGENCY_STOP na dashboardu,
// dok stari kill-switch samo gasi nove entryje ali ostavlja postojeći rizik otvoren.
async function closeAllPositions(exchange, db) {
    const positions = db.prepare('SELECT symbol FROM active_positions').all();
    const results = [];
    for (const pos of positions) {
        const result = await forceClosePosition(exchange, db, pos.symbol);
        results.push({ symbol: pos.symbol, ...result });
    }
    return results;
}

module.exports = { syncPositions, forceClosePosition, closeAllPositions };
