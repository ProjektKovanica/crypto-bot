// bot.js - ProjektKovanica/crypto-bot (Hedge mode + USDC/BNFCR/RWUSD support)

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

function normalizeSymbol(symbol) {
  if (symbol.includes('/')) return symbol;
  
  const match = symbol.match(/^([A-Z]+)(USDC|USDT|FDUSD|BNFCR|RWUSD)$/);
  if (match) {
    const [_, base, quote] = match;
    return `${base}/${quote}:${quote}`;
  }
  
  return symbol.includes(':') ? symbol : `${symbol}:USDC`;
}

async function openLong(symbol, quantity, leverage = 10, maxRetries = 3) {
  try {
    const normalizedSymbol = normalizeSymbol(symbol);
    
    await exchange.setLeverage(leverage, normalizedSymbol);

    const order = await exchange.createMarketBuyOrder(normalizedSymbol, quantity, null, {
      positionSide: 'LONG'
    });
    console.log(`✅ LONG otvoren: ${normalizedSymbol} ${quantity} @ ${order.average}`);

    const entryPrice = order.average;
    let stopLossPrice = entryPrice * 0.98;
    let takeProfitPrice = entryPrice * 1.04;

    let retry = 0;
    while (retry < maxRetries) {
      try {
        const ticker = await exchange.fetchTicker(normalizedSymbol);
        const currentPrice = ticker.last;

        stopLossPrice = Math.min(stopLossPrice, currentPrice * 0.999);
        takeProfitPrice = Math.max(takeProfitPrice, currentPrice * 1.001);

        await exchange.createOrder(normalizedSymbol, 'STOP_MARKET', 'sell', quantity, null, {
          stopPrice: stopLossPrice,
          positionSide: 'LONG'
        });

        await exchange.createOrder(normalizedSymbol, 'TAKE_PROFIT_MARKET', 'sell', quantity, null, {
          stopPrice: takeProfitPrice,
          positionSide: 'LONG'
        });

        console.log(`🛡️ SL: ${stopLossPrice} | 🎯 TP: ${takeProfitPrice}`);
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

    db.savePosition({ 
      symbol: normalizedSymbol, 
      side: 'LONG', 
      entryPrice, 
      quantity, 
      stopLossPrice, 
      takeProfitPrice, 
      timestamp: Date.now() 
    });

    await notifier.send(`LONG otvoren: ${normalizedSymbol}\nUlaz: ${entryPrice}\nSL: ${stopLossPrice}\nTP: ${takeProfitPrice}`);

  } catch (err) {
    console.error(`❌ Greška pri otvaranju LONG: ${err.message}`);
    await notifier.send(`❌ Greška: ${err.message}`);
  }
}

async function openShort(symbol, quantity, leverage = 10, maxRetries = 3) {
  try {
    const normalizedSymbol = normalizeSymbol(symbol);
    
    await exchange.setLeverage(leverage, normalizedSymbol);

    const order = await exchange.createMarketSellOrder(normalizedSymbol, quantity, null, {
      positionSide: 'SHORT'
    });
    console.log(`✅ SHORT otvoren: ${normalizedSymbol} ${quantity} @ ${order.average}`);

    const entryPrice = order.average;
    let stopLossPrice = entryPrice * 1.02;
    let takeProfitPrice = entryPrice * 0.96;

    let retry = 0;
    while (retry < maxRetries) {
      try {
        const ticker = await exchange.fetchTicker(normalizedSymbol);
        const currentPrice = ticker.last;

        stopLossPrice = Math.max(stopLossPrice, currentPrice * 1.001);
        takeProfitPrice = Math.min(takeProfitPrice, currentPrice * 0.999);

        await exchange.createOrder(normalizedSymbol, 'STOP_MARKET', 'buy', quantity, null, {
          stopPrice: stopLossPrice,
          positionSide: 'SHORT'
        });

        await exchange.createOrder(normalizedSymbol, 'TAKE_PROFIT_MARKET', 'buy', quantity, null, {
          stopPrice: takeProfitPrice,
          positionSide: 'SHORT'
        });

        console.log(`🛡️ SL: ${stopLossPrice} | 🎯 TP: ${takeProfitPrice}`);
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

    db.savePosition({ 
      symbol: normalizedSymbol, 
      side: 'SHORT', 
      entryPrice, 
      quantity, 
      stopLossPrice, 
      takeProfitPrice, 
      timestamp: Date.now() 
    });

    await notifier.send(`SHORT otvoren: ${normalizedSymbol}\nUlaz: ${entryPrice}\nSL: ${stopLossPrice}\nTP: ${takeProfitPrice}`);

  } catch (err) {
    console.error(`❌ Greška pri otvaranju SHORT: ${err.message}`);
    await notifier.send(`❌ Greška: ${err.message}`);
  }
}

async function main() {
  await init();
  await openLong('DOGEUSDC', 100, 10);
}

main().catch(console.error);