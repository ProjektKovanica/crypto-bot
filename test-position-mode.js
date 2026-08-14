const pm = require('./position-mode');
const { entryParams, closeParams, closeOrderSide, _setHedgeModeForTests } = pm;

let pass = 0, fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  const ok = a === e;
  console.log(`  ${ok ? '✅' : '❌'} ${name}\n       got      ${a}\n       expected ${e}`);
  ok ? pass++ : fail++;
}

// ─────────────────────────────────────────────────────────────────
console.log('\n── ONE-WAY MODE ──');
_setHedgeModeForTests(false);

eq('entry buy: no positionSide',
  entryParams('buy', { stopLossPrice: 100 }),
  { stopLossPrice: 100 });

eq('entry sell: no positionSide',
  entryParams('sell', {}),
  {});

eq('close a LONG: reduceOnly, no positionSide',
  closeParams('buy'),
  { reduceOnly: true });

eq('close a SHORT: reduceOnly, no positionSide',
  closeParams('short'),
  { reduceOnly: true });

// ─────────────────────────────────────────────────────────────────
console.log('\n── HEDGE MODE ──');
_setHedgeModeForTests(true);

eq('entry buy → positionSide LONG',
  entryParams('buy', { stopLossPrice: 100, takeProfitPrice: 200 }),
  { stopLossPrice: 100, takeProfitPrice: 200, positionSide: 'LONG' });

eq('entry sell → positionSide SHORT',
  entryParams('sell', {}),
  { positionSide: 'SHORT' });

// The critical ones: closing must use the POSITION's side, not the order's.
eq('close a LONG → positionSide LONG (NOT SHORT)',
  closeParams('buy'),
  { positionSide: 'LONG' });

eq('close a SHORT → positionSide SHORT (NOT LONG)',
  closeParams('sell'),
  { positionSide: 'SHORT' });

eq('accepts "long" as well as "buy"',
  closeParams('long'),
  { positionSide: 'LONG' });

eq('accepts "short" as well as "sell"',
  closeParams('short'),
  { positionSide: 'SHORT' });

// reduceOnly is rejected by Binance in hedge mode — must be stripped.
eq('strips a pre-existing reduceOnly',
  closeParams('long', { reduceOnly: true }),
  { positionSide: 'LONG' });

// ─────────────────────────────────────────────────────────────────
console.log('\n── CLOSE ORDER SIDE (mode-independent) ──');
eq('close a long → sell', closeOrderSide('long'), 'sell');
eq('close a buy  → sell', closeOrderSide('buy'), 'sell');
eq('close a short → buy', closeOrderSide('short'), 'buy');
eq('close a sell  → buy', closeOrderSide('sell'), 'buy');

// ─────────────────────────────────────────────────────────────────
// A wrong positionSide on a close would OPEN a new opposite position
// instead of closing. Assert side and positionSide never contradict.
console.log('\n── SAFETY: close orders must not flip direction ──');
_setHedgeModeForTests(true);
for (const posSide of ['long', 'short']) {
  const orderSide = closeOrderSide(posSide);
  const params = closeParams(posSide);
  const expectedPS = posSide.toUpperCase();
  const ok = params.positionSide === expectedPS
    && orderSide === (posSide === 'long' ? 'sell' : 'buy')
    && !('reduceOnly' in params);
  console.log(`  ${ok ? '✅' : '❌'} closing a ${posSide.toUpperCase()}: side=${orderSide} positionSide=${params.positionSide}`);
  ok ? pass++ : fail++;
}

// ─────────────────────────────────────────────────────────────────
console.log('\n── UNDETECTED MODE falls back to One-way ──');
_setHedgeModeForTests(null);
eq('entry has no positionSide when mode unknown', entryParams('buy'), {});
eq('close uses reduceOnly when mode unknown', closeParams('long'), { reduceOnly: true });
console.log(`  ℹ️  positionModeName() = "${pm.positionModeName()}"`);

// ─────────────────────────────────────────────────────────────────
console.log('\n── detectPositionMode parses Binance responses ──');
(async () => {
  const cases = [
    [{ dualSidePosition: true }, true, 'boolean true'],
    [{ dualSidePosition: 'true' }, true, 'string "true"'],
    [{ dualSidePosition: false }, false, 'boolean false'],
    [{ dualSidePosition: 'false' }, false, 'string "false"'],
  ];
  for (const [res, expected, label] of cases) {
    _setHedgeModeForTests(null);
    const fakeExchange = { fapiPrivateGetPositionSideDual: async () => res };
    const got = await pm.detectPositionMode(fakeExchange, { force: true });
    const ok = got === expected;
    console.log(`  ${ok ? '✅' : '❌'} ${label} → ${got}`);
    ok ? pass++ : fail++;
  }

  // Detection failure must throw but still leave a safe One-way fallback.
  _setHedgeModeForTests(null);
  const boom = { fapiPrivateGetPositionSideDual: async () => { throw new Error('bad API key'); } };
  let threw = false;
  try { await pm.detectPositionMode(boom, { force: true }); } catch (e) { threw = e.detectionFailed === true; }
  console.log(`  ${threw ? '✅' : '❌'} detection failure throws with detectionFailed flag`);
  threw ? pass++ : fail++;
  const safe = !('positionSide' in entryParams('buy'));
  console.log(`  ${safe ? '✅' : '❌'} after failure, entries omit positionSide (One-way fallback)`);
  safe ? pass++ : fail++;

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log('═'.repeat(52));
  process.exit(fail > 0 ? 1 : 0);
})();
