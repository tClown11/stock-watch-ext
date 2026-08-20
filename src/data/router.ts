import type { DataSource, Quote, Trends, Kline, SearchHit } from './types';
import { tencent } from './tencent';
import { sina } from './sina';
import { eastmoney } from './eastmoney';
import { ths } from './ths';
import { mock } from './mock';
import { getFundQuotes, maybeFund } from './fund';
import {
  getCryptoQuotes,
  getCryptoTrends,
  getCryptoKline,
  searchCrypto,
  isCrypto,
  lastCryptoSources,
} from './crypto';

// ── 多源智能路由 ──────────────────────────────────────────────────────────────
// 报价：腾讯(全市场,~0.2s,不限流) → 新浪(~40ms,DNR补Referer) → 东财(限流,兜底)
//       逐源只补上一源缺失的 secid，最终合并——单源缺个别标的不影响整体速度。
// 分时/K线：腾讯 → 东财（美股盘前腾讯分时为空，自动落到东财）。
// 搜索：同花顺(实时,CORS开放) → 腾讯 smartbox → 东财。
// 币圈（`crypto.*`）：走 data/crypto.ts 的币安 → Coinbase → CoinGecko 链，
//       与股票链并行发起——两边互不阻塞，整体耗时取较慢的一条。
// mock 仅在全部真实源失败（离线）时使用，并通过 lastSource 标记出来。

const TIMEOUT = 4000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export type SourceName =
  | 'tencent'
  | 'sina'
  | 'eastmoney'
  | 'ths'
  | 'fund'
  | 'binance'
  | 'coinbase'
  | 'coingecko'
  | 'mock';
export const SOURCE_LABEL: Record<SourceName, string> = {
  tencent: '腾讯',
  sina: '新浪',
  eastmoney: '东方财富',
  ths: '同花顺',
  fund: '天天基金',
  binance: '币安',
  coinbase: 'Coinbase',
  coingecko: 'CoinGecko',
  mock: '示例数据',
};

/** 最近一次成功报价用到的源（按参与顺序），供 UI 展示。 */
export let lastQuoteSources: SourceName[] = [];
export const isOffline = () => lastQuoteSources.length === 1 && lastQuoteSources[0] === 'mock';

const QUOTE_CHAIN: Array<{ name: SourceName; src: DataSource }> = [
  { name: 'tencent', src: tencent },
  { name: 'sina', src: sina },
  { name: 'eastmoney', src: eastmoney },
];

interface Leg {
  got: Map<string, Quote>;
  used: SourceName[];
}

/** 币圈腿：整条链在 data/crypto.ts 里，这里只负责超时与源名回传。 */
async function cryptoLeg(secids: string[]): Promise<Leg> {
  const got = new Map<string, Quote>();
  if (!secids.length) return { got, used: [] };
  try {
    const rows = await withTimeout(getCryptoQuotes(secids));
    for (const q of rows) got.set(q.secid, q);
    return { got, used: rows.length ? [...lastCryptoSources] : [] };
  } catch (e) {
    console.info('[data] crypto quotes failed:', e);
    return { got, used: [] };
  }
}

async function stockLeg(secids: string[]): Promise<Leg> {
  const got = new Map<string, Quote>();
  const used: SourceName[] = [];
  if (!secids.length) return { got, used };
  let missing = secids;
  for (const { name, src } of QUOTE_CHAIN) {
    if (!missing.length) break;
    try {
      const rows = await withTimeout(src.getQuotes(missing));
      if (rows.length) used.push(name);
      for (const q of rows) got.set(q.secid, q);
      missing = secids.filter((s) => !got.has(s));
    } catch (e) {
      // 单源失败属常态（限流/瞬时网络抖动），自动切下一源即可；
      // 用 info 而非 warn——warn 会被 Chrome 收进扩展「错误」页，误报吓人。
      console.info(`[data] quotes via ${name} failed, falling back:`, e);
    }
  }
  // 场外基金兜底：股票行情源都查不到的沪深 6 位代码，按基金取净值/估值
  //（如 020839 这类申购赎回制基金，无实时行情，UI 侧以净值日期标注）。
  if (missing.some(maybeFund)) {
    try {
      const rows = await withTimeout(getFundQuotes(missing));
      if (rows.length) used.push('fund');
      for (const q of rows) got.set(q.secid, q);
      missing = secids.filter((s) => !got.has(s));
    } catch (e) {
      console.info('[data] fund nav fallback failed:', e);
    }
  }
  return { got, used };
}

