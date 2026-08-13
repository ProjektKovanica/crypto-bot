const express = require('express');
const path = require('path');
const { db } = require('./db');
const { forceClosePosition, closeAllPositions } = require('./strategies/position_manager');
const { TRADING_PAIRS } = require('./config');

const app = express();
const PORT = 5050;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// KRITIČNO #4: API je bio potpuno otvoren - bilo tko tko zna IP:port
// je mogao pozvati /api/kill-switch ili /api/close-position bez ikakve provjere.
// Postavi API_KEY u .env (npr. API_KEY=neki-dugačak-random-string)
// i šalji ga kao header 'x-api-key' iz dashboarda.
function requireApiKey(req, res, next) {
    if (!process.env.API_KEY) {
        console.warn('⚠️  UPOZORENJE: API_KEY nije postavljen u .env - API rute su NEZAŠTIĆENE!');
        return next();
    }
    const key = req.headers['x-api-key'];
    if (key !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Neautoriziran pristup' });
    }
    next();
}

app.use('/api', requireApiKey);

// API: Status bota
app.get('/api/status', (req, res) => {
    try {
        const botStatus = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
        res.json({ 
            status: botStatus && botStatus.value === 'true' ? 'RUNNING' : 'STOPPED',
            online: true
        });
    } catch (error) {
        res.status(500).json({ error: error.message, online: false });
    }
});

// API: Dohvat svih parova
app.get('/api/pairs', (req, res) => res.json(TRADING_PAIRS));

// API: Sve aktivne pozicije iz baze
app.get('/api/positions', (req, res) => {
    const data = db.prepare('SELECT * FROM active_positions').all();
    res.json(data);
});

// API: Pauza - zaustavi nove entryje, ali NE dira postojeće otvorene pozicije
app.post('/api/pause', (req, res) => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'BOT_ACTIVE');
    res.json({ success: true, message: 'Bot pauziran - postojeće pozicije ostaju otvorene.' });
});

// API: Nastavi - ponovo aktivira nove entryje
app.post('/api/resume', (req, res) => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('true', 'BOT_ACTIVE');
    res.json({ success: true, message: 'Bot aktiviran - novi entryji su dozvoljeni.' });
});

// API: Dohvat svih postavki
app.get('/api/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json(settings);
});

// API: Ažuriranje postavke
app.post('/api/settings', (req, res) => {
    const EDITABLE_KEYS = ['RISK_PERCENT', 'MAX_CONCURRENT_POSITIONS', 'MAX_LEVERAGE', 'LIQUIDATION_SAFETY_FACTOR', 'COOLDOWN_SECONDS'];
    const { key, value } = req.body;
    if (!key || !EDITABLE_KEYS.includes(key)) {
        return res.status(400).json({ error: `Nepoznata ili zaštićena ključ: ${key}` });
    }
    if (value == null || String(value).trim() === '') {
        return res.status(400).json({ error: 'Vrijednost ne smije biti prazna.' });
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value).trim(), key);
    res.json({ success: true, key, value: String(value).trim() });
});

// API: Pravi emergency stop - zaustavi bota I zatvori sve otvorene pozicije po marketu
app.post('/api/emergency-stop', async (req, res) => {
    if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'BOT_ACTIVE');
    const results = await closeAllPositions(global.exchange, db);
    res.json({ success: true, message: 'Bot zaustavljen, sve pozicije zatvorene.', results });
});

// Zadržano zbog kompatibilnosti unatrag - ponaša se kao /api/pause
app.post('/api/kill-switch', (req, res) => {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'BOT_ACTIVE');
    res.json({ success: true, message: 'Bot zaustavljen.' });
});

// API: Zatvaranje pozicije
app.post('/api/close-position', async (req, res) => {
    const { symbol } = req.body;
    if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
    const result = await forceClosePosition(global.exchange, db, symbol);
    res.json(result);
});

// API: Stanje računa (live sa Binancea)
app.get('/api/balance', async (req, res) => {
    try {
        if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
        const balance = await global.exchange.fetchBalance();

        // Robustna ekstrakcija — isti pristup kao u bot.js getUsdcAvailableBalance()
        let free = 0, used = 0, total = 0;
        try {
            const assets = balance?.info?.assets;
            if (Array.isArray(assets)) {
                const a = assets.find(x => String(x.asset).toUpperCase() === 'USDC')
                       || assets.find(x => String(x.asset).toUpperCase() === 'U');
                if (a) {
                    free  = parseFloat(a.availableBalance) || 0;
                    total = parseFloat(a.walletBalance)    || 0;
                    used  = Math.max(0, total - free);
                }
            }
        } catch (_) {}

        // Fallback: CCXT unified map
        if (!free && !total) {
            const u = balance?.USDC || {};
            free  = u.free  || 0;
            used  = u.used  || 0;
            total = u.total || 0;
        }

        res.json({ free, used, total });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: povijest zatvorenih trejdova
app.get('/api/trades', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const data = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
    res.json(data);
});

// API: Agregirana PnL statistika i equity krivulja
app.get('/api/stats', (req, res) => {
    const trades = db.prepare('SELECT * FROM trades ORDER BY timestamp ASC').all();

    const totalTrades = trades.length;
    const wins = trades.filter(t => t.realized_pnl > 0);
    const losses = trades.filter(t => t.realized_pnl <= 0);
    const totalPnl = trades.reduce((sum, t) => sum + (t.realized_pnl || 0), 0);
    const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.realized_pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.realized_pnl, 0) / losses.length : 0;

    let bestTrade = null;
    let worstTrade = null;
    for (const t of trades) {
        if (t.realized_pnl == null) continue;
        if (!bestTrade || t.realized_pnl > bestTrade.realized_pnl) bestTrade = t;
        if (!worstTrade || t.realized_pnl < worstTrade.realized_pnl) worstTrade = t;
    }

    // Kumulativna PnL kroz vrijeme za equity krivulju
    let cumulative = 0;
    const equityCurve = trades.map(t => {
        cumulative += (t.realized_pnl || 0);
        return { timestamp: t.timestamp, cumulative_pnl: Number(cumulative.toFixed(2)) };
    });

    // Raspodjela po paru
    const bySymbol = {};
    for (const t of trades) {
        if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, pnl: 0 };
        bySymbol[t.symbol].trades += 1;
        bySymbol[t.symbol].pnl += (t.realized_pnl || 0);
    }

    res.json({
        totalTrades,
        wins: wins.length,
        losses: losses.length,
        winRate: Number(winRate.toFixed(1)),
        totalPnl: Number(totalPnl.toFixed(2)),
        avgWin: Number(avgWin.toFixed(2)),
        avgLoss: Number(avgLoss.toFixed(2)),
        bestTrade,
        worstTrade,
        equityCurve,
        bySymbol
    });
});

function startServer(exchange) {
    global.exchange = exchange;
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Dashboard online: http://localhost:${PORT}`));
}

module.exports = { startServer };
