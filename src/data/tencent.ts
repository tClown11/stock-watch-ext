import type { DataSource, Quote, SearchHit, Kline, Market } from './types';
import { marketFromPrefix, toSecid } from './secid';

// 腾讯行情 — 主数据源。qt.gtimg.cn 批量报价覆盖 沪深/港/美/ETF/指数，单次请求
// ~0.2s 且对请求频率极为宽松（腾讯自选股公开接口）；web.ifzq.gtimg.cn 提供
// 分时与前复权 K 线；smartbox.gtimg.cn 提供代码/拼音搜索。全部无鉴权、无禁止头。
//
// 实测字段索引（三市场核心索引一致，2026-07 抓包锁定）：
//   3 现价  4 昨收  5 今开  31 涨跌额  32 涨跌幅%  33 最高  34 最低
//   36 成交量(A股手/港美股股)  37 成交额(A股万元/港美股元)  39 市盈
//   43 振幅%  45 总市值(亿)  A股: 38 换手 46 市净 67/68 52周高低
//   港美: 48/49 52周高低  美股换手 38

const num = (v: string | undefined): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

// 全球指数的东财 secid → 腾讯代码。
const INDEX_MAP: Record<string, string> = {
  '100.HSI': 'hkHSI',
  '100.NDX': 'usIXIC', // 纳斯达克（综合）
  '100.DJIA': 'usDJI',
  '100.SPX': 'usINX',
};

// 美股完整代码缓存（AAPL → AAPL.OQ）——分时/K线接口需要交易所后缀，
// 报价响应的 f[2] 会带出来，顺手记住。
const usFullCode = new Map<string, string>();

/** secid (`市场.代码`) → 腾讯 symbol (`sh600519` / `hk00700` / `usAAPL`). */
export function tencentCode(secid: string): string | null {
  if (INDEX_MAP[secid]) return INDEX_MAP[secid];
  const dot = secid.indexOf('.');
  const pfx = secid.slice(0, dot);
  const code = secid.slice(dot + 1);
  const p: Record<string, string> = { '1': 'sh', '0': 'sz', '116': 'hk', '105': 'us', '106': 'us', '107': 'us' };
  const prefix = p[pfx];
  if (!prefix) return null;
  return `${prefix}${code}`;
}

/** 分时/K线用的完整代码（美股补交易所后缀）。 */
function tencentChartCode(secid: string): string | null {
  const t = tencentCode(secid);
  if (!t) return null;
  if (t.startsWith('us') && !t.includes('.')) {
    const full = usFullCode.get(t.slice(2));
    return full ? `us${full}` : `${t}.OQ`; // 未知时先猜纳斯达克
  }
  return t;
}

async function getGBK(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`tencent ${res.status} ${url}`);
  return new TextDecoder('gbk').decode(await res.arrayBuffer());
}

async function getJSON(url: string): Promise<any> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`tencent ${res.status} ${url}`);
  return res.json();
}

function parseQuote(secid: string, f: string[]): Quote | null {
  const market: Market = marketFromPrefix(secid.slice(0, secid.indexOf('.')));
  const price = num(f[3]);
  if (price == null || price <= 0) return null;
  const prevClose = num(f[4]) ?? price;
  const isCN = f[0] === '1' || f[0] === '51'; // 沪=1 深=51（含ETF/指数）
  const rawCode = f[2] ?? '';
  if (rawCode.includes('.')) usFullCode.set(rawCode.split('.')[0], rawCode); // AAPL.OQ
  const vol = num(f[36]);
  const amt = num(f[37]);
  const h52 = isCN ? num(f[67]) : num(f[48]);
  const l52 = isCN ? num(f[68]) : num(f[49]);
  return {
    secid,
    code: secid.slice(secid.indexOf('.') + 1),
    market,
    name: f[1] ?? '',
    price,
    prevClose,
    changeAmt: num(f[31]) ?? price - prevClose,
    changePct: num(f[32]) ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : 0),
    open: num(f[5]),
    high: num(f[33]),
    low: num(f[34]),
    volume: vol, // A股:手  港美:股（与东财 f5 口径一致）
    amount: amt != null ? amt * (isCN ? 1e4 : 1) : undefined, // 统一为元
    amplitude: num(f[43]),
    turnover: isCN || market === 'US' ? num(f[38]) : undefined,
    pe: num(f[39]),
    pb: isCN ? num(f[46]) : undefined,
    mcap: num(f[45]) != null ? num(f[45])! * 1e8 : undefined, // 亿→元
    high52: h52 && h52 > 0 ? h52 : undefined,
    low52: l52 && l52 > 0 ? l52 : undefined,
  };
}