export async function getQuotes(secids: string[]): Promise<Quote[]> {
  if (!secids.length) return [];
  // 股票腿与币圈腿并行：币安慢的时候不拖累 A 股首屏，反之亦然。
  const [stock, crypto] = await Promise.all([
    stockLeg(secids.filter((s) => !isCrypto(s))),
    cryptoLeg(secids.filter(isCrypto)),
  ]);
  const got = new Map([...stock.got, ...crypto.got]);
  if (!got.size) {
    // 全部真实源失败 → 离线示例数据（UI 会标注）。这才是值得上报的异常。
    console.error('[data] all quote sources failed, serving mock data');
    const rows = await mock.getQuotes(secids);
    lastQuoteSources = ['mock'];
    return rows;
  }
  lastQuoteSources = [...stock.used, ...crypto.used];
  return secids.map((s) => got.get(s)).filter((q): q is Quote => !!q);
}

/**
 * 美股分时时间归一：东财返回北京时间（21:30–04:00）、腾讯返回美东（09:30–16:00）。
 * 以首个数据点锚定美东开盘 09:30，整体平移（跨午夜取模），自动适配冬夏令时。
 */
function normalizeUsTrends(t: Trends): Trends {
  if (!t.points.length) return t;
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const offset = (toMin(t.points[0].t) - 570 + 1440) % 1440;
  if (!offset) return t;
  const fmt = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  return { ...t, points: t.points.map((p) => ({ ...p, t: fmt((toMin(p.t) - offset + 1440) % 1440) })) };
}

export async function getTrends(secid: string): Promise<Trends> {
  if (isCrypto(secid)) {
    try {
      return await withTimeout(getCryptoTrends(secid));
    } catch (e) {
      if (isOffline()) return mock.getTrends(secid);
      throw e;
    }
  }
  const chain: Array<{ name: SourceName; src: DataSource }> = [
    { name: 'tencent', src: tencent },
    { name: 'eastmoney', src: eastmoney },
  ];
  const isUs = /^10[567]\./.test(secid);
  // 美股：腾讯分时未开盘时为空，东财返回上一交易日，体验更稳 → 东财优先。
  if (isUs) chain.reverse();
  let lastErr: unknown;
  for (const { name, src } of chain) {
    try {
      const t = await withTimeout(src.getTrends(secid));
      if (t.points.length) return isUs ? normalizeUsTrends(t) : t;
    } catch (e) {
      lastErr = e;
      console.info(`[data] trends via ${name} failed, falling back:`, e);
    }
  }
  if (isOffline()) return mock.getTrends(secid);
  throw lastErr ?? new Error('trends unavailable');
}

export async function getKline(secid: string, klt: 101 | 102 | 103): Promise<Kline[]> {
  if (isCrypto(secid)) {
    try {
      return await withTimeout(getCryptoKline(secid, klt));
    } catch (e) {
      if (isOffline()) return mock.getKline(secid, klt);
      throw e;
    }
  }
  const chain: Array<{ name: SourceName; src: DataSource }> = [
    { name: 'tencent', src: tencent },
    { name: 'eastmoney', src: eastmoney },
  ];
  let lastErr: unknown;
  for (const { name, src } of chain) {
    try {
      const k = await withTimeout(src.getKline(secid, klt));
      if (k.length) return k;
    } catch (e) {
      lastErr = e;
      console.info(`[data] kline via ${name} failed, falling back:`, e);
    }
  }
  if (isOffline()) return mock.getKline(secid, klt);
  throw lastErr ?? new Error('kline unavailable');
}

/** 东财搜索走 service worker 的注入函数（popup 环境由 popup 注入）。 */
export type SearchFn = (q: string) => Promise<SearchHit[]>;

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  return hits.filter((h) => !seen.has(h.secid) && seen.add(h.secid));
}

export async function search(q: string, emSearch?: SearchFn): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];
  // 币种目录是本地常量（零延迟、离线可用），命中就排在股票结果前面。
  const coins = searchCrypto(query);
  const chain: Array<{ name: SourceName; fn: SearchFn }> = [
    { name: 'ths', fn: (x) => ths.search(x) },
    { name: 'tencent', fn: (x) => tencent.search(x) },
    { name: 'eastmoney', fn: emSearch ?? ((x) => eastmoney.search(x)) },
  ];
  for (const { name, fn } of chain) {
    try {
      const hits = await withTimeout(fn(query));
      if (hits.length) return dedupe([...coins, ...hits]);
    } catch (e) {
      console.info(`[data] search via ${name} failed, falling back:`, e);
    }
  }
  if (isOffline()) return dedupe([...coins, ...(await mock.search(query))]);
  return coins;
}
