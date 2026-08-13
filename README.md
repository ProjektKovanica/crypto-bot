# crypto-bot 🤖

Automated cryptocurrency trading bot for Binance Futures with technical analysis and real-time monitoring.

## Features

- 🔄 **Automated Trading**: Trades on 6 major crypto pairs (BTC, ETH, BNB, XRP, SOL, DOGE)
- 📊 **Technical Analysis**: RSI, EMA, MACD indicators
- 💰 **Risk Management**: Stop-loss and take-profit automation
- 📈 **Live Dashboard**: Web interface at http://localhost:5050
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

Access the web dashboard at: `http://localhost:5050`

**API Endpoints:**
- `GET /api/status` - Bot status
- `GET /api/positions` - Active positions
- `GET /api/trades` - Trade history
- `GET /api/balance` - Account balance
- `GET /api/stats` - Performance statistics
- `POST /api/pause` - Pause new entries
- `POST /api/emergency-stop` - Close all positions
- `POST /api/close-position` - Close specific position

## File Structure

```
crypto-bot/
├── bot.js                 # Main trading loop
├── server.js              # Express dashboard server
├── db.js                  # Database setup
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

## Risk Management

- **Default Risk**: 2% of balance per trade
- **Stop-Loss**: 3% below entry
- **Take-Profit**: 6% above entry
- **Minimum Balance**: $20 USDC required

⚠️ **DISCLAIMER**: Cryptocurrency trading is risky. Test thoroughly on testnet before live trading with real funds.

## Troubleshooting

### Bot won't start
```bash
npm install
pm2 restart crypto-bot
```

### Port 5050 already in use
```bash
lsof -i :5050
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
