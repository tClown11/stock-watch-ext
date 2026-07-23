import type { DataSource, Quote, SearchHit, Market } from './types';

// Ported verbatim from the original 股票盯盘助手.dc.html mock so the preview
// harness and the offline fallback render exactly like the approved design.
interface Row {
  n: string;
  c: string;
  m: Market;
  p: number;
  pv: number;
  hold?: { s: number; co: number };
  tech?: boolean;
  star?: boolean;
  etf?: boolean;
  py?: string;
}

const SECID: Record<Market, (c: string) => string> = {
  SH: (c) => `1.${c}`,
  SZ: (c) => `0.${c}`,
  HK: (c) => `116.${c}`,
  US: (c) => `105.${c}`,
};
const secidOf = (r: Row) => SECID[r.m](r.c);

const RAW: Row[] = [
  { n: '贵州茅台', c: '600519', m: 'SH', p: 1685.2, pv: 1662.0, hold: { s: 100, co: 1720 }, star: true },
  { n: '宁德时代', c: '300750', m: 'SZ', p: 268.5, pv: 255.8, hold: { s: 200, co: 210 }, tech: true },
  { n: '比亚迪', c: '002594', m: 'SZ', p: 268.0, pv: 272.4, hold: { s: 300, co: 255 }, tech: true },
  { n: '中国平安', c: '601318', m: 'SH', p: 52.3, pv: 51.1, hold: { s: 500, co: 49.5 } },
  { n: '招商银行', c: '600036', m: 'SH', p: 39.8, pv: 40.2 },
  { n: '隆基绿能', c: '601012', m: 'SH', p: 15.6, pv: 15.2, tech: true },
  { n: '东方财富', c: '300059', m: 'SZ', p: 16.88, pv: 17.3, hold: { s: 1000, co: 14.2 }, tech: true },
  { n: '京东方A', c: '000725', m: 'SZ', p: 4.32, pv: 4.28, tech: true },
  { n: '腾讯控股', c: '00700', m: 'HK', p: 402.6, pv: 395.0, hold: { s: 100, co: 360 } },
  { n: '美团-W', c: '03690', m: 'HK', p: 128.4, pv: 131.2 },
  { n: '小米集团-W', c: '01810', m: 'HK', p: 22.85, pv: 21.9, tech: true },
  { n: '苹果', c: 'AAPL', m: 'US', p: 232.5, pv: 229.8, tech: true },
  { n: '英伟达', c: 'NVDA', m: 'US', p: 138.2, pv: 135.6, hold: { s: 50, co: 120 }, tech: true },
  { n: '特斯拉', c: 'TSLA', m: 'US', p: 245.3, pv: 251.0, tech: true },
  { n: '沪深300ETF', c: '510300', m: 'SH', p: 3.985, pv: 3.96, etf: true },
  { n: '科创50ETF', c: '588000', m: 'SH', p: 0.892, pv: 0.905, etf: true, tech: true },
];

const POOL: Row[] = [
  { n: '五粮液', c: '000858', m: 'SZ', p: 138.5, pv: 136.2, py: 'wuliangye' },
  { n: '中芯国际', c: '688981', m: 'SH', p: 52.8, pv: 51.4, py: 'zhongxinguoji' },
  { n: '山西汾酒', c: '600809', m: 'SH', p: 195.3, pv: 198.1, py: 'shanxifenjiu' },
  { n: '工商银行', c: '601398', m: 'SH', p: 6.12, pv: 6.08, py: 'gongshangyinhang' },
  { n: '长江电力', c: '600900', m: 'SH', p: 28.9, pv: 28.6, py: 'changjiangdianli' },
  { n: '药明康德', c: '603259', m: 'SH', p: 62.4, pv: 64.1, py: 'yaomingkangde' },
  { n: '立讯精密', c: '002475', m: 'SZ', p: 42.1, pv: 41.3, py: 'lixunjingmi' },
  { n: '中国中免', c: '601888', m: 'SH', p: 68.3, pv: 70.2, py: 'zhongguozhongmian' },
  { n: '阿里巴巴', c: '09988', m: 'HK', p: 82.5, pv: 80.3, py: 'alibaba' },
  { n: '拼多多', c: 'PDD', m: 'US', p: 138.9, pv: 142.5, py: 'pinduoduo' },
  { n: '微软', c: 'MSFT', m: 'US', p: 448.2, pv: 445.1, py: 'microsoft' },
  { n: '纳指100ETF', c: '513100', m: 'SH', p: 1.52, pv: 1.505, etf: true, py: 'nazhietf' },
];

