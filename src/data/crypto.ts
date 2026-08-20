// 币圈行情 — BTC / ETH / SOL 等加密货币的报价、24h 分时与 K 线。
//
// secid 沿用「市场.代码」形态，市场段用非数字前缀 `crypto`（如 `crypto.BTC`），
// 与东财的数字市场号天然不冲突，router 据此把这批标的分流到本模块，
// 不会浪费一次腾讯/新浪/东财请求。
//
// 多源链（与股票行情一样逐源补齐缺口，2026-08 实测）：
//   1. 币安公开行情镜像 data-api.binance.vision —— 唯一同时给「批量 24h 报价 +
//      K 线」的源，一次请求拿全所有币种；api.binance.com 对部分地区返回 451，
//      这个只读镜像不做地域限制，无鉴权、CORS 全开。
//   2. Coinbase Exchange api.exchange.coinbase.com —— 逐币种 stats/candles，
//      币安不可达时兜底（美元计价，与 USDT 价差通常 <0.1%）。
//   3. CoinGecko api.coingecko.com —— 只给现价与 24h 涨跌，作为最后的报价兜底。
//
// 涨跌口径：加密货币 7×24 无收盘价，全行业统一用「滚动 24 小时」——
// 因此 prevClose 存 24 小时前的价格，changePct 即 24h 涨跌幅。
import type { Quote, Trends, Kline, SearchHit, TrendPoint } from './types';

const BINANCE = 'https://data-api.binance.vision/api/v3';
const COINBASE = 'https://api.exchange.coinbase.com';
const COINGECKO = 'https://api.coingecko.com/api/v3';

export interface Coin {
  sym: string; // BTC
  name: string; // 比特币
  gecko: string; // CoinGecko id
  alias: string[]; // 搜索别名（全小写）
}

/** 支持的币种目录。搜索/添加只认这里的币，保证三个源的符号映射都成立。 */
export const CRYPTO_COINS: Coin[] = [
  { sym: 'BTC', name: '比特币', gecko: 'bitcoin', alias: ['btc', 'bitcoin', 'bit', 'bitebi', 'dabing'] },
  { sym: 'ETH', name: '以太坊', gecko: 'ethereum', alias: ['eth', 'ethereum', 'yitaifang'] },
  { sym: 'SOL', name: 'Solana', gecko: 'solana', alias: ['sol', 'solana', 'suolana'] },
  { sym: 'BNB', name: '币安币', gecko: 'binancecoin', alias: ['bnb', 'binance', 'bianbi'] },
  { sym: 'XRP', name: '瑞波币', gecko: 'ripple', alias: ['xrp', 'ripple', 'ruibo'] },
  { sym: 'DOGE', name: '狗狗币', gecko: 'dogecoin', alias: ['doge', 'dogecoin', 'gougoubi'] },
  { sym: 'ADA', name: '艾达币', gecko: 'cardano', alias: ['ada', 'cardano', 'aidabi'] },
  { sym: 'AVAX', name: '雪崩', gecko: 'avalanche-2', alias: ['avax', 'avalanche', 'xuebeng'] },
  { sym: 'LINK', name: 'Chainlink', gecko: 'chainlink', alias: ['link', 'chainlink'] },
  { sym: 'LTC', name: '莱特币', gecko: 'litecoin', alias: ['ltc', 'litecoin', 'laitebi'] },
  { sym: 'TON', name: 'Toncoin', gecko: 'the-open-network', alias: ['ton', 'toncoin'] },
  { sym: 'TRX', name: '波场', gecko: 'tron', alias: ['trx', 'tron', 'bochang'] },
  { sym: 'DOT', name: '波卡', gecko: 'polkadot', alias: ['dot', 'polkadot', 'boka'] },
  { sym: 'SUI', name: 'Sui', gecko: 'sui', alias: ['sui'] },
];

const BY_SYM = new Map(CRYPTO_COINS.map((c) => [c.sym, c]));

const PREFIX = 'crypto.';
export const isCrypto = (secid: string): boolean => secid.startsWith(PREFIX);
export const cryptoSecid = (sym: string): string => PREFIX + sym.toUpperCase();
export const cryptoSym = (secid: string): string => secid.slice(PREFIX.length).toUpperCase();
const coinName = (sym: string): string => BY_SYM.get(sym.toUpperCase())?.name ?? sym.toUpperCase();

