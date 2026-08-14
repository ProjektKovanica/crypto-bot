const express = require('express');
const path = require('path');
const axios = require('axios');
const { rateLimit } = require('express-rate-limit');
const { db } = require('./db');
const { TRADING_PAIRS } = require('./config');
const { forceClosePosition, closeAllPositions, moveSLToBreakeven } = require('./strategies/position_manager');
const { getTradableBalance } = require('./balance');
const { closeParams, closeOrderSide } = require('./position-mode');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 4000;

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
  if (!global.exchange) return { free: 0, used: 0, total: 0, currency: 'USD', source: 'exchange-not-ready' };
  const balance = await global.exchange.fetchBalance();
  const r = getTradableBalance(balance);
  return { free: r.free, used: r.used, total: r.total, currency: r.currency, source: r.source };
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
    `• Currency: ${b.currency}`,
    `• Free: *${b.free.toFixed(2)}*`,
    `• Used: ${b.used.toFixed(2)}`,
    `• Total: ${b.total.toFixed(2)}`,
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
    res.json({ free: b.free, used: b.used, total: b.total, currency: b.currency });
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

  // Advanced stats: max drawdown, profit factor, streaks, Sharpe-like, hourly heatmap
  let peak = 0, maxDrawdown = 0, maxDrawdownPct = 0;
  let cum = 0;
  for (const t of trades) {
    cum += (t.realized_pnl || 0);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (peak > 0 && (dd / peak) > maxDrawdownPct) maxDrawdownPct = dd / peak;
  }

  const grossProfit = wins.reduce((s, t) => s + t.realized_pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realized_pnl, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? Infinity : 0;

  // Streaks
  let currentStreak = 0, longestWinStreak = 0, longestLoseStreak = 0, tempStreak = 0, lastDir = null;
  for (const t of trades) {
    const dir = (t.realized_pnl || 0) > 0 ? 'win' : 'lose';
    if (dir === lastDir) { tempStreak++; }
    else { tempStreak = 1; lastDir = dir; }
    if (dir === 'win' && tempStreak > longestWinStreak) longestWinStreak = tempStreak;
    if (dir === 'lose' && tempStreak > longestLoseStreak) longestLoseStreak = tempStreak;
  }
  currentStreak = tempStreak * (lastDir === 'win' ? 1 : -1);

  // Sharpe-like (daily returns std dev)
  const dailyPnls = {};
  for (const t of trades) {
    const day = (t.timestamp || '').slice(0, 10);
    if (!day) continue;
    dailyPnls[day] = (dailyPnls[day] || 0) + (t.realized_pnl || 0);
  }
  const dailyReturns = Object.values(dailyPnls);
  let sharpeRatio = 0;
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpeRatio = stdDev > 0 ? Number((mean / stdDev * Math.sqrt(365)).toFixed(2)) : 0;
  }

  // Hourly heatmap (hour 0-23 -> pnl)
  const hourlyPnl = Array(24).fill(0);
  const hourlyCount = Array(24).fill(0);
  for (const t of trades) {
    const ts = t.timestamp || '';
    const hourMatch = ts.match(/(\d{2}):\d{2}:\d{2}/);
    if (hourMatch) {
      const h = parseInt(hourMatch[1]);
      hourlyPnl[h] += (t.realized_pnl || 0);
      hourlyCount[h]++;
    }
  }

  // Avg trade duration (if close_time exists)
  let avgDurationMin = null;
  const durTrades = trades.filter(t => t.open_time && t.timestamp);
  if (durTrades.length) {
    const totalMs = durTrades.reduce((s, t) => {
      return s + (new Date(t.timestamp).getTime() - new Date(t.open_time).getTime());
    }, 0);
    avgDurationMin = Number((totalMs / durTrades.length / 60000).toFixed(1));
  }

  // Weekly PnL
  const weeklyPnl = {};
  for (const t of trades) {
    const d = new Date(t.timestamp);
    if (isNaN(d)) continue;
    const startOfWeek = new Date(d);
    startOfWeek.setDate(d.getDate() - d.getDay());
    const key = startOfWeek.toISOString().slice(0, 10);
    weeklyPnl[key] = (weeklyPnl[key] || 0) + (t.realized_pnl || 0);
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
    bySymbol,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPct: Number((maxDrawdownPct * 100).toFixed(1)),
    profitFactor,
    longestWinStreak,
    longestLoseStreak,
    currentStreak,
    sharpeRatio,
    hourlyPnl: hourlyPnl.map((v, i) => ({ hour: i, pnl: Number(v.toFixed(2)), trades: hourlyCount[i] })),
    avgDurationMin,
    weeklyPnl: Object.entries(weeklyPnl).map(([week, pnl]) => ({ week, pnl: Number(pnl.toFixed(2)) }))
  });
});

