import type { DataSource, SearchHit, Market } from './types';

// 同花顺 keyboard-suggest (news.10jqka.com.cn) — the one search endpoint that is
// BOTH real-time and CORS-open, so it works straight from the extension popup
// page (Eastmoney's search API sends no CORS header and only works from the SW).
//
// Response: jsonp([ [A股…], [港股…], [美股…], [基金…] ])
// Each item: "<prefix>||<code> <name> [<pinyin>] <类型>"

function aShareMarket(code: string): Market {
  // 6xx/68x/5xx/9xx → 上交所; 0xx/3xx/1xx/2xx → 深交所
  return /^[569]/.test(code) ? 'SH' : 'SZ';
}

// groupIndex matches the requested type order: stock, hk, usa, fund
function resolve(groupIndex: number, code: string): { secid: string; market: Market } {
  if (groupIndex === 1) return { secid: `116.${code}`, market: 'HK' };
  if (groupIndex === 2) return { secid: `105.${code}`, market: 'US' };
  const m = aShareMarket(code);
  return { secid: `${m === 'SH' ? '1' : '0'}.${code}`, market: m };
}

async function thsSearch(input: string): Promise<SearchHit[]> {
  const q = input.trim();
  if (!q) return [];
  const url =
    `https://news.10jqka.com.cn/public/index_keyboard_${encodeURIComponent(q)}` +
    `_stock,hk,usa,fund_12_jsonp.html`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ths ${res.status}`);
  const text = await res.text();
  const m = text.match(/jsonp\((.*)\)\s*;?\s*$/s);
  if (!m) return [];
  let groups: string[][];
  try {
    groups = JSON.parse(m[1]);
  } catch {
    return [];
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  groups.forEach((group, gi) => {
    for (const raw of group) {
      const sep = raw.indexOf('||');
      if (sep < 0) continue;
      const tokens = raw.slice(sep + 2).trim().split(/\s+/);
      const code = tokens[0];
      const name = tokens[1] || code;
      if (!code) continue;
      const { secid, market } = resolve(gi, code);
      if (seen.has(secid)) continue;
      seen.add(secid);
      hits.push({ secid, code, market, name, etf: /ETF/i.test(name), pinyin: tokens.length > 3 ? tokens[2] : undefined });
    }
  });
  return hits;
}

export const ths: DataSource = {
  getQuotes: () => Promise.reject(new Error('ths: getQuotes unsupported')),
  getTrends: () => Promise.reject(new Error('ths: getTrends unsupported')),
  getKline: () => Promise.reject(new Error('ths: getKline unsupported')),
  search: thsSearch,
};