/** 最近一次成功报价用到的币圈源（供设置页「数据源」展示）。 */
export type CryptoSourceName = 'binance' | 'coinbase' | 'coingecko';
export let lastCryptoSources: CryptoSourceName[] = [];

// ── helpers ─────────────────────────────────────────────────────────────────
async function getJSON(url: string): Promise<any> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`crypto ${res.status} ${url}`);
  return res.json();
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : undefined;
};

const pad2 = (n: number) => String(n).padStart(2, '0');
/** epoch ms → 本地 "HH:MM"（币圈按用户本地时钟看盘，无交易所时区可言）。 */
const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** epoch ms → 本地 "YYYY-MM-DD"。 */
const ymd = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

function baseQuote(sym: string, price: number, prevClose: number): Quote {
  return {
    secid: cryptoSecid(sym),
    code: sym,
    market: 'CRYPTO',
    name: coinName(sym),
    price,
    prevClose,
    changeAmt: price - prevClose,
    changePct: prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
  };
}

// ── 报价 ─────────────────────────────────────────────────────────────────────
interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  volume: string; // base（币数）
  quoteVolume: string; // USDT
}

async function binanceQuotes(secids: string[]): Promise<Quote[]> {
  const syms = secids.map(cryptoSym);
  const pairs = JSON.stringify(syms.map((s) => `${s}USDT`));
  const rows = (await getJSON(`${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(pairs)}`)) as BinanceTicker[];
  if (!Array.isArray(rows)) throw new Error('binance: unexpected ticker payload');
  // 返回顺序与请求顺序无关 → 按 symbol 映射回 secid。
  const out: Quote[] = [];
  for (const r of rows) {
    const sym = String(r.symbol ?? '').replace(/USDT$/, '');
    const price = num(r.lastPrice);
    const open = num(r.openPrice);
    if (price == null || price <= 0 || open == null || open <= 0) continue;
    const high = num(r.highPrice);
    const low = num(r.lowPrice);
    out.push({
      ...baseQuote(sym, price, open),
      changeAmt: num(r.priceChange) ?? price - open,
      changePct: num(r.priceChangePercent) ?? ((price - open) / open) * 100,
      open,
      high,
      low,
      volume: num(r.volume),
      amount: num(r.quoteVolume),
      amplitude: high != null && low != null && open ? ((high - low) / open) * 100 : undefined,
      vwap: num(r.weightedAvgPrice),
    });
  }
  return out;
}

/** Coinbase 无批量接口 → 逐币种并发；个别币种没有 USD 交易对时静默跳过。 */
async function coinbaseQuotes(secids: string[]): Promise<Quote[]> {
  const rows = await Promise.all(
    secids.map(async (secid): Promise<Quote | null> => {
      const sym = cryptoSym(secid);
      try {
        const s = await getJSON(`${COINBASE}/products/${sym}-USD/stats`);
        const price = num(s?.last);
        const open = num(s?.open);
        if (price == null || price <= 0 || open == null || open <= 0) return null;
        const high = num(s?.high);
        const low = num(s?.low);
        const volume = num(s?.volume);
        return {
          ...baseQuote(sym, price, open),
          open,
          high,
          low,
          volume,
          amount: volume != null ? volume * price : undefined,
          amplitude: high != null && low != null ? ((high - low) / open) * 100 : undefined,
        };
      } catch {
        return null;
      }
    })
  );
  return rows.filter((q): q is Quote => !!q);
}

