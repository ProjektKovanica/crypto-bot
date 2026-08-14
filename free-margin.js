#!/usr/bin/env node
/**
 * free-margin.js
 *
 * Utility script to free up "Used (Margin)" balance on Binance Futures.
 *
 * What it does:
 *   1. Cancels ALL open orders on every trading pair
 *   2. Closes ALL open positions (market close, reduceOnly)
 *   3. Reports the balance before and after
 *
 * Usage:
 *   node free-margin.js              # free everything
 *   node free-margin.js --dry-run    # preview only, no actual cancellations/closes
 *   node free-margin.js --orders     # only cancel open orders
 *   node free-margin.js --positions  # only close open positions
 */

require('dotenv').config();
const ccxt = require('ccxt');

const { TRADING_PAIRS } = require('./config');

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const ONLY_ORDERS = args.has('--orders');
const ONLY_POSITIONS = args.has('--positions');
const DO_ORDERS = ONLY_ORDERS || (!ONLY_ORDERS && !ONLY_POSITIONS);
const DO_POSITIONS = ONLY_POSITIONS || (!ONLY_ORDERS && !ONLY_POSITIONS);

if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_SECRET) {
  console.error('❌ BINANCE_API_KEY and BINANCE_SECRET must be set in .env');
  process.exit(1);
}

const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET,
  enableRateLimit: true,
  options: { defaultType: 'future' },
});

function getUsdcBalance(balance) {
  let free = 0, used = 0, total = 0;
  try {
    const assets = balance?.info?.assets;
    if (Array.isArray(assets)) {
      const a = assets.find(x => String(x.asset).toUpperCase() === 'USDC')
        || assets.find(x => String(x.asset).toUpperCase() === 'U');
      if (a) {
        free = parseFloat(a.availableBalance) || 0;
        total = parseFloat(a.walletBalance) || 0;
        used = Math.max(0, total - free);
      }
    }
  } catch (_) {}
  if (!free && !total) {
    const u = balance?.USDC || {};
    free = Number(u.free) || 0;
    used = Number(u.used) || 0;
    total = Number(u.total) || 0;
  }
  return { free, used, total };
}

async function main() {
  console.log('⏳ Loading markets...');
  await exchange.loadMarkets();

  // ── Balance BEFORE ──────────────────────────────────────────
  const balanceBefore = await exchange.fetchBalance();
  const before = getUsdcBalance(balanceBefore);
  console.log('\n━━━ BALANCE BEFORE ━━━');
  console.log(`  Free:  $${before.free.toFixed(2)}`);
  console.log(`  Used:  $${before.used.toFixed(2)} (margin)`);
  console.log(`  Total: $${before.total.toFixed(2)}`);

  if (before.used < 0.01) {
    console.log('\n✅ No used margin detected. Nothing to free.');
    return;
  }

  if (DRY_RUN) {
    console.log('\n🔍 DRY RUN — no actual changes will be made.');
  }

  // ── 1. Cancel ALL open orders ──────────────────────────────
  if (DO_ORDERS) {
    console.log('\n━━━ CANCELLING OPEN ORDERS ━━━');
    let totalCancelled = 0;

    for (const symbol of TRADING_PAIRS) {
      try {
        const orders = await exchange.fetchOpenOrders(symbol);
        if (orders.length === 0) continue;

        console.log(`  ${symbol}: ${orders.length} open order(s) found`);
        for (const order of orders) {
          if (DRY_RUN) {
            console.log(`    [DRY-RUN] Would cancel ${order.side} ${order.type} ${order.amount} @ ${order.price || 'market'} (id=${order.id})`);
          } else {
            await exchange.cancelOrder(order.id, symbol);
            console.log(`    ✅ Cancelled order ${order.id}`);
            totalCancelled++;
          }
        }
      } catch (err) {
        console.error(`  ❌ ${symbol}: ${err.message}`);
      }
    }

    // Also try cancelling all orders at once (catches orders on pairs not in TRADING_PAIRS)
    try {
      const allOrders = await exchange.fetchOpenOrders();
      const extra = allOrders.filter(o => !TRADING_PAIRS.includes(o.symbol));
      if (extra.length > 0) {
        console.log(`\n  Found ${extra.length} additional open order(s) on other pairs.`);
        for (const order of extra) {
          if (DRY_RUN) {
            console.log(`    [DRY-RUN] Would cancel ${order.symbol} order ${order.id}`);
          } else {
            try {
              await exchange.cancelOrder(order.id, order.symbol);
              console.log(`    ✅ Cancelled ${order.symbol} order ${order.id}`);
              totalCancelled++;
            } catch (err) {
              console.error(`    ❌ ${order.symbol} order ${order.id}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      // Some exchanges don't support fetchOpenOrders without symbol
      console.log(`  (Could not fetch all orders: ${err.message})`);
    }

    console.log(`\n  Total orders ${DRY_RUN ? 'would be ' : ''}cancelled: ${totalCancelled}`);
  }

  // ── 2. Close ALL open positions ─────────────────────────────
  if (DO_POSITIONS) {
    console.log('\n━━━ CLOSING OPEN POSITIONS ━━━');
    let totalClosed = 0;

    const positions = await exchange.fetchPositions();
    const openPositions = positions.filter(p => Math.abs(parseFloat(p.contracts)) > 0);

    if (openPositions.length === 0) {
      console.log('  No open positions found.');
    }

    for (const pos of openPositions) {
      const contracts = parseFloat(pos.contracts);
      const side = pos.side; // 'long' or 'short'
      const closeSide = side === 'long' ? 'sell' : 'buy';

      console.log(`  ${pos.symbol}: ${side} ${Math.abs(contracts)} contracts (entry=${pos.entryPrice})`);

      if (DRY_RUN) {
        console.log(`    [DRY-RUN] Would close with ${closeSide} market order (reduceOnly)`);
      } else {
        try {
          await exchange.createMarketOrder(pos.symbol, closeSide, Math.abs(contracts), undefined, {
            reduceOnly: true,
          });
          console.log(`    ✅ Position closed`);
          totalClosed++;
        } catch (err) {
          console.error(`    ❌ ${err.message}`);
        }
      }
    }

    console.log(`\n  Total positions ${DRY_RUN ? 'would be ' : ''}closed: ${totalClosed}`);
  }

  // ── Balance AFTER ───────────────────────────────────────────
  if (!DRY_RUN) {
    // Wait a moment for Binance to update balances
    await new Promise(r => setTimeout(r, 2000));
    const balanceAfter = await exchange.fetchBalance();
    const after = getUsdcBalance(balanceAfter);

    console.log('\n━━━ BALANCE AFTER ━━━');
    console.log(`  Free:  $${after.free.toFixed(2)}`);
    console.log(`  Used:  $${after.used.toFixed(2)} (margin)`);
    console.log(`  Total: $${after.total.toFixed(2)}`);

    const freed = after.free - before.free;
    console.log(`\n💰 Freed: $${freed.toFixed(2)} moved from Used(Margin) → Free`);

    if (after.used > 0.01) {
      console.log(`\n⚠️  Still $${after.used.toFixed(2)} in used margin. This could be from:`);
      console.log('   - Pending liquidation or funding fees');
      console.log('   - Positions that haven\'t fully settled yet');
      console.log('   - Cross-margin requirements on other assets');
    }
  } else {
    console.log('\n🔍 Dry run complete. Run without --dry-run to execute.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
