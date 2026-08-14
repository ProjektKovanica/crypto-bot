// bot.js - ProjektKovanica/crypto-bot (zakrpa za -2021 grešku)

const ccxt = require('ccxt');
const config = require('./config');
const db = require('./db');
const notifier = require('./notifier');

const exchange = new ccxt.binance({
  apiKey: config.BINANCE_API_KEY,
  secret: config.BINANCE_SECRET_KEY,
  options: { defaultType: 'future' }
});

async function init() {
  await exchange.loadMarkets();
  console.log('✅ Bot pokrenut. Praćenje signala...');
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openLong(symbol, quantity, leverage = 10, maxRetries = 3) {
  try {
    await exchange.setLeverage(leverage, symbol);
    const order = await exchange.createMarketBuyOrder(symbol, quantity);
    const entryPrice = order.average;
    let stopLossPrice = entryPrice * 0.98;
    let takeProfitPrice = entryPrice * 1.04;

    let retry = 0;
    while (retry < maxRetries) {
      try {
        const ticker = await exchange.fetchTicker(symbol);
        const currentPrice = ticker.last;
        stopLossPrice = Math.min(stopLossPrice, currentPrice * 0.999);
        takeProfitPrice = Math.max(takeProfitPrice, currentPrice * 1.001);

        await exchange.createOrder(symbol, 'STOP_MARKET', 'sell', quantity, null, { stopPrice: stopLossPrice, reduceOnly: true });
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'sell', quantity, null, { stopPrice: takeProfitPrice, reduceOnly: true });
        break;
      } catch (err) {
        if (err.message && err.message.includes('-2021')) {
          retry++;
          if (retry >= maxRetries) throw err;
          await sleep(1500);
        } else {
          throw err;
        }
      }
    }

    db.savePosition({ symbol, side: 'LONG', entryPrice, quantity, stopLossPrice, takeProfitPrice, timestamp: Date.now() });
    await notifier.send(`LONG otvoren: ${symbol}\nUlaz: ${entryPrice}\nSL: ${stopLossPrice}\nTP: ${takeProfitPrice}`);
  } catch (err) {
    console.error(`❌ Greška pri otvaranju LONG: ${err.message}`);
    await notifier.send(`❌ Greška: ${err.message}`);
  }
}

async function openShort(symbol, quantity, leverage = 10, maxRetries = 3) {
  try {
    await exchange.setLeverage(leverage, symbol);
    const order = await exchange.createMarketSellOrder(symbol, quantity);
    const entryPrice = order.average;
    let stopLossPrice = entryPrice * 1.02;
    let takeProfitPrice = entryPrice * 0.96;

    let retry = 0;
    while (retry < maxRetries) {
      try {
        const ticker = await exchange.fetchTicker(symbol);
        const currentPrice = ticker.last;
        stopLossPrice = Math.max(stopLossPrice, currentPrice * 1.001);
        takeProfitPrice = Math.min(takeProfitPrice, currentPrice * 0.999);

        await exchange.createOrder(symbol, 'STOP_MARKET', 'buy', quantity, null, { stopPrice: stopLossPrice, reduceOnly: true });
        await exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', 'buy', quantity, null, { stopPrice: takeProfitPrice, reduceOnly: true });
        break;
      } catch (err) {
        if (err.message && err.message.includes('-2021')) {
          retry++;
          if (retry >= maxRetries) throw err;
          await sleep(1500);
        } else {
          throw err;
        }
      }
    }

    db.savePosition({ symbol, side: 'SHORT', entryPrice, quantity, stopLossPrice, takeProfitPrice, timestamp: Date.now() });
    await notifier.send(`SHORT otvoren: ${symbol}\nUlaz: ${entryPrice}\nSL: ${stopLossPrice}\nTP: ${takeProfitPrice}`);
  } catch (err) {
    console.error(`❌ Greška pri otvaranju SHORT: ${err.message}`);
    await notifier.send(`❌ Greška: ${err.message}`);
  }
}

async function main() {
  await init();
}

main().catch(console.error);