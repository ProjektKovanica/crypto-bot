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
  options: {
    defaultType: 'future',
    // Acknowledge the stricter rate limit so fetchOpenOrders() works without a symbol
    fetchOpenOrders: { warnWithoutSymbol: false },
  },
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
    let orders = [];
    let fetchedAll = false;

    // Preferred: fetch open orders across EVERY symbol in one call.
    // The warnWithoutSymbol option above makes this work.
    try {
      orders = await exchange.fetchOpenOrders();
      fetchedAll = true;
      console.log(`  Fetched ${orders.length} open order(s) across all symbols.`);
    } catch (err) {
      console.log(`  Could not fetch all orders at once (${err.message})`);
      console.log(`  Falling back to per-pair scan of TRADING_PAIRS...`);
    }

    // Fallback: scan the configured pairs individually
    if (!fetchedAll) {
      for (const symbol of TRADING_PAIRS) {
        try {
          const o = await exchange.fetchOpenOrders(symbol);
          orders.push(...o);
        } catch (err) {
          console.error(`  ❌ ${symbol}: ${err.message}`);
        }
      }
      console.log(`  Fetched ${orders.length} open order(s) from ${TRADING_PAIRS.length} configured pairs.`);
    }

    if (orders.length === 0) {
      console.log('  No open orders found.');
    }

    for (const order of orders) {
      const label = `${order.symbol} ${order.side} ${order.type} ${order.amount} @ ${order.price ?? 'market'} (id=${order.id})`;
      if (DRY_RUN) {
        console.log(`    [DRY-RUN] Would cancel ${label}`);
      } else {
        try {
          await exchange.cancelOrder(order.id, order.symbol);
          console.log(`    ✅ Cancelled ${label}`);
          totalCancelled++;
        } catch (err) {
          console.error(`    ❌ Failed to cancel ${label}: ${err.message}`);
        }
      }
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
      console.log(`\n⚠️  Still $${after.used.toFixed(2)} in used margin.`);
      console.log(`\n   Run the diagnostic to see exactly which bucket holds it:`);
      console.log(`     node diagnose-balance.js`);
      console.log(`\n   Common causes when no positions/orders exist:`);
      console.log(`     - Single-Asset Mode: USDC is not the active collateral asset`);
      console.log(`     - Funds are in the Spot wallet, not the Futures wallet`);
      console.log(`     - Isolated-margin position on an unlisted symbol`);
    }
  } else {
    console.log('\n🔍 Dry run complete. Run without --dry-run to execute.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
