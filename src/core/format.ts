/** Fixed-decimal, thousands-grouped number (matches the design's `fmt`). */
export function fmt(v: number, d: number): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Signed variant (`+`/`-`) — used for changes and P&L. */
export function sgn(v: number, d: number): string {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + fmt(v, d);
}

/** Design rule: sub-¥10 instruments show 3 decimals, otherwise 2. */
export function decimalsFor(price: number): number {
  return price < 10 ? 3 : 2;
}

/**
 * 加密货币精度：$1 以上跟交易所一样 2 位（BTC 68,955.21 / SOL 84.35），
 * 小额币种按数量级放宽，否则 DOGE、SHIB 之类会被截成 0.000。
 */
export function decimalsForCrypto(price: number): number {
  const a = Math.abs(price);
  if (!Number.isFinite(a) || a >= 1) return 2;
  return a >= 0.01 ? 4 : 6;
}

/** 成交量: 手 → 万手 */
export function volWan(handsShares: number | undefined): string {
  if (handsShares == null) return '—';
  return fmt(handsShares / 1e4, 1) + ' 万手';
}

/** 元 → 亿 */
export function yi(yuan: number | undefined, d = 2): string {
  if (yuan == null) return '—';
  return fmt(yuan / 1e8, d) + ' 亿';
}

export function pct(v: number | undefined, d = 2): string {
  if (v == null) return '—';
  return fmt(v, d) + '%';
}