export const tencent: DataSource = {
  async getQuotes(secids) {
    const mapped = secids
      .map((s) => ({ secid: s, t: tencentCode(s) }))
      .filter((x): x is { secid: string; t: string } => !!x.t);
    if (!mapped.length) return [];
    const text = await getGBK(`https://qt.gtimg.cn/q=${mapped.map((x) => x.t).join(',')}`);
    const bySym = new Map(mapped.map((x) => [x.t, x.secid]));
    const parsed = new Map<string, Quote>();
    for (const line of text.split(';')) {
      const m = line.match(/v_([^=]+)="([^"]*)"/);
      if (!m) continue;
      const secid = bySym.get(m[1]);
      if (!secid) continue;
      const f = m[2].split('~');
      if (f.length < 40) continue;
      const q = parseQuote(secid, f);
      if (q) parsed.set(secid, q);
    }
    // 保持调用方顺序；未返回的丢弃（由 router 用其它源补齐）。
    return secids.map((s) => parsed.get(s)).filter((q): q is Quote => !!q);
  },

  async getTrends(secid) {
    const t = tencentChartCode(secid);
    if (!t) throw new Error('tencent: unsupported secid ' + secid);
    const j = await getJSON(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${t}`);
    const node = j?.data?.[t];
    const rows: string[] = node?.data?.data ?? [];
    // qt[code] 是与 qt.gtimg.cn 相同的字段数组，f[4] = 昨收。
    const qt: string[] | undefined = node?.qt?.[t];
    const prevClose = num(qt?.[4]) ?? 0;
    const isCN = t.startsWith('sh') || t.startsWith('sz');
    const isIndex = /^(sh000|sz399|hkHSI|us\.?IXIC)/.test(t);
    let run = 0;
    const points = rows
      .map((r, i) => {
        // "0930 1338.98 1969 263645162.00" → 时间 现价 累计量 累计额
        const p = r.trim().split(/\s+/);
        const price = num(p[1]);
        if (p[0]?.length !== 4 || price == null || price <= 0) return null;
        run += price;
        const cumVol = num(p[2]) ?? 0;
        const cumAmt = num(p[3]) ?? 0;
        // 均价线用 VWAP（A股成交量单位为手×100股）；指数或数据异常时退回均价累计。
        let avg = run / (i + 1);
        if (!isIndex && cumVol > 0 && cumAmt > 0) {
          const vwap = cumAmt / (cumVol * (isCN ? 100 : 1));
          if (vwap > price * 0.5 && vwap < price * 2) avg = vwap;
        }
        return { t: `${p[0].slice(0, 2)}:${p[0].slice(2)}`, price, avg, vol: cumVol };
      })
      .filter((x): x is { t: string; price: number; avg: number; vol: number } => !!x);
    if (!points.length) throw new Error('tencent: empty trends for ' + secid);
    return { secid, prevClose: prevClose || points[0].price, points };
  },

  async getKline(secid, klt) {
    const t = tencentChartCode(secid);
    if (!t) throw new Error('tencent: unsupported secid ' + secid);
    const period = klt === 101 ? 'day' : klt === 102 ? 'week' : 'month';
    const cap = klt === 101 ? 180 : klt === 102 ? 200 : 240;
    const j = await getJSON(
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${t},${period},,,${cap},qfq`
    );
    const node = j?.data?.[t];
    const rows: any[] = node?.[`qfq${period}`] ?? node?.[period] ?? [];
    const out: Kline[] = [];
    for (const r of rows) {
      // [date, open, close, high, low, vol, (可选分红对象)]
      if (!Array.isArray(r) || r.length < 6) continue;
      const open = num(r[1]);
      const close = num(r[2]);
      if (open == null || close == null) continue;
      out.push({
        date: String(r[0]),
        open,
        close,
        high: num(r[3]) ?? Math.max(open, close),
        low: num(r[4]) ?? Math.min(open, close),
        vol: num(r[5]) ?? 0,
        amount: 0,
      });
    }
    if (!out.length) throw new Error('tencent: empty kline for ' + secid);
    return out.slice(-cap);
  },

  async search(input) {
    const q = input.trim();
    if (!q) return [];
    const text = await getGBK(`https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`);
    const m = text.match(/v_hint="([^"]*)"/);
    if (!m || m[1] === 'N;') return [];
    const hits: SearchHit[] = [];
    for (const item of m[1].split('^')) {
      // "sh~600519~贵州茅台~gzmt~GP-A"  /  "us~AAPL.OQ~苹果~~GP-US"
      const p = item.split('~');
      if (p.length < 3) continue;
      const [type, rawCode, rawName, py, flag] = p;
      const name = decodeUni(rawName);
      let market: Market;
      let code = rawCode;
      if (type === 'sh') market = 'SH';
      else if (type === 'sz') market = 'SZ';
      else if (type === 'hk') market = 'HK';
      else if (type === 'us') {
        market = 'US';
        code = rawCode.split('.')[0].toUpperCase();
        if (rawCode.includes('.')) usFullCode.set(code, rawCode.toUpperCase());
      } else continue;
      if (/ZS/.test(flag ?? '')) continue; // 指数不进自选搜索结果
      hits.push({
        secid: toSecid(market, code),
        code,
        market,
        name,
        pinyin: py || undefined,
        etf:
          /ETF/i.test(name) ||
          (market === 'SH' && /^(51|56|58)/.test(code)) ||
          (market === 'SZ' && /^159/.test(code)),
      });
    }
    return hits;
  },
};

/** smartbox 返回 \uXXXX 转义的中文名。 */
function decodeUni(s: string): string {
  if (!s.includes('\\u')) return s;
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
  } catch {
    return s;
  }
}
