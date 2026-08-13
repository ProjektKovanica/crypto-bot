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

        CREATE TABLE IF NOT EXISTS symbol_cooldown (
            symbol TEXT PRIMARY KEY,
            last_trade_ts INTEGER NOT NULL
        );
    `);

    const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    insertSetting.run('RISK_PERCENT', '2.0');
    insertSetting.run('BOT_ACTIVE', 'true');
    // Bonus: hard cap na broj istovremeno otvorenih pozicija (koristi se u trend_pullback.js)
    insertSetting.run('MAX_CONCURRENT_POSITIONS', '3');
    // Dinamički leverage: bot sam računa leverage po trejdu na temelju
    // udaljenosti do stop-lossa, tako da likvidacija ostane sigurno iza SL-a.
    // MAX_LEVERAGE = tvrdi gornji strop (nikad ne ide iznad ovoga bez obzira na izračun).
    // LIQUIDATION_SAFETY_FACTOR = koliki dio teoretski max leveragea koristiti (0.5 = pola).
    insertSetting.run('MAX_LEVERAGE', '10');
    insertSetting.run('LIQUIDATION_SAFETY_FACTOR', '0.5');
    // Cooldown između dva uzastopna entry-ja za isti simbol (u sekundama).
    // Sprječava ponovni entry odmah nakon što se pozicija zatvori ili podmirila
    // po SL/TP-u dok se tržišni uvjeti nisu promijenili.
    insertSetting.run('COOLDOWN_SECONDS', '300');

    console.log('✅ Baza podataka je spremna.');
}

initDB();

module.exports = { db };
