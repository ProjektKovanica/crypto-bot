#!/usr/bin/env node
/**
 * diagnose-balance.js
 *
 * Diagnostic tool that shows EXACTLY where your Binance Futures margin is locked.
 *
 * Binance reports margin usage in separate buckets per asset:
 *   - positionInitialMargin   → margin held by OPEN POSITIONS
 *   - openOrderInitialMargin  → margin held by OPEN ORDERS (incl. SL/TP orders)
 *   - maintMargin             → maintenance margin requirement
 *   - crossUnPnl              → unrealized PnL on cross positions
 *
 * If availableBalance is 0 but there are no positions, the culprit is almost
 * always openOrderInitialMargin — leftover stop-loss / take-profit orders,
 * possibly on pairs outside your TRADING_PAIRS list.
 *
 * Usage:
 *   node diagnose-balance.js
 */

require('dotenv').config();
const ccxt = require('ccxt');
const { getTradableBalance } = require('./balance');

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

const n = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};
const fmt = (v) => `$${n(v).toFixed(4)}`;

const SUMMARY_ONLY = process.argv.includes('--summary');

/**
 * Compact, self-contained verdict. Printed LAST (and alone with --summary)
 * so it is always visible in the terminal without scrolling back.
 */
function printSummary(balance) {
  const resolved = getTradableBalance(balance);

  // Build the box programmatically so the borders always line up.
  const LABEL_W = 17;
  const VALUE_W = 26;
  const INNER = 1 + LABEL_W + 3 + VALUE_W + 1;
  const row = (label, value) =>
    `│ ${String(label).padEnd(LABEL_W)} : ${String(value).slice(0, VALUE_W).padEnd(VALUE_W)} │`;

  const title = ' BOT BALANCE VERDICT ';
  console.log(`\n┌─${title}${'─'.repeat(Math.max(0, INNER - title.length - 1))}┐`);
  console.log(row('Collateral asset', resolved.currency));
  console.log(row('Free (tradable)', resolved.free.toFixed(4)));
  console.log(row('Used (margin)', resolved.used.toFixed(4)));
  console.log(row('Total', resolved.total.toFixed(4)));
  console.log(row('Resolved via', resolved.source));
  console.log(`└${'─'.repeat(INNER)}┘`);

  for (const w of resolved.warnings) console.log(`  ⚠️  ${w}`);

  if (resolved.currency === 'BNFCR') {
    console.log('\n  ℹ️  EEA/MiCA account: collateral is BNFCR (1 BNFCR = 1 USD).');
    console.log('     BNFCR margins USDC/USDT pairs, so BTC/USDC etc. work fine.');
  }

  if (resolved.free >= 20) {
    console.log(`\n  ✅ VERDICT: ${resolved.free.toFixed(2)} ${resolved.currency} tradable — above the bot's minimum of 20.`);
    console.log('     Balance detection is working. Start the bot with:');
    console.log('       pm2 restart crypto-bot && pm2 logs crypto-bot');
  } else if (resolved.free > 0) {
    console.log(`\n  ⚠️  VERDICT: ${resolved.free.toFixed(2)} ${resolved.currency} tradable — BELOW the bot's minimum of 20.`);
    console.log('     The bot will skip every cycle until this rises above 20.');
  } else {
    console.log('\n  ❌ VERDICT: no tradable collateral detected.');
    console.log('     On an EEA/MiCA account, swap BTC/ETH/BNB/USDC to BNFCR');
    console.log('     inside your Binance Futures wallet.');
  }

  // Position-sizing reality check against the bot's $10 minimum notional
  if (resolved.free >= 20) {
    const riskPct = 2.0;
    const riskAmt = resolved.free * (riskPct / 100);
    const notional = riskAmt / 0.02; // assumes a ~2% ATR-based stop distance
    console.log(`\n  📐 Sizing check at RISK_PERCENT=${riskPct}%:`);
    console.log(`     Risk per trade ≈ ${riskAmt.toFixed(2)} ${resolved.currency}`);
    console.log(`     With a ~2% ATR stop, notional ≈ ${notional.toFixed(2)} ${resolved.currency}`);
    if (notional < 10) {
      console.log("     ⚠️  Below the bot's $10 minimum notional — most signals will be skipped.");
      console.log('     Consider raising RISK_PERCENT (e.g. to 5.0) or adding funds.');
    } else {
      console.log("     ✅ Above the bot's $10 minimum notional.");
    }
  }
}