/** CoinGecko 只给现价与 24h 涨跌，够列表和角标用，详情页指标会留空。 */
async function geckoQuotes(secids: string[]): Promise<Quote[]> {
  const syms = secids.map(cryptoSym);
  const ids = syms.map((s) => BY_SYM.get(s)?.gecko).filter((x): x is string => !!x);
  if (!ids.length) return [];
  const j = await getJSON(
    `${COINGECKO}/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
  );
  const out: Quote[] = [];
  for (const sym of syms) {
    const id = BY_SYM.get(sym)?.gecko;
    const d = id ? j?.[id] : undefined;
    const price = num(d?.usd);
    if (price == null || price <= 0) continue;
    const chgPct = num(d?.usd_24h_change) ?? 0;
    out.push({
      ...baseQuote(sym, price, price / (1 + chgPct / 100)),
      changePct: chgPct,
      amount: num(d?.usd_24h_vol),
    });
  }
  return out;
}

const QUOTE_CHAIN: Array<{ name: CryptoSourceName; fn: (s: string[]) => Promise<Quote[]> }> = [
  { name: 'binance', fn: binanceQuotes },
  { name: 'coinbase', fn: coinbaseQuotes },
  { name: 'coingecko', fn: geckoQuotes },
];

/** 逐源补齐缺失币种（与股票行情同一套策略），返回顺序与入参一致。 */
export async function getCryptoQuotes(secids: string[]): Promise<Quote[]> {
  const targets = secids.filter(isCrypto);
  if (!targets.length) return [];
  const got = new Map<string, Quote>();
  const used: CryptoSourceName[] = [];
  for (const { name, fn } of QUOTE_CHAIN) {
    const missing = targets.filter((s) => !got.has(s));
    if (!missing.length) break;
    try {
      const rows = await fn(missing);
      if (rows.length) used.push(name);
      for (const q of rows) got.set(q.secid, q);
    } catch (e) {
      console.info(`[crypto] quotes via ${name} failed, falling back:`, e);
    }
  }
  lastCryptoSources = used;
  return targets.map((s) => got.get(s)).filter((q): q is Quote => !!q);
}

// ── 24h 分时 ────────────────────────────────────────────────────────────────
// 币圈无开收盘，"分时" = 滚动 24 小时（288 根 5 分钟 K），与列表里的 24h 涨跌幅
// 同口径。X 轴按点序号等分（见 core/chart 的 CRYPTO 分支），跨零点也不会回折。
const TREND_POINTS = 288;

async function binanceTrends(secid: string): Promise<Trends> {
  const sym = cryptoSym(secid);
  const rows = (await getJSON(`${BINANCE}/klines?symbol=${sym}USDT&interval=5m&limit=${TREND_POINTS}`)) as any[][];
  if (!Array.isArray(rows) || !rows.length) throw new Error('binance: empty trends for ' + secid);
  let cumBase = 0;
  let cumQuote = 0;
  let run = 0;
  const points: TrendPoint[] = [];
  rows.forEach((r, i) => {
    const close = num(r[4]);
    if (close == null || close <= 0) return;
    const vol = num(r[5]) ?? 0;
    const quoteVol = num(r[7]) ?? 0;
    cumBase += vol;
    cumQuote += quoteVol;
    run += close;
    // 均价线用 VWAP；成交额缺失（极冷门币种）时退回算术均价。
    const vwap = cumBase > 0 ? cumQuote / cumBase : 0;
    points.push({
      t: hhmm(num(r[0]) ?? 0),
      price: close,
      avg: vwap > close * 0.5 && vwap < close * 2 ? vwap : run / (i + 1),
      vol,
    });
  });
  if (!points.length) throw new Error('binance: empty trends for ' + secid);
  return { secid, prevClose: num(rows[0][1]) ?? points[0].price, points };
}

async function coinbaseTrends(secid: string): Promise<Trends> {
  const sym = cryptoSym(secid);
  // [time(秒), low, high, open, close, volume]，按时间倒序返回，最多 300 根。
  const rows = (await getJSON(`${COINBASE}/products/${sym}-USD/candles?granularity=300`)) as number[][];
  if (!Array.isArray(rows) || !rows.length) throw new Error('coinbase: empty trends for ' + secid);
  const asc = rows.slice(0, TREND_POINTS).reverse();
  let run = 0;
  const points: TrendPoint[] = asc.map((r, i) => {
    const price = r[4];
    run += price;
    return { t: hhmm(r[0] * 1000), price, avg: run / (i + 1), vol: r[5] ?? 0 };
  });
  return { secid, prevClose: asc[0][3] ?? points[0].price, points };
}

export async function getCryptoTrends(secid: string): Promise<Trends> {
  let lastErr: unknown;
  for (const fn of [binanceTrends, coinbaseTrends]) {
    try {
      const t = await fn(secid);
      if (t.points.length) return t;
    } catch (e) {
      lastErr = e;
      console.info('[crypto] trends source failed, falling back:', e);
    }
  }
  throw lastErr ?? new Error('crypto trends unavailable');
}

// ── 日 / 周 / 月 K ───────────────────────────────────────────────────────────
const KLT_INTERVAL: Record<101 | 102 | 103, string> = { 101: '1d', 102: '1w', 103: '1M' };
const KLT_LIMIT: Record<101 | 102 | 103, number> = { 101: 180, 102: 200, 103: 240 };

async function binanceKline(secid: string, klt: 101 | 102 | 103): Promise<Kline[]> {
  const sym = cryptoSym(secid);
  const rows = (await getJSON(
    `${BINANCE}/klines?symbol=${sym}USDT&interval=${KLT_INTERVAL[klt]}&limit=${KLT_LIMIT[klt]}`
  )) as any[][];
  if (!Array.isArray(rows)) throw new Error('binance: empty kline for ' + secid);
  const out: Kline[] = [];
  for (const r of rows) {
    const open = num(r[1]);
    const close = num(r[4]);
    if (open == null || close == null) continue;
    out.push({
      date: ymd(num(r[0]) ?? 0),
      open,
      close,
      high: num(r[2]) ?? Math.max(open, close),
      low: num(r[3]) ?? Math.min(open, close),
      vol: num(r[5]) ?? 0,
      amount: num(r[7]) ?? 0,
    });
  }
  if (!out.length) throw new Error('binance: empty kline for ' + secid);
  return out;
}

/**
 * Coinbase 只有日线粒度 → 周/月 K 由日线本地合并（口径与交易所一致：周一起算）。
 * 分桶只用日期字符串的年月日算，不经过本地时区——否则 UTC+8 下整周会错位一天。
 */
function aggregate(daily: Kline[], by: (y: number, m: number, d: number) => string): Kline[] {
  const out: Kline[] = [];
  let key = '';
  for (const k of daily) {
    const [y, m, d] = k.date.split('-').map(Number);
    const bucket = by(y, m, d);
    if (bucket !== key) {
      key = bucket;
      out.push({ ...k });
      continue;
    }
    const cur = out[out.length - 1];
    cur.close = k.close;
    cur.high = Math.max(cur.high, k.high);
    cur.low = Math.min(cur.low, k.low);
    cur.vol += k.vol;
    cur.amount += k.amount;
  }
  return out;
}

async function coinbaseKline(secid: string, klt: 101 | 102 | 103): Promise<Kline[]> {
  const sym = cryptoSym(secid);
  const rows = (await getJSON(`${COINBASE}/products/${sym}-USD/candles?granularity=86400`)) as number[][];
  if (!Array.isArray(rows) || !rows.length) throw new Error('coinbase: empty kline for ' + secid);
  const daily: Kline[] = rows
    .slice()
    .reverse()
    .map((r) => ({ date: ymd(r[0] * 1000), open: r[3], close: r[4], high: r[2], low: r[1], vol: r[5] ?? 0, amount: 0 }));
  if (klt === 101) return daily;
  if (klt === 103) return aggregate(daily, (y, m) => `${y}-${m}`);
  return aggregate(daily, (y, m, d) => {
    // ISO 周序：以周一为界，用「距 1970-01-05（周一，UTC 第 4 天）的整周数」当桶键。
    const days = Date.UTC(y, m - 1, d) / 86_400_000;
    return String(Math.floor((days - 4) / 7));
  });
}

export async function getCryptoKline(secid: string, klt: 101 | 102 | 103): Promise<Kline[]> {
  let lastErr: unknown;
  for (const fn of [binanceKline, coinbaseKline]) {
    try {
      const k = await fn(secid, klt);
      if (k.length) return k.slice(-KLT_LIMIT[klt]);
    } catch (e) {
      lastErr = e;
      console.info('[crypto] kline source failed, falling back:', e);
    }
  }
  throw lastErr ?? new Error('crypto kline unavailable');
}

// ── 搜索（本地目录，零延迟）──────────────────────────────────────────────────
export function coinHit(c: Coin): SearchHit {
  return { secid: cryptoSecid(c.sym), code: c.sym, market: 'CRYPTO', name: c.name, pinyin: c.alias[0] };
}

/** 代码 / 中文名 / 英文名 / 拼音均可命中；空串返回全部（添加页「币圈」筛选用）。 */
export function searchCrypto(input: string): SearchHit[] {
  const q = input.trim().toLowerCase();
  if (!q) return CRYPTO_COINS.map(coinHit);
  return CRYPTO_COINS.filter(
    (c) => c.sym.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.alias.some((a) => a.includes(q))
  ).map(coinHit);
}