const ALL = [...RAW, ...POOL];
const bySecid = new Map(ALL.map((r) => [secidOf(r), r]));

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function series(code: string, open: number, close: number, hi: number, lo: number, n: number) {
  const r = rng(hash(code));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const base = open + (close - open) * f;
    const noise = (r() - 0.5) * (hi - lo) * 0.7;
    pts.push(base + noise);
  }
  pts[0] = open;
  pts[n - 1] = close;
  return pts.map((v) => Math.max(lo, Math.min(hi, v)));
}

function quoteOf(r: Row): Quote {
  const h = hash(r.c);
  const openV = r.pv * (1 + (rng(hash(r.c + 'o'))() - 0.5) * 0.008);
  const hi = Math.max(openV, r.p) * (1 + (0.004 + (h % 40) / 4000));
  const lo = Math.min(openV, r.p) * (1 - (0.004 + (h % 37) / 4000));
  const volLots = (h % 600) + 80; // 万手
  return {
    secid: secidOf(r),
    code: r.c,
    market: r.m,
    name: r.n,
    price: r.p,
    prevClose: r.pv,
    changeAmt: r.p - r.pv,
    changePct: ((r.p - r.pv) / r.pv) * 100,
    open: openV,
    high: hi,
    low: lo,
    volume: volLots * 10000,
    amount: volLots * 10000 * r.p * (r.m === 'US' ? 0.02 : 0.002),
    amplitude: ((hi - lo) / r.pv) * 100,
    turnover: (h % 700) / 100 + 0.3,
    pe: (h % 2600) / 100 + 8,
    pb: ((h >> 3) % 420) / 100 + 0.8,
    mcap: r.p * ((h % 900) + 40) * (r.p > 200 ? 12 : 3) * 1e8,
    high52: hi * 1.18,
    low52: lo * 0.7,
  };
}

const delay = <T>(v: T) => new Promise<T>((res) => setTimeout(() => res(v), 120));

export const mock: DataSource = {
  async getQuotes(secids) {
    return delay(secids.map((s) => bySecid.get(s)).filter((r): r is Row => !!r).map(quoteOf));
  },
  async getTrends(secid) {
    const r = bySecid.get(secid);
    if (!r) return delay({ secid, prevClose: 0, points: [] });
    const q = quoteOf(r);
    const pts = series(r.c, q.open!, r.p, q.high!, q.low!, 72);
    let run = 0;
    const points = pts.map((price, i) => {
      run += price;
      const mins = 9 * 60 + 30 + Math.floor((i / (pts.length - 1)) * 330);
      const t = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      return { t, price, avg: run / (i + 1), vol: 0 };
    });
    return delay({ secid, prevClose: r.pv, points });
  },
  async getKline(secid, _klt) {
    const r = bySecid.get(secid);
    if (!r) return delay([]);
    const pts = series(r.c + 'k', r.pv * 0.94, r.p, r.p * 1.05, r.pv * 0.9, 60);
    return delay(
      pts.map((close, i) => {
        const open = i ? pts[i - 1] : r.pv * 0.94;
        return {
          date: `2026-${String(5 + Math.floor(i / 22)).padStart(2, '0')}-${String((i % 22) + 1).padStart(2, '0')}`,
          open,
          close,
          high: Math.max(open, close) * 1.01,
          low: Math.min(open, close) * 0.99,
          vol: 0,
          amount: 0,
        };
      })
    );
  },
  async search(input) {
    const q = input.trim().toLowerCase();
    const hits = ALL.filter(
      (r) => !q || r.n.toLowerCase().includes(q) || r.c.toLowerCase().includes(q) || (r.py || '').includes(q)
    );
    return delay(
      hits.map((r): SearchHit => ({ secid: secidOf(r), code: r.c, market: r.m, name: r.n, etf: r.etf }))
    );
  },
};

/** Custom groups seeded on first install (mirrors the design). */
export const DEFAULT_GROUPS = ['科技成长', '港美股', '白酒消费'];

// code → default group membership (design's groupOf).
const GROUP_OF: Record<string, string[]> = {
  '600519': ['白酒消费'],
  '300750': ['科技成长'],
  '002594': ['科技成长', '港美股'],
  '601012': ['科技成长'],
  '300059': ['科技成长'],
  '000725': ['科技成长'],
  '00700': ['港美股'],
  '03690': ['港美股'],
  '01810': ['科技成长', '港美股'],
  AAPL: ['港美股'],
  NVDA: ['科技成长', '港美股'],
  TSLA: ['港美股'],
  '588000': ['科技成长'],
};

/** Default watch list seeded on first install (mirrors the design). */
export const DEFAULT_WATCHLIST = RAW.map((r) => ({
  secid: secidOf(r),
  code: r.c,
  market: r.m,
  name: r.n,
  hold: r.hold ? { shares: r.hold.s, cost: r.hold.co } : undefined,
  star: r.star,
  etf: r.etf,
  groups: GROUP_OF[r.c] ? [...GROUP_OF[r.c]] : undefined,
}));
