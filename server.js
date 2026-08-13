const express = require('express');
const path = require('path');
const { db } = require('./db');
const { forceClosePosition } = require('./strategies/position_manager');

let exchangeInstance = null;
const app = express();
const PORT = 5050;

app.use(express.json());

// Posluživanje frontend datoteka iz 'public' foldera
app.use(express.static(path.join(__dirname, 'public')));

// 1. Endpoint: Status bota
app.get('/api/status', (req, res) => {
    const isBotActive = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
    res.json({ status: isBotActive.value === 'true' ? 'RUNNING' : 'STOPPED' });
});

// 2. Endpoint: Aktivne pozicije
app.get('/api/positions', (req, res) => {
    const positions = db.prepare('SELECT * FROM active_positions').all();
    res.json(positions);
});

// 3. Endpoint: Povijest tradeova
app.get('/api/trades', (req, res) => {
    const trades = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT 20').all();
    res.json(trades);
});

// 4. Endpoint: Kill Switch
app.post('/api/kill-switch', (req, res) => {
    const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    update.run('false', 'BOT_ACTIVE');
    console.log('🛑 KILL SWITCH AKTIVIRAN!');
    res.json({ success: true });
});

// 5. Endpoint: Ručno zatvaranje
app.post('/api/close-position', async (req, res) => {
    const { symbol } = req.body;
    if (!exchangeInstance) return res.status(500).json({ error: 'Exchange nije inicijaliziran.' });
    
    const result = await forceClosePosition(exchangeInstance, db, symbol);
    if (result.success) res.json({ success: true });
    else res.status(500).json({ error: result.error });
});

function startServer(exchange) {
    exchangeInstance = exchange; 
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Web Dashboard dostupan na portu ${PORT}`);
    });
}

module.exports = { startServer };
