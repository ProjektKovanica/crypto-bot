// Test getTradableBalance against real-world account shapes,
// including the user's actual EEA/BNFCR account data.
const { getTradableBalance, detectCollateralAsset } = require('./balance');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = Math.abs(actual - expected) < 0.01;
  console.log(`  ${ok ? '✅' : '❌'} ${name}: got ${actual}, expected ${expected}`);
  ok ? pass++ : fail++;
}
function checkStr(name, actual, expected) {
  const ok = actual === expected;
  console.log(`  ${ok ? '✅' : '❌'} ${name}: got "${actual}", expected "${expected}"`);
  ok ? pass++ : fail++;
}

// ── Case 1: The user's REAL account (EEA/MiCA, BNFCR collateral) ──────────
// Reproduced from their diagnose-balance.js output.
console.log('\n── Case 1: EEA/MiCA account with BNFCR (user\'s real data) ──');
const eeaAccount = {
  info: {
    availableBalance: '29.1215',
    totalMarginBalance: '29.1215',
    totalWalletBalance: '-4.4602',
    totalPositionInitialMargin: '0',
    totalOpenOrderInitialMargin: '0',
    assets: [
      {
        asset: 'U',
        walletBalance: '0.0000',
        availableBalance: '28.8511',
        marginBalance: '0.0000',
        positionInitialMargin: '0',
        openOrderInitialMargin: '0',
      },
      {
        asset: 'BNFCR',
        walletBalance: '-4.4602',
        availableBalance: '29.1215',
        marginBalance: '-4.4602',
        positionInitialMargin: '0',
        openOrderInitialMargin: '0',
      },
    ],
  },
};
const r1 = getTradableBalance(eeaAccount);
console.log('  resolved:', JSON.stringify({ free: r1.free, used: r1.used, total: r1.total, currency: r1.currency, source: r1.source }));
check('free', r1.free, 29.1215);
checkStr('currency', r1.currency, 'BNFCR');
check('used (should be 0, nothing locked)', r1.used, 0);

// ── Case 2: Same account WITHOUT account-level fields (per-asset fallback) ──
console.log('\n── Case 2: BNFCR per-asset fallback (no account-level fields) ──');
const eeaNoAcct = { info: { assets: eeaAccount.info.assets } };
const r2 = getTradableBalance(eeaNoAcct);
console.log('  resolved:', JSON.stringify({ free: r2.free, currency: r2.currency, source: r2.source }));
check('free', r2.free, 29.1215);
checkStr('currency', r2.currency, 'BNFCR');
console.log(`  warnings: ${r2.warnings.length ? r2.warnings.join(' | ') : 'none'}`);

// ── Case 3: Non-EEA account with real USDC collateral ────────────────────
console.log('\n── Case 3: Standard USDC account ──');
const usdcAccount = {
  info: {
    availableBalance: '150.00',
    totalMarginBalance: '200.00',
    assets: [
      { asset: 'USDC', walletBalance: '200.00', availableBalance: '150.00', marginBalance: '200.00' },
    ],
  },
};
const r3 = getTradableBalance(usdcAccount);
check('free', r3.free, 150);
check('used', r3.used, 50);
checkStr('currency', r3.currency, 'USDC');

// ── Case 4: Genuinely locked margin ──────────────────────────────────────
console.log('\n── Case 4: USDC with margin actually locked by a position ──');
const lockedAccount = {
  info: {
    availableBalance: '5.00',
    totalMarginBalance: '100.00',
    assets: [
      { asset: 'USDC', walletBalance: '100.00', availableBalance: '5.00', marginBalance: '100.00', positionInitialMargin: '95.00' },
    ],
  },
};
const r4 = getTradableBalance(lockedAccount);
check('free', r4.free, 5);
check('used', r4.used, 95);

// ── Case 5: Empty account ────────────────────────────────────────────────
console.log('\n── Case 5: Empty account (should warn) ──');
const empty = { info: { availableBalance: '0', totalMarginBalance: '0', assets: [] } };
const r5 = getTradableBalance(empty);
check('free', r5.free, 0);
console.log(`  warnings present: ${r5.warnings.length > 0 ? 'yes ✅' : 'no ❌'}`);
r5.warnings.length > 0 ? pass++ : fail++;

// ── Case 6: CCXT normalised map only ─────────────────────────────────────
console.log('\n── Case 6: CCXT normalised map fallback ──');
const ccxtOnly = { info: {}, USDC: { free: 42.5, used: 7.5, total: 50 } };
const r6 = getTradableBalance(ccxtOnly);
check('free', r6.free, 42.5);
checkStr('currency', r6.currency, 'USDC');

// ── Case 7: detectCollateralAsset prefers BNFCR ──────────────────────────
console.log('\n── Case 7: collateral detection priority ──');
checkStr('detects BNFCR', detectCollateralAsset(eeaAccount), 'BNFCR');
checkStr('detects USDC', detectCollateralAsset(usdcAccount), 'USDC');

console.log(`\n${'═'.repeat(50)}`);
console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
console.log('═'.repeat(50));
process.exit(fail > 0 ? 1 : 0);
