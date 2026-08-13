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

The bot scans all 6 trading pairs every **15 seconds**. A trade is opened when **at least 3 out of 4** core signal conditions are met, plus safety filters pass:

### LONG Core Conditions (need ≥ 3 of 4)
1. **Uptrend**: Current price is above the 50-period EMA
2. **Oversold RSI**: RSI (14) is below 40
3. **Bullish Momentum**: MACD histogram is positive
4. **RSI Rising**: Current RSI is higher than the previous RSI

### SHORT Core Conditions (need ≥ 3 of 4)
1. **Downtrend**: Current price is below the 50-period EMA
2. **Overbought RSI**: RSI (14) is above 60
3. **Bearish Momentum**: MACD histogram is negative
4. **RSI Falling**: Current RSI is lower than the previous RSI

### Soft Filters (logged as warnings, do not block trades)
- **ADX**: ADX (14) ≥ 25 preferred but not required
- **Volume**: Above-average volume preferred but not required
- **Multi-Timeframe Confirmation**: 1h/4h alignment preferred but not required

### Hard Filters (will block trades)
- **Funding Rate**: Funding rate must not be unfavorable (> ±0.05%)
- **Trading Hours**: Within configured UTC window (default: 06:00–20:00)
- **Cooldown**: At least 300 seconds since the last trade on this pair
- **Position Cap**: Fewer than 3 open positions (configurable)
- **Daily Drawdown**: Daily realized loss has not exceeded 5% of balance
- **Minimum Balance**: At least $20 USDC available
- **Minimum Position**: Notional value ≥ $10

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
