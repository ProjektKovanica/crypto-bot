const express = require('express');
const path = require('path');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { db } = require('./db');
const { TRADING_PAIRS } = require('./config');
const { forceClosePosition, closeAllPositions, moveSLToBreakeven } = require('./strategies/position_manager');

const app = express();
const PORT = 4000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Security ----------
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

const settingsRateLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const liveRateLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

app.use('/api', requireApiKey);

// ---------- Helpers ----------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || '';
const TG_SECRET_TOKEN = process.env.TELEGRAM_WEBHOOK_SECRET || ''; // optional
const TG_API = TG_TOKEN ? `https://api.telegram.org/bot${TG_TOKEN}` : '';

function getBotActiveFromDb() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
  return row ? row.value === 'true' : true;
}

function setBotActiveInDb(val) {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(val ? 'true' : 'false', 'BOT_ACTIVE');
}

function tgUserAllowed(userId) {
  if (!TG_ALLOWED_USER_ID) return true; // not recommended, but useful for first setup
  return String(userId) === String(TG_ALLOWED_USER_ID);
}

async function tgCall(method, payload) {
  if (!TG_API) throw new Error('TELEGRAM_BOT_TOKEN nije postavljen');
  const { data } = await axios.post(`${TG_API}/${method}`, payload, { timeout: 15000 });
  if (!data?.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

function tgKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Status', callback_data: 'status' },
        { text: '💰 Balance', callback_data: 'balance' }
      ],
      [
        { text: '⏸️ Pause', callback_data: 'pause' },
        { text: '▶️ Resume', callback_data: 'resume' }
      ],
      [
        { text: '🛑 Emergency Stop', callback_data: 'emergency_stop' }
      ],
      [
        { text: '🔄 Refresh', callback_data: 'menu' }
      ]
    ]
  };
}

function formatUptimeSec(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

async function getUsdcBalanceSafe() {
  if (!global.exchange) return { free: 0, used: 0, total: 0, source: 'exchange-not-ready' };
  const balance = await global.exchange.fetchBalance();

  let free = 0, used = 0, total = 0, source = 'none';
  try {
    const assets = balance?.info?.assets;
    if (Array.isArray(assets)) {
      const a = assets.find(x => String(x.asset).toUpperCase() === 'USDC')
        || assets.find(x => String(x.asset).toUpperCase() === 'U');
      if (a) {
        free = parseFloat(a.availableBalance) || 0;
        total = parseFloat(a.walletBalance) || 0;
        used = Math.max(0, total - free);
        source = `info.assets.${a.asset}`;
      }
    }
  } catch (_) {}

  if (!free && !total) {
    const u = balance?.USDC || {};
    free = Number(u.free) || 0;
    used = Number(u.used) || 0;
    total = Number(u.total) || 0;
    source = 'CCXT.USDC';
  }

  return { free, used, total, source };
}

async function getStatusText() {
  const botActive = getBotActiveFromDb();
  const state = global.botState || {};
  const openCount = db.prepare('SELECT COUNT(*) as c FROM active_positions').get().c;
  return [
    `🤖 *Crypto Bot Status*`,
    ``,
    `• BOT_ACTIVE: ${botActive ? 'true' : 'false'}`,
    `• Cycle #: ${state.cycleCounter || 0}`,
    `• Cycle running: ${state.isCycleRunning ? 'YES' : 'NO'}`,
    `• Open positions: ${openCount}`,
    `• Uptime: ${formatUptimeSec(process.uptime())}`,
    `• Last cycle start: ${state.lastCycleStartedAt || 'n/a'}`,
    `• Last cycle end: ${state.lastCycleEndedAt || 'n/a'}`
  ].join('\n');
}

async function getBalanceText() {
  const b = await getUsdcBalanceSafe();
  return [
    `💰 *Balance*`,
    ``,
    `• Free: *$${b.free.toFixed(2)}*`,
    `• Used: $${b.used.toFixed(2)}`,
    `• Total: $${b.total.toFixed(2)}`,
    `• Source: \`${b.source}\``
  ].join('\n');
}

async function tgSendMenu(chatId, text = '🤖 Crypto Bot Control Panel') {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: tgKeyboard()
  });
}

async function tgAnswerCallback(id, text = 'OK') {
  try {
    await tgCall('answerCallbackQuery', { callback_query_id: id, text, show_alert: false });
  } catch (_) {}
}