// API: daily PnL
app.get('/api/daily-pnl', liveRateLimiter, (req, res) => {
  const rows = db.prepare(`
    SELECT date(timestamp) as day, SUM(realized_pnl) as pnl, COUNT(*) as trades
    FROM trades
    GROUP BY date(timestamp)
    ORDER BY day DESC
    LIMIT 30
  `).all();
  res.json(rows.reverse());
});

// API: export trades as CSV
app.get('/api/trades/export', liveRateLimiter, (req, res) => {
  const data = db.prepare('SELECT * FROM trades ORDER BY timestamp DESC').all();
  const headers = ['timestamp', 'symbol', 'side', 'price', 'amount', 'realized_pnl', 'strategy', 'open_time'];
  let csv = headers.join(',') + '\n';
  for (const t of data) {
    csv += headers.map(h => {
      const v = t[h] ?? '';
      return String(v).includes(',') ? `"${v}"` : v;
    }).join(',') + '\n';
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=trades_export.csv');
  res.send(csv);
});

// API: bot logs (last N lines from console captured in memory)
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
function captureLog(level, args) {
  const line = { ts: new Date().toISOString(), level, msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') };
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}
console.log = (...args) => { captureLog('info', args); origLog.apply(console, args); };
console.error = (...args) => { captureLog('error', args); origError.apply(console, args); };
console.warn = (...args) => { captureLog('warn', args); origWarn.apply(console, args); };

app.get('/api/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, LOG_BUFFER_SIZE);
  res.json(logBuffer.slice(-limit));
});

// API: risk exposure (total margin used vs balance)
app.get('/api/risk-exposure', liveRateLimiter, async (req, res) => {
  try {
    if (!global.exchange) return res.status(500).json({ error: 'Exchange not ready' });
    const positions = db.prepare('SELECT * FROM active_positions').all();
    const b = await getUsdcBalanceSafe();
    let totalExposure = 0;
    for (const p of positions) {
      totalExposure += Math.abs((p.entry_price || 0) * (p.size || 0));
    }
    const exposurePct = b.total > 0 ? (totalExposure / b.total * 100) : 0;
    res.json({
      totalExposure: Number(totalExposure.toFixed(2)),
      balanceTotal: Number(b.total.toFixed(2)),
      exposurePct: Number(exposurePct.toFixed(1)),
      openPositions: positions.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

app.post('/api/free-margin', async (req, res) => {
  if (!global.exchange) return res.status(500).json({ error: 'Exchange nije spreman' });
  try {
    const results = { ordersCancelled: 0, positionsClosed: 0, errors: [] };

    // Cancel all open orders
    const { TRADING_PAIRS } = require('./config');
    for (const symbol of TRADING_PAIRS) {
      try {
        const orders = await global.exchange.fetchOpenOrders(symbol);
        for (const order of orders) {
          await global.exchange.cancelOrder(order.id, symbol);
          results.ordersCancelled++;
        }
      } catch (e) { results.errors.push(`${symbol} orders: ${e.message}`); }
    }

    // Close all open positions
    const positions = await global.exchange.fetchPositions();
    const open = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);
    for (const pos of open) {
      try {
        const closeSide = closeOrderSide(pos.side);
        await global.exchange.createMarketOrder(pos.symbol, closeSide, Math.abs(parseFloat(pos.contracts)), undefined, closeParams(pos.side));
        results.positionsClosed++;
      } catch (e) { results.errors.push(`${pos.symbol} close: ${e.message}`); }
    }

    res.json({ success: true, ...results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Start ----------
function startServer(exchange) {
  global.exchange = exchange;

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Dashboard online: http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} je zauzet — vjerojatno bot već radi.\n`);
      console.error('   Provjeri što koristi port:');
      console.error(`     pm2 list`);
      console.error(`     lsof -i :${PORT}`);
      console.error('\n   Ako PM2 već vrti bota, koristi:');
      console.error('     pm2 restart crypto-bot && pm2 logs crypto-bot');
      console.error('\n   Za pokretanje u foregroundu prvo zaustavi PM2:');
      console.error('     pm2 stop crypto-bot && npm start');
      console.error(`\n   Ili pokreni na drugom portu:`);
      console.error(`     PORT=4001 npm start\n`);
      process.exit(1);
    }
    console.error('❌ Greška servera:', err.message);
    process.exit(1);
  });

  return server;
}

module.exports = { startServer };
