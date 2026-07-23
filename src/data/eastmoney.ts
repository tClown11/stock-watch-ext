import type { DataSource, Quote, SearchHit, Market } from './types';
import { marketFromPrefix } from './secid';

// Public constant token Eastmoney's own web front-end uses for the his APIs.
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

async function getJSON(url: string): Promise<any> {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`eastmoney ${res.status} ${url}`);
  return res.json();
}

// ── field map (fltt=2 → prices already come as human decimals) ──────────────
// f2 现价  f3 涨跌幅%  f4 涨跌额  f5 成交量(手)  f6 成交额(元)  f7 振幅%  f8 换手%
// f9 市盈(动)  f12 代码  f13 市场  f14 名称  f15 最高  f16 最低  f17 今开
// f18 昨收  f20 总市值  f23 市净  f174 52周高  f175 52周低
const QUOTE_FIELDS = 'f2,f3,f4,f5,f6,f7,f8,f9,f12,f13,f14,f15,f16,f17,f18,f20,f23,f174,f175';

function toQuote(d: any): Quote {
  const market: Market = marketFromPrefix(d.f13);
  const price = num(d.f2) ?? 0;
  const prevClose = num(d.f18) ?? price;
  return {
    secid: `${d.f13}.${d.f12}`,
    code: String(d.f12),
    market,
    name: String(d.f14),
    price,
    prevClose,
    changeAmt: num(d.f4) ?? price - prevClose,
    changePct: num(d.f3) ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : 0),
    open: num(d.f17),
    high: num(d.f15),
    low: num(d.f16),
    volume: num(d.f5),
    amount: num(d.f6),
    amplitude: num(d.f7),
    turnover: num(d.f8),
    pe: num(d.f9),
    pb: num(d.f23),
    mcap: num(d.f20),
    high52: num(d.f174),
    low52: num(d.f175),
  };
}

export const eastmoney: DataSource = {
  async getQuotes(secids) {
    if (!secids.length) return [];
    const url =
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=${QUOTE_FIELDS}` +
      `&secids=${secids.join(',')}`;
    const j = await getJSON(url);
    const diff: any[] = j?.data?.diff ?? [];
    const byCode = new Map(diff.map((d) => [`${d.f13}.${d.f12}`, toQuote(d)]));
    // Preserve caller ordering; drop anything the API didn't return.
    return secids.map((s) => byCode.get(s)).filter((q): q is Quote => !!q);
  },

  async getTrends(secid) {
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/trends2/get?fltt=2&iscr=0&ndays=1` +
      `&fields1=f1,f2,f3,f7&fields2=f51,f53,f56,f58&secid=${secid}`;
    const j = await getJSON(url);
    const prevClose = num(j?.data?.preClose) ?? num(j?.data?.prePrice) ?? 0;
    const rows: string[] = j?.data?.trends ?? [];
    let run = 0;
    const points = rows.map((r, i) => {
      // "2026-07-21 09:30,1338.98,1969"  → time, price, vol
      const parts = r.split(',');
      const price = num(parts[1]) ?? 0;
      run += price;
      return {
        t: (parts[0] ?? '').slice(11, 16),
        price,
        avg: run / (i + 1),
        vol: num(parts[2]) ?? 0,
      };
    });
    return { secid, prevClose, points };
  },

  async getKline(secid, klt) {
    // `beg=0` reliably returns the full series (oldest→newest, gzipped — the
    // browser decodes it transparently). `lmt` is ignored alongside `beg=0`,
    // and forward-adjusted (fqt=1) prices go negative for very old bars, so we
    // keep only the recent tail where adjusted prices are normal/positive.
    const cap = klt === 101 ? 180 : klt === 102 ? 200 : 240;
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?ut=${UT}&fltt=2&fqt=1` +
      `&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=${klt}` +
      `&beg=0&end=20500101&secid=${secid}`;
    const j = await getJSON(url);
    const rows: string[] = (j?.data?.klines ?? []).slice(-cap);
    return rows.map((r) => {
      const p = r.split(',');
      return {
        date: p[0] ?? '',
        open: num(p[1]) ?? 0,
        close: num(p[2]) ?? 0,
        high: num(p[3]) ?? 0,
        low: num(p[4]) ?? 0,
        vol: num(p[5]) ?? 0,
        amount: num(p[6]) ?? 0,
      };
    });
  },

  async search(input) {
    const q = input.trim();
    if (!q) return [];
    // type=14 → 沪深/港/美/ETF 等全市场证券建议
    const url =
      `https://searchapi.eastmoney.com/api/suggest/get?type=14&count=10` +
      `&token=D43BF722C8E33BDC906FB84D85E326E8&input=${encodeURIComponent(q)}`;
    const j = await getJSON(url);
    const rows: any[] = j?.QuotationCodeTable?.Data ?? [];
    return rows
      .filter((r) => r.QuoteID)
      .map((r): SearchHit => {
        const secid = String(r.QuoteID);
        const prefix = secid.split('.')[0];
        const classify = String(r.Classify ?? '');
        return {
          secid,
          code: String(r.Code),
          market: marketFromPrefix(prefix),
          name: String(r.Name),
          pinyin: r.PinYin ? String(r.PinYin) : undefined,
          etf: /ETF|Fund/i.test(classify) || /ETF/.test(String(r.Name)),
        };
      });
  },
};