// ---------- API ----------
app.get('/api/status', (req, res) => {
  try {
    const botStatus = db.prepare('SELECT value FROM settings WHERE key = ?').get('BOT_ACTIVE');
    const state = global.botState || {};
    res.json({
      status: botStatus && botStatus.value === 'true' ? 'RUNNING' : 'STOPPED',
      online: true,
      cycleCounter: state.cycleCounter || 0,
      isCycleRunning: state.isCycleRunning || false,
      lastCycleStartedAt: state.lastCycleStartedAt || null,
      lastCycleEndedAt: state.lastCycleEndedAt || null,
      lastPrices: state.lastPrices || {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message, online: false });
  }
});

app.get('/api/pairs', (req, res) => res.json(TRADING_PAIRS));

app.get('/api/positions', (req, res) => {
  const data = db.prepare('SELECT * FROM active_positions').all();
  res.json(data);
});

app.post('/api/pause', (req, res) => {
  setBotActiveInDb(false);
  res.json({ success: true, message: 'Bot pauziran - postojeće pozicije ostaju otvorene.' });
});

app.post('/api/resume', settingsRateLimiter, (req, res) => {
  setBotActiveInDb(true);
  res.json({ success: true, message: 'Bot nastavlja - novi entryji su ponovno aktivni.' });
});

app.post('/api/emergency-stop', async (req, res) => {
  if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
  setBotActiveInDb(false);
  const results = await closeAllPositions(global.exchange, db);
  res.json({ success: true, message: 'Bot zaustavljen, sve pozicije zatvorene.', results });
});

app.post('/api/kill-switch', (req, res) => {
  setBotActiveInDb(false);
  res.json({ success: true, message: 'Bot zaustavljen.' });
});

app.post('/api/close-position', async (req, res) => {
  const { symbol } = req.body;
  if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
  const result = await forceClosePosition(global.exchange, db, symbol);
  res.json(result);
});

app.post('/api/move-sl-breakeven', async (req, res) => {
  const { symbol } = req.body;
  if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
  const result = await moveSLToBreakeven(global.exchange, db, symbol);
  res.json(result);
});

// ---------- Telegram webhook ----------
// Supports:
// 1) message commands: /start /menu /status /balance /pause /resume
// 2) callback buttons: status balance pause resume emergency_stop close:<SYMBOL> be:<SYMBOL>
app.post('/telegram-webhook', liveRateLimiter, async (req, res) => {
  try {
    if (TG_SECRET_TOKEN) {
      const hdr = req.headers['x-telegram-bot-api-secret-token'];
      if (hdr !== TG_SECRET_TOKEN) return res.sendStatus(401);
    }

    const update = req.body || {};

    if (!TG_TOKEN) {
      console.warn('⚠️ TELEGRAM_BOT_TOKEN nije postavljen, webhook ignoriran.');
      return res.sendStatus(200);
    }

    // Commands (/start, /status...)
    if (update.message?.text) {
      const msg = update.message;
      const text = String(msg.text || '').trim();
      const chatId = msg.chat?.id;
      const userId = msg.from?.id;

      if (!tgUserAllowed(userId)) {
        await tgCall('sendMessage', { chat_id: chatId, text: '⛔ Not authorized.' });
        return res.sendStatus(200);
      }

      if (text === '/start' || text === '/menu') {
        await tgSendMenu(chatId, '✅ Bot connected. Choose action:');
        return res.sendStatus(200);
      }

      if (text === '/status') {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: await getStatusText(),
          parse_mode: 'Markdown',
          reply_markup: tgKeyboard()
        });
        return res.sendStatus(200);
      }

      if (text === '/balance') {
        await tgCall('sendMessage', {
          chat_id: chatId,
          text: await getBalanceText(),
          parse_mode: 'Markdown',
          reply_markup: tgKeyboard()
        });
        return res.sendStatus(200);
      }

      if (text === '/pause') {
        setBotActiveInDb(false);
        await tgCall('sendMessage', { chat_id: chatId, text: '⏸️ BOT_ACTIVE=false (new entries paused).' });
        return res.sendStatus(200);
      }

      if (text === '/resume') {
        setBotActiveInDb(true);
        await tgCall('sendMessage', { chat_id: chatId, text: '▶️ BOT_ACTIVE=true (new entries resumed).' });
        return res.sendStatus(200);
      }

      await tgCall('sendMessage', {
        chat_id: chatId,
        text: 'Commands: /start /menu /status /balance /pause /resume'
      });
      return res.sendStatus(200);
    }

    // Inline button callbacks
    const cbq = update?.callback_query;
    if (!cbq) return res.sendStatus(200);

    const data = cbq.data || '';
    const chatId = cbq.message?.chat?.id;
    const userId = cbq.from?.id;

    if (!tgUserAllowed(userId)) {
      await tgAnswerCallback(cbq.id, 'Not authorized');
      return res.sendStatus(200);
    }

    if (!global.exchange) {
      await tgAnswerCallback(cbq.id, '❌ Exchange nije spreman');
      return res.sendStatus(200);
    }

    if (data === 'status') {
      await tgAnswerCallback(cbq.id, 'Status...');
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: await getStatusText(),
        parse_mode: 'Markdown',
        reply_markup: tgKeyboard()
      });
      return res.sendStatus(200);
    }

    if (data === 'balance') {
      await tgAnswerCallback(cbq.id, 'Balance...');
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: await getBalanceText(),
        parse_mode: 'Markdown',
        reply_markup: tgKeyboard()
      });
      return res.sendStatus(200);
    }

    if (data === 'pause') {
      setBotActiveInDb(false);
      await tgAnswerCallback(cbq.id, 'Paused');
      await tgCall('sendMessage', { chat_id: chatId, text: '⏸️ BOT_ACTIVE=false', reply_markup: tgKeyboard() });
      return res.sendStatus(200);
    }

    if (data === 'resume') {
      setBotActiveInDb(true);
      await tgAnswerCallback(cbq.id, 'Resumed');
      await tgCall('sendMessage', { chat_id: chatId, text: '▶️ BOT_ACTIVE=true', reply_markup: tgKeyboard() });
      return res.sendStatus(200);
    }

    if (data === 'emergency_stop') {
      setBotActiveInDb(false);
      const results = await closeAllPositions(global.exchange, db);
      await tgAnswerCallback(cbq.id, 'Emergency stop done');
      await tgCall('sendMessage', {
        chat_id: chatId,
        text: `🛑 Emergency stop executed.\nBOT_ACTIVE=false\nClosed positions: ${Array.isArray(results) ? results.length : 0}`,
        reply_markup: tgKeyboard()
      });
      return res.sendStatus(200);
    }

    // existing per-position callbacks from notifier (close:SYMBOL / be:SYMBOL)
    const [action, ...symbolParts] = data.split(':');
    const symbol = symbolParts.join(':');

    if (action === 'close' && symbol) {
      const result = await forceClosePosition(global.exchange, db, symbol);
      await tgAnswerCallback(cbq.id, result.success ? `✅ ${symbol} zatvoreno` : `❌ ${result.error || 'Greška'}`);
      return res.sendStatus(200);
    }

    if (action === 'be' && symbol) {
      const result = await moveSLToBreakeven(global.exchange, db, symbol);
      await tgAnswerCallback(cbq.id, result.success ? `🔒 SL → BE za ${symbol}` : `❌ ${result.error || 'Greška'}`);
      return res.sendStatus(200);
    }

    if (data === 'menu') {
      await tgAnswerCallback(cbq.id, 'Refreshed');
      await tgSendMenu(chatId, '🔄 Refreshed');
      return res.sendStatus(200);
    }

    await tgAnswerCallback(cbq.id, 'Nepoznata akcija');
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Telegram webhook] Greška:', err.message);
    return res.sendStatus(200);
  }
});

