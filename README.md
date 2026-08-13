# crypto-bot 🤖

Automated cryptocurrency trading bot for Binance Futures with technical analysis and real-time monitoring.

## Features

- 🔄 **Automated Trading**: Trades on 6 major crypto pairs (BTC, ETH, BNB, XRP, SOL, DOGE)
- 📊 **Technical Analysis**: RSI, EMA, MACD indicators
- 💰 **Risk Management**: Stop-loss and take-profit automation
- 📈 **Live Dashboard**: Web interface at http://localhost:4000
- 🔔 **Notifications**: Telegram alerts for trades
- 💾 **Trade History**: SQLite database with P&L tracking
- ⚡ **15-second Scan Interval**: Fast market analysis

## Prerequisites

- Node.js >= 18.0.0
- npm
- Binance Futures API credentials
- (Optional) Telegram bot for notifications

## Installation

```bash
git clone https://github.com/ProjektKovanica/crypto-bot.git
cd crypto-bot
npm install
```

## Configuration

Create a `.env` file in the root directory:

```env
BINANCE_API_KEY=your_api_key_here
BINANCE_SECRET=your_api_secret_here
API_KEY=your_dashboard_api_key_here
TELEGRAM_BOT_TOKEN=your_telegram_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
```

## Running the Bot

### Development Mode
```bash
npm run dev
```

### Production Mode (with PM2)
```bash
npm start
pm2 start bot.js --name "crypto-bot"
pm2 save
pm2 startup
```

### Quick Deployment
```bash
chmod +x deploy.sh
./deploy.sh
```

## Dashboard

Access the web dashboard at: `http://localhost:4000`

**API Endpoints:**
- `GET /api/status` - Bot status
- `GET /api/positions` - Active positions
- `GET /api/trades` - Trade history
- `GET /api/balance` - Account balance
- `GET /api/stats` - Performance statistics
- `GET /api/settings` - Bot settings (risk, leverage, cooldown, etc.)
- `POST /api/settings` - Update a bot setting (`{ key, value }`)
- `POST /api/pause` - Pause new entries
- `POST /api/resume` - Resume new entries
- `POST /api/emergency-stop` - Close all positions
- `POST /api/close-position` - Close specific position

## File Structure

```
crypto-bot/
├── bot.js                 # Main trading loop
├── server.js              # Express dashboard server
├── db.js                  # Database setup
├── config.js              # Shared configuration (trading pairs)
├── strategies/
│   ├── indicators.js      # Technical indicators (RSI, EMA, MACD)
│   ├── trend_pullback.js  # Trading logic & entry signals
│   └── position_manager.js # Position & risk management
├── notifier.js            # Telegram notifications
├── public/                # Frontend files
├── trading.db             # SQLite database
├── .env                   # Environment variables (not tracked)
└── package.json           # Dependencies
```

## When Does the Bot Start Trading?

The bot scans all 6 trading pairs every **15 seconds**. A trade is opened only when **all** of the following conditions are met simultaneously:

### LONG Entry Conditions
1. **Uptrend**: Current price is above the 50-period EMA
2. **Oversold RSI**: RSI (14) is below 40
3. **Bullish Momentum**: MACD histogram is positive
4. **RSI Rising**: Current RSI is higher than the previous RSI
5. **Multi-Timeframe Confirmation**: Both 1h and 4h timeframes are bullish
6. **ADX Filter**: ADX (14) ≥ 25 (trending market required)
7. **Volume Filter**: Current volume is above the 20-period volume SMA
8. **Funding Rate**: Funding rate ≤ +0.05% (not expensive to hold long)
9. **Trading Hours**: Within configured UTC window (default: 06:00–20:00)
10. **Cooldown**: At least 300 seconds since the last trade on this pair
11. **Position Cap**: Fewer than 3 open positions (configurable)
12. **Daily Drawdown**: Daily realized loss has not exceeded 5% of balance
13. **Minimum Balance**: At least $20 USDC available
14. **Minimum Position**: Notional value ≥ $10

### SHORT Entry Conditions
Same filters as LONG, but mirrored:
- **Downtrend** (price below EMA), **Overbought RSI** (> 60), **Bearish MACD**, **RSI Falling**, **MTF bearish**, and funding rate ≤ −0.05%.

> Because so many conditions must align, it is normal for the bot to run for **hours or even days** without opening a trade, especially in low-volatility or ranging markets (ADX < 25).

## Risk Management

- **Default Risk**: 2% of balance per trade (adjusted via half-Kelly Criterion when ≥ 10 historical trades exist)
- **Stop-Loss**: 1.5 × ATR below/above entry (fallback: 3% if ATR unavailable)
- **Take-Profit**: 3 × ATR above/below entry (fallback: 6% if ATR unavailable)
- **Risk-Reward Ratio**: 2 : 1 (TP distance is 2× the SL distance)
- **Trailing Stop**: Activates when position is ≥ 1.5% in profit; trails at 1 × ATR from the highest (long) or lowest (short) seen price
- **Dynamic Leverage**: Calculated as `floor(safety_factor / SL%)`, capped at MAX_LEVERAGE (default: 10×)
- **Max Concurrent Positions**: 3 (configurable)
- **Cooldown Between Trades**: 300 seconds per pair (configurable)
- **Trading Hours**: 06:00–20:00 UTC by default (configurable, or `disabled`)
- **Daily Drawdown Limit**: 5% of balance — no new entries after this is breached
- **Minimum Balance**: $20 USDC required

⚠️ **DISCLAIMER**: Cryptocurrency trading is risky. Test thoroughly on testnet before live trading with real funds.

## Troubleshooting

### Bot won't start
```bash
npm install
pm2 restart crypto-bot
```

### Port 4000 already in use
```bash
lsof -i :4000
kill -9 <PID>
```

### Check logs
```bash
pm2 logs crypto-bot
```

## Deployment on VPS

```bash
ssh root@your_vps_ip
git clone https://github.com/ProjektKovanica/crypto-bot.git
cd crypto-bot
npm install
./deploy.sh
```

## License

MIT

## Author

ProjektKovanica
