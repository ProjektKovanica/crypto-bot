const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'trading.db'));

function initDB() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            market_type TEXT,
            side TEXT,
            price REAL,
            amount REAL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            realized_pnl REAL
        );

        CREATE TABLE IF NOT EXISTS active_positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            entry_price REAL,
            size REAL,
            side TEXT,
            stop_loss REAL,
            take_profit REAL,
            open_time DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS symbol_cooldown (
            symbol TEXT PRIMARY KEY,
            last_trade_ts INTEGER NOT NULL
        );
    `);

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('RISK_PERCENT', '2.0');
    insertSetting.run('BOT_ACTIVE', 'true');
    insertSetting.run('MAX_CONCURRENT_POSITIONS', '3');
    insertSetting.run('MAX_LEVERAGE', '10');
    insertSetting.run('LIQUIDATION_SAFETY_FACTOR', '0.5');
    insertSetting.run('COOLDOWN_SECONDS', '300');
    // Phase 3 nove postavke
    insertSetting.run('TRADING_HOURS', '06:00-20:00');     // UTC blackout filter
    insertSetting.run('MAX_DAILY_LOSS_PERCENT', '5.0');    // daily drawdown circuit breaker

    console.log('✅ Baza podataka je spremna.');

    // Migracije: dodaj stupce ako ne postoje
    const cols = db.pragma('table_info(active_positions)').map(c => c.name);
    if (!cols.includes('open_time')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN open_time DATETIME DEFAULT CURRENT_TIMESTAMP");
        console.log('✅ Migracija: dodan stupac open_time u active_positions.');
    }
    if (!cols.includes('unrealized_pnl')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN unrealized_pnl REAL");
        console.log('✅ Migracija: dodan stupac unrealized_pnl u active_positions.');
    }
    if (!cols.includes('highest_price')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN highest_price REAL");
        console.log('✅ Migracija: dodan stupac highest_price u active_positions.');
    }
    if (!cols.includes('lowest_price')) {
        db.exec("ALTER TABLE active_positions ADD COLUMN lowest_price REAL");
        console.log('✅ Migracija: dodan stupac lowest_price u active_positions.');
    }
}

// ── Daily drawdown circuit breaker ──────────────────────────────────────────
// Vraća true ako je današnji realized PnL gubitak veći od MAX_DAILY_LOSS_PERCENT posto balansa.
function isDailyDrawdownBreached(db, balance) {
    try {
        const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get('MAX_DAILY_LOSS_PERCENT');
        const maxLossPct = setting ? parseFloat(setting.value) : 5.0;
        const maxLossAmt = balance * (maxLossPct / 100);

        // Svi trejdovi zatvoreni danas (UTC dan)
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const trades = db.prepare(
            "SELECT realized_pnl FROM trades WHERE timestamp >= ? AND realized_pnl IS NOT NULL"
        ).all(todayStart.toISOString());

        const dailyPnl = trades.reduce((s, t) => s + t.realized_pnl, 0);
        if (dailyPnl < -maxLossAmt) {
            console.warn(`[DRAWDOWN] Dnevni gubitak $${Math.abs(dailyPnl).toFixed(2)} premašio limit $${maxLossAmt.toFixed(2)} (${maxLossPct}% od $${balance.toFixed(2)})`);
            return true;
        }
        return false;
    } catch (_) {
        return false;
    }
}

initDB();

module.exports = { db, isDailyDrawdownBreached };
