/**
 * position-mode.js — Hedge Mode vs One-way Mode awareness.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Binance USDⓈ-M futures accounts run in one of two position modes:
 *
 *   One-way Mode (dualSidePosition = false)
 *     One net position per symbol. Orders must NOT carry positionSide
 *     (or must use 'BOTH'). Closing uses reduceOnly: true.
 *
 *   Hedge Mode (dualSidePosition = true)
 *     Separate LONG and SHORT positions per symbol. EVERY order MUST
 *     carry positionSide = 'LONG' or 'SHORT', otherwise Binance rejects
 *     it with:
 *         -4061 "Order's position side does not match user's setting."
 *
 * Two traps that make this more than a one-line fix:
 *
 *   1. reduceOnly CANNOT be sent in Hedge Mode. Binance rejects it.
 *      In Hedge Mode you close a position by sending the OPPOSITE order
 *      side while keeping positionSide set to the side being closed.
 *      (Confirmed in the CCXT Binance docs: reduceOnly "cant be sent
 *      with close position set to true or in hedge mode".)
 *
 *   2. When closing, positionSide is the side of the POSITION, not of the
 *      order. Closing a LONG means side='sell' with positionSide='LONG'.
 *      Getting this backwards silently opens a new SHORT instead of
 *      closing, which is far worse than an error.
 *
 * The mode is account-wide (not per-symbol), so it is detected once and
 * cached. Call detectPositionMode(exchange) at startup; every helper
 * below falls back to One-way behaviour if detection never ran, which
 * matches the previous behaviour of this bot.
 */

let _hedgeMode = null; // null = not yet detected

/**
 * Query the account's position mode and cache it.
 * Safe to call repeatedly; only the first call hits the API.
 *
 * @returns {Promise<boolean>} true if Hedge Mode is enabled
 */
async function detectPositionMode(exchange, { force = false } = {}) {
  if (_hedgeMode !== null && !force) return _hedgeMode;
  try {
    const res = await exchange.fapiPrivateGetPositionSideDual();
    // Binance returns { dualSidePosition: true } or the string "true"
    const raw = res?.dualSidePosition;
    _hedgeMode = raw === true || String(raw).toLowerCase() === 'true';
  } catch (err) {
    // Don't let detection failure block trading — assume One-way (the
    // previous behaviour) and let the caller log the problem.
    _hedgeMode = false;
    const e = new Error(`Position mode detection failed: ${err.message}`);
    e.detectionFailed = true;
    throw e;
  }
  return _hedgeMode;
}

/** Current cached mode without hitting the API. */
function isHedgeMode() {
  return _hedgeMode === true;
}

/** Human-readable mode name for logs. */
function positionModeName() {
  if (_hedgeMode === null) return 'UNKNOWN (assuming One-way)';
  return _hedgeMode ? 'HEDGE' : 'ONE-WAY';
}

/**
 * Params for OPENING a position.
 *
 * @param {'buy'|'sell'} side
 * @param {object} extra  existing params to merge into (e.g. SL/TP)
 */
function entryParams(side, extra = {}) {
  const params = { ...extra };
  if (isHedgeMode()) {
    params.positionSide = String(side).toLowerCase() === 'buy' ? 'LONG' : 'SHORT';
  }
  return params;
}

/**
 * Params for CLOSING a position.
 *
 * @param {'buy'|'sell'|'long'|'short'} positionSideOrEntrySide
 *        The side of the EXISTING position being closed. Accepts either
 *        the original entry order side ('buy'/'sell') or a position side
 *        ('long'/'short') — both are common in this codebase.
 * @param {object} extra  existing params to merge into
 */
function closeParams(positionSideOrEntrySide, extra = {}) {
  const params = { ...extra };
  const s = String(positionSideOrEntrySide).toLowerCase();
  const isLong = s === 'buy' || s === 'long';

  if (isHedgeMode()) {
    // reduceOnly is rejected in Hedge Mode — positionSide does the work.
    delete params.reduceOnly;
    params.positionSide = isLong ? 'LONG' : 'SHORT';
  } else {
    params.reduceOnly = true;
  }
  return params;
}

/**
 * The order side needed to close a position.
 * @param {'buy'|'sell'|'long'|'short'} positionSideOrEntrySide
 * @returns {'buy'|'sell'}
 */
function closeOrderSide(positionSideOrEntrySide) {
  const s = String(positionSideOrEntrySide).toLowerCase();
  return s === 'buy' || s === 'long' ? 'sell' : 'buy';
}

/** Test seam: force the cached mode without an API call. */
function _setHedgeModeForTests(v) {
  _hedgeMode = v;
}

module.exports = {
  detectPositionMode,
  isHedgeMode,
  positionModeName,
  entryParams,
  closeParams,
  closeOrderSide,
  _setHedgeModeForTests,
};