// API: balance
app.get('/api/balance', async (req, res) => {
  try {
    if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
    const b = await getUsdcBalanceSafe();
    res.json({ free: b.free, used: b.used, total: b.total });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: unrealized pnl
app.get('/api/unrealized-pnl', liveRateLimiter, async (req, res) => {
  try {
    if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
    const positions = db.prepare('SELECT * FROM active_positions').all();
    const result = [];
    for (const pos of positions) {
      try {
        const ticker = await global.exchange.fetchTicker(pos.symbol);
        const markPrice = ticker.last;
        const unrealizedPnl = pos.side === 'buy'
          ? (markPrice - pos.entry_price) * pos.size
          : (pos.entry_price - markPrice) * pos.size;
        result.push({ symbol: pos.symbol, markPrice, unrealizedPnl: Number(unrealizedPnl.toFixed(2)) });
      } catch (_) {
        result.push({ symbol: pos.symbol, markPrice: null, unrealizedPnl: null });
      }
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API: trades
app.get('/api/trades', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const data = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?').all(limit);
  res.json(data);
});

// API: stats
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

  let cumulative = 0;
  const equityCurve = trades.map(t => {
    cumulative += (t.realized_pnl || 0);
    return { timestamp: t.timestamp, cumulative_pnl: Number(cumulative.toFixed(2)) };
  });

  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    bySymbol[t.symbol].trades += 1;
    bySymbol[t.symbol].pnl += (t.realized_pnl || 0);
    if (t.realized_pnl > 0) bySymbol[t.symbol].wins += 1;
    else bySymbol[t.symbol].losses += 1;
  }
  for (const sym of Object.keys(bySymbol)) {
    const d = bySymbol[sym];
    d.winRate = d.trades > 0 ? Number(((d.wins / d.trades) * 100).toFixed(1)) : null;
    d.pnl = Number(d.pnl.toFixed(2));
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

// API: settings
const EDITABLE_SETTINGS = [
  'RISK_PERCENT',
  'MAX_LEVERAGE',
  'LIQUIDATION_SAFETY_FACTOR',
  'MAX_CONCURRENT_POSITIONS',
  'COOLDOWN_SECONDS',
  'TRADING_HOURS',
  'MAX_DAILY_LOSS_PERCENT'
];

app.get('/api/settings', settingsRateLimiter, (req, res) => {
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE key IN (' + EDITABLE_SETTINGS.map(() => '?').join(',') + ')')
    .all(...EDITABLE_SETTINGS);
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

app.post('/api/settings', settingsRateLimiter, (req, res) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Neispravan payload' });
  }
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  const updateMany = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (EDITABLE_SETTINGS.includes(key)) {
        update.run(String(value), key);
      }
    }
  });
  updateMany(Object.entries(updates));
  res.json({ success: true });
});

// ---------- Start ----------
function startServer(exchange) {
  global.exchange = exchange;
  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Dashboard online: http://localhost:${PORT}`));
}

module.exports = { startServer };
