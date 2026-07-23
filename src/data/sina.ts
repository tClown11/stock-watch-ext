import type { DataSource, Quote, Market } from './types';
import { marketFromPrefix } from './secid';

// 新浪行情 — 报价备源，实测 ~40ms 全网最快。hq.sinajs.cn 要求 Referer 头
// （浏览器 fetch 的禁止头），扩展通过 declarativeNetRequest 静态规则
// （dnr_rules.json）在网络层补上 Referer，因此这里可以直接 fetch。

const num = (v: string | undefined): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
};

const INDEX_MAP: Record<string, string> = {
  '100.HSI': 'rt_hkHSI',
  '100.NDX': 'gb_$ixic',
  '100.DJIA': 'gb_$dji',
  '100.SPX': 'gb_$inx',
};

/** secid → 新浪代码 (`sh600519` / `rt_hk00700` / `gb_aapl`). */
function sinaCode(secid: string): string | null {
  if (INDEX_MAP[secid]) return INDEX_MAP[secid];
  const dot = secid.indexOf('.');
  const pfx = secid.slice(0, dot);
  const code = secid.slice(dot + 1);
  if (pfx === '1') return `sh${code}`;
  if (pfx === '0') return `sz${code}`;
  if (pfx === '116') return `rt_hk${code}`;
  if (pfx === '105' || pfx === '106' || pfx === '107') return `gb_${code.toLowerCase().replace(/\./g, '$')}`;
  return null;
}

function parse(secid: string, sym: string, f: string[]): Quote | null {
  const market: Market = marketFromPrefix(secid.slice(0, secid.indexOf('.')));
  const mk = (price?: number, prevClose?: number, extra?: Partial<Quote>): Quote | null => {
    if (price == null || price <= 0) return null;
    const pv = prevClose && prevClose > 0 ? prevClose : price;
    return {
      secid,
      code: secid.slice(secid.indexOf('.') + 1),
      market,
      name: '',
      price,
      prevClose: pv,
      changeAmt: price - pv,
      changePct: pv ? ((price - pv) / pv) * 100 : 0,
      ...extra,
    };
  };
  if (sym.startsWith('sh') || sym.startsWith('sz')) {
    // name,open,prevClose,price,high,low,...,vol(股),amount(元)
    return mk(num(f[3]), num(f[2]), {
      name: f[0],
      open: num(f[1]),
      high: num(f[4]),
      low: num(f[5]),
      volume: num(f[8]) != null ? num(f[8])! / 100 : undefined, // 股→手，与东财口径一致
      amount: num(f[9]),
    });
  }
  if (sym.startsWith('rt_hk')) {
    // en,name,open,prevClose,high,low,price,chg,pct,...,amount,vol,...,52h,52l
    return mk(num(f[6]), num(f[3]), {
      name: f[1],
      open: num(f[2]),
      high: num(f[4]),
      low: num(f[5]),
      amount: num(f[11]),
      volume: num(f[12]),
      high52: num(f[15]),
      low52: num(f[16]),
    });
  }
  if (sym.startsWith('gb_')) {
    // name,price,pct,time,chg,open,high,low,52h,52l,vol,...,mcap,...,pe,...,prevClose@26
    return mk(num(f[1]), num(f[26]), {
      name: f[0],
      open: num(f[5]),
      high: num(f[6]),
      low: num(f[7]),
      high52: num(f[8]),
      low52: num(f[9]),
      volume: num(f[10]),
      mcap: num(f[12]),
      pe: num(f[14]),
    });
  }
  return null;
}

export const sina: DataSource = {
  async getQuotes(secids) {
    const mapped = secids
      .map((s) => ({ secid: s, sym: sinaCode(s) }))
      .filter((x): x is { secid: string; sym: string } => !!x.sym);
    if (!mapped.length) return [];
    const res = await fetch(`https://hq.sinajs.cn/list=${mapped.map((x) => x.sym).join(',')}`, {
      credentials: 'omit',
    });
    if (!res.ok) throw new Error(`sina ${res.status}`);
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
    const bySym = new Map<string, string>();
    for (const x of mapped) {
      bySym.set(x.sym, x.secid);
      bySym.set(x.sym.replace('$', '_'), x.secid); // 响应变量名可能把 $ 写成 _
    }
    const parsed = new Map<string, Quote>();
    for (const line of text.split('\n')) {
      const m = line.match(/var hq_str_([^=]+)="([^"]*)"/);
      if (!m || !m[2]) continue;
      const secid = bySym.get(m[1]);
      if (!secid) continue;
      const q = parse(secid, m[1], m[2].split(','));
      if (q) parsed.set(secid, q);
    }
    return secids.map((s) => parsed.get(s)).filter((q): q is Quote => !!q);
  },
  getTrends: () => Promise.reject(new Error('sina: getTrends not supported')),
  getKline: () => Promise.reject(new Error('sina: getKline not supported')),
  search: () => Promise.reject(new Error('sina: search not supported')),
};
