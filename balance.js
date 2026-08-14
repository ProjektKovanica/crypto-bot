/**
 * balance.js
 *
 * Centralised, collateral-aware balance detection for Binance Futures.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The bot originally looked only for an asset literally named "USDC" in
 * balance.info.assets. That breaks on EEA / MiCA accounts.
 *
 * Under MiCA, Binance moved European Economic Area users onto
 * "Binance Futures Credits Trading Mode". In that mode:
 *
 *   - Collateral is held as BNFCR ("Binance Credit"), pegged 1:1 to USD.
 *   - USDT/USDC cannot be used directly as futures collateral.
 *   - All PNL, margin and fees for USDT/USDC contracts display as BNFCR.
 *   - The account runs Cross Margin + Multi-Assets Mode only.
 *   - BNFCR still margins USDT/USDC-denominated pairs (e.g. BTC/USDC).
 *
 * So an EEA account has NO USDC asset entry at all, and the old lookup
 * returned 0 free balance, making the bot think it had no funds.
 *
 * STRATEGY
 * ────────
 * 1. Prefer the ACCOUNT-LEVEL availableBalance. In Cross + Multi-Assets
 *    Mode (which BNFCR mandates) this is the authoritative figure for how
 *    much can actually be used as margin, expressed in USD terms.
 * 2. Fall back to a per-asset scan in priority order (BNFCR, USDC, USDT...).
 * 3. Fall back to CCXT's normalised free/used/total maps.
 */

// Collateral assets in priority order. BNFCR first so EEA/MiCA accounts
// resolve correctly, then MiCA-compliant USDC, then legacy USDT.
const COLLATERAL_PRIORITY = ['BNFCR', 'USDC', 'USDT', 'FDUSD', 'BUSD'];

function num(v) {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}

/**
 * Detect which collateral asset this account actually uses.
 * Returns the asset code, or null if none of the known ones are present.
 */
function detectCollateralAsset(balance) {
  const assets = balance?.info?.assets;
  if (!Array.isArray(assets)) return null;

  for (const code of COLLATERAL_PRIORITY) {
    const a = assets.find(x => String(x.asset).toUpperCase() === code);
    if (!a) continue;
    // Treat as the collateral asset if it has any wallet balance or availability
    if (num(a.walletBalance) !== 0 || num(a.availableBalance) !== 0 || num(a.marginBalance) !== 0) {
      return code;
    }
  }
  return null;
}

/**
 * Resolve the usable (free) margin balance for this futures account.
 *
 * @param {object} balance - result of exchange.fetchBalance()
 * @returns {{ free:number, used:number, total:number, currency:string, source:string, warnings:string[] }}
 */
function getTradableBalance(balance) {
  const info = balance?.info || {};
  const warnings = [];
  const currency = detectCollateralAsset(balance) || 'USD';

  // ── 1. Account-level figures (authoritative under Cross + Multi-Assets) ──
  const acctAvail = num(info.availableBalance);
  const acctMargin = num(info.totalMarginBalance);
  const acctWallet = num(info.totalWalletBalance);
  const acctTotal = acctMargin || acctWallet;

  if (acctAvail > 0 || acctTotal > 0) {
    const used = Math.max(0, acctTotal - acctAvail);
    return {
      free: acctAvail,
      used,
      total: acctTotal,
      currency,
      source: 'info.availableBalance (account-level)',
      warnings,
    };
  }

  // ── 2. Per-asset scan in priority order ─────────────────────────────────
  const assets = Array.isArray(info.assets) ? info.assets : [];
  for (const code of COLLATERAL_PRIORITY) {
    const a = assets.find(x => String(x.asset).toUpperCase() === code);
    if (!a) continue;

    const free = num(a.availableBalance);
    const wallet = num(a.walletBalance);
    const marginBal = num(a.marginBalance);
    const total = marginBal || wallet;

    if (free > 0 || total > 0) {
      if (wallet < 0) {
        warnings.push(
          `${code} walletBalance is negative ($${wallet.toFixed(4)}). ` +
          `This usually means unsettled fees or a funding debt.`
        );
      }
      return {
        free,
        used: Math.max(0, total - free),
        total,
        currency: code,
        source: `info.assets.${code}`,
        warnings,
      };
    }
  }

  // ── 3. CCXT normalised maps ─────────────────────────────────────────────
  for (const code of COLLATERAL_PRIORITY) {
    const entry = balance?.[code];
    if (!entry) continue;
    const free = num(entry.free);
    const total = num(entry.total);
    if (free > 0 || total > 0) {
      return {
        free,
        used: num(entry.used),
        total,
        currency: code,
        source: `ccxt.${code}`,
        warnings,
      };
    }
  }

  warnings.push(
    'No usable collateral detected. On an EEA/MiCA account you must hold BNFCR: ' +
    'swap BTC/ETH/BNB/USDC to BNFCR inside your Binance Futures wallet.'
  );

  return { free: 0, used: 0, total: 0, currency, source: 'none', warnings };
}

module.exports = { getTradableBalance, detectCollateralAsset, COLLATERAL_PRIORITY };
