import type { Market } from './types';

// Eastmoney encodes the exchange as a numeric prefix in `市场.代码`.
//   1   = 上交所 (SH)      0   = 深交所 (SZ)
//   116 = 港交所 (HK)      105/106/107 = 美股 (NASDAQ/NYSE/AMEX)
//   100 = 全球指数 (恒生/纳指等)
const MKT_FROM_PREFIX: Record<string, Market> = {
  '0': 'SZ',
  '1': 'SH',
  '116': 'HK',
  '105': 'US',
  '106': 'US',
  '107': 'US',
  '100': 'US', // global indices bucket — only used for the index strip
  '128': 'HK',
  '153': 'HK',
};

export function marketFromPrefix(prefix: string | number): Market {
  return MKT_FROM_PREFIX[String(prefix)] ?? 'SH';
}

/**
 * Best-effort secid when we only have market + code (e.g. hand-typed).
 * Prefer the secid returned by search(), which resolves the US exchange exactly.
 */
export function toSecid(market: Market, code: string): string {
  switch (market) {
    case 'SH':
      return `1.${code}`;
    case 'SZ':
      return `0.${code}`;
    case 'HK':
      return `116.${code}`;
    case 'US':
      return `105.${code}`;
  }
}

export function splitSecid(secid: string): { prefix: string; code: string; market: Market } {
  const dot = secid.indexOf('.');
  const prefix = dot >= 0 ? secid.slice(0, dot) : '1';
  const code = dot >= 0 ? secid.slice(dot + 1) : secid;
  return { prefix, code, market: marketFromPrefix(prefix) };
}
