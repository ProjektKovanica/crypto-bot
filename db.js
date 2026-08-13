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
            take_profit REAL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
    `);
    
    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('RISK_PERCENT', '2.0');
    insertSetting.run('BOT_ACTIVE', 'true');
    
    console.log('✅ Baza podataka je spremna.');
}

initDB();

module.exports = { db };