async function main() {
  console.log('⏳ Loading markets...');
  await exchange.loadMarkets();

  const balance = await exchange.fetchBalance();
  const info = balance?.info || {};

  // With --summary, print only the verdict and stop.
  if (SUMMARY_ONLY) {
    printSummary(balance);
    return;
  }

  // ── 1. Account-level totals ────────────────────────────────────────────
  console.log('\n═══ ACCOUNT-LEVEL TOTALS ═══');
  const accountFields = [
    'totalWalletBalance',
    'totalUnrealizedProfit',
    'totalMarginBalance',
    'totalPositionInitialMargin',
    'totalOpenOrderInitialMargin',
    'totalInitialMargin',
    'totalMaintMargin',
    'totalCrossWalletBalance',
    'totalCrossUnPnl',
    'availableBalance',
    'maxWithdrawAmount',
  ];
  for (const f of accountFields) {
    if (info[f] !== undefined) {
      console.log(`  ${f.padEnd(30)} ${fmt(info[f])}`);
    }
  }
  if (info.multiAssetsMargin !== undefined) {
    console.log(`  ${'multiAssetsMargin'.padEnd(30)} ${info.multiAssetsMargin}`);
  }

  // ── 2. Per-asset breakdown ─────────────────────────────────────────────
  console.log('\n═══ PER-ASSET BREAKDOWN (non-zero only) ═══');
  const assets = Array.isArray(info.assets) ? info.assets : [];
  let culpritFound = false;

  for (const a of assets) {
    const wallet = n(a.walletBalance);
    const avail = n(a.availableBalance);
    if (wallet === 0 && avail === 0) continue;

    const posMargin = n(a.positionInitialMargin);
    const ordMargin = n(a.openOrderInitialMargin);
    const maint = n(a.maintMargin);
    const unpnl = n(a.unrealizedProfit);
    const locked = Math.max(0, wallet - avail);

    console.log(`\n  ── ${a.asset} ──`);
    console.log(`     walletBalance            ${fmt(wallet)}`);
    console.log(`     availableBalance         ${fmt(avail)}`);
    console.log(`     LOCKED (wallet - avail)  ${fmt(locked)}`);
    console.log(`     ├─ positionInitialMargin  ${fmt(posMargin)}   ← open POSITIONS`);
    console.log(`     ├─ openOrderInitialMargin ${fmt(ordMargin)}   ← open ORDERS`);
    console.log(`     ├─ maintMargin            ${fmt(maint)}`);
    console.log(`     └─ unrealizedProfit       ${fmt(unpnl)}`);
    console.log(`     marginBalance            ${fmt(a.marginBalance)}`);
    console.log(`     crossWalletBalance       ${fmt(a.crossWalletBalance)}`);
    console.log(`     maxWithdrawAmount        ${fmt(a.maxWithdrawAmount)}`);

    if (locked > 0.01) {
      culpritFound = true;
      console.log(`\n     ⚠️  DIAGNOSIS for ${a.asset}:`);
      if (ordMargin > 0.01 && posMargin < 0.01) {
        console.log(`     → Margin is locked by OPEN ORDERS (${fmt(ordMargin)}).`);
        console.log(`       Leftover SL/TP orders are holding your balance.`);
        console.log(`       Fix: node free-margin.js  (now cancels orders on ALL pairs)`);
      } else if (posMargin > 0.01 && ordMargin < 0.01) {
        console.log(`     → Margin is locked by OPEN POSITIONS (${fmt(posMargin)}).`);
        console.log(`       Fix: node free-margin.js --positions`);
      } else if (posMargin > 0.01 && ordMargin > 0.01) {
        console.log(`     → Locked by BOTH positions (${fmt(posMargin)}) and orders (${fmt(ordMargin)}).`);
        console.log(`       Fix: node free-margin.js`);
      } else {
        console.log(`     → No position/order margin reported, yet balance is unavailable.`);
        console.log(`       Likely causes:`);
        console.log(`         a) Single-Asset Mode: ${a.asset} is not the active collateral asset,`);
        console.log(`            so it cannot be used as margin. Enable Multi-Assets Mode,`);
        console.log(`            or convert ${a.asset} to the collateral asset (usually USDT).`);
        console.log(`         b) Funds sit in an ISOLATED margin position on some symbol.`);
        console.log(`         c) Pending settlement / negative balance offset.`);
      }
    }
  }

  if (!culpritFound) {
    console.log('\n  ✅ No locked margin detected at asset level.');
  }

  // ── 3. Multi-Assets Mode check ─────────────────────────────────────────
  console.log('\n═══ MARGIN MODE ═══');
  try {
    const modeRes = await exchange.fapiPrivateGetMultiAssetsMargin();
    const multiOn = modeRes?.multiAssetsMargin === true || modeRes?.multiAssetsMargin === 'true';
    console.log(`  Multi-Assets Mode: ${multiOn ? 'ENABLED' : 'DISABLED (Single-Asset Mode)'}`);
    if (!multiOn) {
      console.log(`\n  ⚠️  You are in SINGLE-ASSET MODE.`);
      console.log(`     In this mode each asset can only margin positions denominated in`);
      console.log(`     that same asset. If your USDC shows walletBalance but 0 available,`);
      console.log(`     and there are no USDC positions/orders, this is very likely the cause.`);
      console.log(`\n     Enable Multi-Assets Mode with:`);
      console.log(`       node diagnose-balance.js --enable-multi-assets`);
      console.log(`     (or in the Binance UI: Futures → Preferences → Multi-Assets Mode)`);
    }
  } catch (err) {
    console.log(`  Could not read margin mode: ${err.message}`);
  }

  // ── 4. ALL open orders across every symbol ─────────────────────────────
  console.log('\n═══ ALL OPEN ORDERS (every symbol) ═══');
  try {
    const allOrders = await exchange.fetchOpenOrders();
    if (allOrders.length === 0) {
      console.log('  None.');
    } else {
      console.log(`  Found ${allOrders.length} open order(s):`);
      for (const o of allOrders) {
        console.log(`    ${o.symbol.padEnd(14)} ${String(o.side).padEnd(5)} ${String(o.type).padEnd(12)} amount=${o.amount} price=${o.price ?? 'mkt'} reduceOnly=${o.reduceOnly ?? '?'} id=${o.id}`);
      }
    }
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // ── 5. ALL positions (raw, non-zero) ───────────────────────────────────
  console.log('\n═══ ALL POSITIONS (non-zero) ═══');
  try {
    const positions = await exchange.fetchPositions();
    const open = positions.filter(p => Math.abs(n(p.contracts)) > 0);
    if (open.length === 0) {
      console.log('  None.');
    } else {
      for (const p of open) {
        console.log(`    ${p.symbol.padEnd(14)} ${String(p.side).padEnd(6)} contracts=${p.contracts} entry=${p.entryPrice} margin=${p.initialMargin ?? '?'} mode=${p.marginMode ?? '?'} lev=${p.leverage ?? '?'}`);
      }
    }
  } catch (err) {
    console.log(`  ❌ ${err.message}`);
  }

  // ── 6. Spot wallet (in case funds are in the wrong wallet) ─────────────
  console.log('\n═══ SPOT WALLET (non-zero) ═══');
  try {
    const spot = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
    const sb = await spot.fetchBalance();
    const rows = Object.entries(sb.total || {}).filter(([, v]) => n(v) > 0);
    if (rows.length === 0) {
      console.log('  Empty.');
    } else {
      for (const [asset, total] of rows) {
        console.log(`    ${asset.padEnd(8)} total=${n(total).toFixed(8)} free=${n(sb.free?.[asset]).toFixed(8)}`);
      }
    }
  } catch (err) {
    console.log(`  Could not read spot wallet: ${err.message}`);
  }

  console.log('\n═══ NEXT STEPS ═══');
  console.log('  1. Look at the LOCKED breakdown above to see which bucket holds your funds.');
  console.log('  2. If openOrderInitialMargin > 0 → run: npm run free-margin');
  console.log('  3. If Single-Asset Mode is the cause → run: npm run enable-multi-assets');
  console.log('  4. If funds are in the SPOT wallet → transfer them to Futures in the Binance UI.');

  // Printed LAST so it survives terminal scrollback.
  printSummary(balance);
}

// ── Optional: enable Multi-Assets Mode ───────────────────────────────────
async function enableMultiAssets() {
  console.log('⏳ Enabling Multi-Assets Mode...');
  try {
    await exchange.fapiPrivatePostMultiAssetsMargin({ multiAssetsMargin: 'true' });
    console.log('✅ Multi-Assets Mode ENABLED. Re-run diagnose-balance.js to confirm.');
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    console.error('   Note: this cannot be changed while you have open positions or orders.');
  }
}

const run = process.argv.includes('--enable-multi-assets')
  ? exchange.loadMarkets().then(enableMultiAssets)
  : main();

run.catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
