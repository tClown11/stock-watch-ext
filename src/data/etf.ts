import type { Market } from './types';
import { toSecid } from './secid';

// ETF 持仓成分股 — 东财基金移动端接口（fundmobapi，与被限流的 push2 不同主机，
// 且成分季度才变，会话内缓存后调用频率极低）。

export interface Constituent {
  secid: string;
  code: string;
  name: string;
  weight: number; // 占净值比例 %
}

const cache = new Map<string, Constituent[]>();

function marketOfCode(code: string): Market | null {
  if (/^\d{6}$/.test(code)) {
    if (/^(60|68|9)/.test(code)) return 'SH';
    if (/^(00|30|2)/.test(code)) return 'SZ';
    return null; // 北交所(4/8开头)等：报价源覆盖不稳，跳过
  }
  if (/^\d{5}$/.test(code)) return 'HK';
  if (/^[A-Z][A-Z.\-]*$/i.test(code)) return 'US';
  return null;
}

export async function getConstituents(fundCode: string): Promise<Constituent[]> {
  const hit = cache.get(fundCode);
  if (hit) return hit;
  const url =
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition` +
    `?FCODE=${encodeURIComponent(fundCode)}&deviceid=Wap&plat=Wap&product=EFund&version=2.0.0`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error(`etf constituents ${res.status}`);
  const j = await res.json();
  const rows: any[] = j?.Datas?.fundStocks ?? [];
  const out: Constituent[] = [];
  for (const r of rows) {
    const code = String(r?.GPDM ?? '').trim();
    const name = String(r?.GPJC ?? '').trim();
    const weight = parseFloat(String(r?.JZBL ?? ''));
    const market = marketOfCode(code);
    if (!code || !name || !market || !Number.isFinite(weight)) continue;
    out.push({ secid: toSecid(market, code.toUpperCase()), code: code.toUpperCase(), name, weight });
  }
  out.sort((a, b) => b.weight - a.weight);
  cache.set(fundCode, out);
  return out;
}
