// 东财天天基金接口：场外基金净值兜底。
// 场外基金（申购赎回制，如 020839）不在交易所上市，腾讯/新浪/东财的股票行情
// 接口一概查不到；这里用 fundmobapi 取最新单位净值（通常为前一交易日）或盘中
// 估值，合成 Quote 供列表/角标正常展示，UI 侧以净值日期明确标注非实时。
import type { Quote, Market } from './types';

const BASE = 'https://fundmobapi.eastmoney.com/FundMNewApi';
const COMMON = 'plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=dpzs';

const marketOf = (secid: string): Market => (secid.startsWith('1.') ? 'SH' : 'SZ');

/** 沪深 6 位数字代码才可能是场外基金（港美股不走此兜底）。 */
export const maybeFund = (secid: string): boolean => /^[01]\.\d{6}$/.test(secid);

interface FundRow {
  FCODE?: string;
  SHORTNAME?: string;
  PDATE?: string; // 净值日期
  NAV?: string; // 单位净值
  ACCNAV?: string; // 累计净值
  NAVCHGRT?: string; // 净值日涨跌 %
  GSZ?: string | null; // 盘中估值
  GSZZL?: string | null; // 估值涨跌 %
  GZTIME?: string | null; // 估值时间
}

export async function getFundQuotes(secids: string[]): Promise<Quote[]> {
  const targets = secids.filter(maybeFund);
  if (!targets.length) return [];
  const codes = targets.map((s) => s.slice(2));
  const url = `${BASE}/FundMNFInfo?pageIndex=1&pageSize=${codes.length}&${COMMON}&Fcodes=${codes.join(',')}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fund quotes http ${r.status}`);
  const j = (await r.json()) as { Datas?: FundRow[] };
  const byCode = new Map((j.Datas ?? []).map((d) => [String(d.FCODE), d]));
  const out: Quote[] = [];
  for (const secid of targets) {
    const d = byCode.get(secid.slice(2));
    if (!d) continue;
    // 有盘中估值用估值（GSZ/GSZZL），否则用最新单位净值（NAV，通常是前一交易日）。
    const est = d.GSZ != null && d.GSZZL != null;
    const price = parseFloat(String(est ? d.GSZ : d.NAV));
    const pct = parseFloat(String(est ? d.GSZZL : d.NAVCHGRT));
    if (!Number.isFinite(price)) continue;
    const chgPct = Number.isFinite(pct) ? pct : 0;
    const prevClose = price / (1 + chgPct / 100);
    out.push({
      secid,
      code: secid.slice(2),
      market: marketOf(secid),
      name: d.SHORTNAME || secid.slice(2),
      price,
      prevClose,
      changeAmt: price - prevClose,
      changePct: chgPct,
      otc: true,
      navDate: String((est ? d.GZTIME : d.PDATE) ?? '').slice(0, 10),
      accNav: d.ACCNAV != null && Number.isFinite(parseFloat(d.ACCNAV)) ? parseFloat(d.ACCNAV) : undefined,
    });
  }
  return out;
}

export interface FundHolding {
  secid: string;
  name: string;
  weight: number; // 净值占比 %
}
export interface FundHoldings {
  stocks: FundHolding[];
  asOf: string; // 持仓报告期 YYYY-MM-DD
}

/**
 * 前十大持仓（季报口径）。用于盘中加权估算基金涨幅：
 * 场外基金当日净值收盘后才公布，盘中只能按持仓成分股实时涨跌近似。
 */
export async function getFundHoldings(code: string): Promise<FundHoldings> {
  const url = `${BASE}/FundMNInverstPosition?FCODE=${code}&${COMMON}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fund holdings http ${r.status}`);
  const j = (await r.json()) as {
    Datas?: { fundStocks?: Array<{ GPDM?: string; GPJC?: string; JZBL?: string; NEWTEXCH?: string }> };
    Expansion?: string;
  };
  const stocks = (j.Datas?.fundStocks ?? [])
    .filter((s) => (s.NEWTEXCH === '0' || s.NEWTEXCH === '1') && !!s.GPDM && Number.isFinite(parseFloat(String(s.JZBL))))
    .map((s) => ({ secid: `${s.NEWTEXCH}.${s.GPDM}`, name: s.GPJC || s.GPDM!, weight: parseFloat(String(s.JZBL)) }));
  return { stocks, asOf: String(j.Expansion ?? '').slice(0, 10) };
}

export interface NavPoint {
  date: string; // YYYY-MM-DD
  nav: number;
  pct: number; // 当日净值涨跌 %
}

/** 历史净值，接口倒序返回 → 转为正序；默认近 60 个交易日（约 3 个月）。 */
export async function getFundNav(code: string, n = 60): Promise<NavPoint[]> {
  const url = `${BASE}/FundMNHisNetList?pageIndex=1&pageSize=${n}&${COMMON}&FCODE=${code}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fund nav http ${r.status}`);
  const j = (await r.json()) as { Datas?: Array<{ FSRQ?: string; DWJZ?: string; JZZZL?: string }> };
  return (j.Datas ?? [])
    .map((d) => ({ date: String(d.FSRQ ?? ''), nav: parseFloat(String(d.DWJZ)), pct: parseFloat(String(d.JZZZL)) || 0 }))
    .filter((x) => x.date !== '' && Number.isFinite(x.nav))
    .reverse();
}
