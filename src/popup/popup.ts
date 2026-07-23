import type { Quote, Trends, Kline, SearchHit, WatchItem, Market } from '../data/types';
import * as router from '../data/router';
import { SOURCE_LABEL } from '../data/router';
import { getConstituents, type Constituent } from '../data/etf';
import { getFundNav, getFundHoldings, type NavPoint, type FundHoldings } from '../data/fund';
import { loadStore, saveStore, onStoreChanged, type Alert } from '../core/storage';
import { DEFAULT_SETTINGS, colorsOf, refreshMs, type Settings } from '../core/settings';
import { fmt, sgn, decimalsFor } from '../core/format';
import { pnlOf, metricsFor, hexToRgba, marketSessionOpen, displaySort, buildTrendChart } from '../core/compute';
import {
  timeShareChart,
  candleChart,
  nearestPoint,
  type ChartPoint,
  type TimeShareChart,
  type CandleChart,
  type SessionKind,
} from '../core/chart';
import { h, svg } from './h';

// ── market tag palette (from the design) ────────────────────────────────────
const MKT: Record<Market, { tag: string; bg: string; fg: string; where: string }> = {
  SH: { tag: '沪', bg: 'rgba(250,71,80,.12)', fg: '#ee555e', where: '上交所' },
  SZ: { tag: '深', bg: 'rgba(63,116,201,.12)', fg: '#3f74c9', where: '深交所' },
  HK: { tag: '港', bg: 'rgba(224,161,58,.16)', fg: '#c98b2e', where: '港交所' },
  US: { tag: '美', bg: 'rgba(122,91,208,.14)', fg: '#7a5bd0', where: '美股' },
};

// [secid, 名称, 所属市场]——v6 设计：指数芯片自带该市场交易状态点
const INDEX_SECIDS: Array<[string, string, 'A' | 'HK' | 'US']> = [
  ['1.000001', '上证指数', 'A'],
  ['0.399001', '深证成指', 'A'],
  ['0.399006', '创业板指', 'A'],
  ['1.000300', '沪深300', 'A'],
  ['100.HSI', '恒生指数', 'HK'],
  ['100.NDX', '纳斯达克', 'US'],
];

type AddMkt = '全部' | '沪深' | '港股' | '美股' | 'ETF';
type DetailTab = '分时' | '日K' | '周K' | '月K';

interface AppState {
  permsMissing: boolean; // 行情站点访问权限被用户/策略关闭
  screen: null | 'add' | 'settings';
  detailSecid: string | null;
  detailTab: DetailTab;
  group: number;
  query: string;
  addMkt: AddMkt;
  menu: string | null; // secid whose right-click menu is open
  menuPos: { x: number; y: number }; // 右键菜单浮层锚点（鼠标位置，视口坐标）
  watchlist: WatchItem[];
  settings: Settings;
  alerts: Alert[];
  groups: string[]; // 自定义分组名
  editHold: string | null; // secid open in the 自选设置 modal
  holdDraft: { shares: string; cost: string };
  groupDraft: string[];
  newGroupName: string;
  quotes: Map<string, Quote>;
  trends: Map<string, Trends>; // 分时（详情页）
  klineCache: Map<string, Kline[]>; // key `${secid}:${tab}` for 日K/周K/月K
  constituents: Map<string, Constituent[]>; // ETF 成分股（key = 基金代码）
  navCache: Map<string, NavPoint[]>; // 场外基金历史净值（key = 基金代码）
  holdingsCache: Map<string, FundHoldings>; // 场外基金前十大持仓（盘中估算用）
  indices: Quote[];
  hits: SearchHit[];
  lastUpdated: string; // wall-clock of the last successful quote fetch
  refreshing: boolean;
  marketPaused: boolean; // 节假日/收盘自动暂停刷新中
  aboutModal: null | 'source' | 'privacy';
}

const state: AppState = {
  permsMissing: false,
  screen: null,
  detailSecid: null,
  detailTab: '分时',
  group: 0,
  query: '',
  addMkt: '全部',
  menu: null,
  menuPos: { x: 0, y: 0 },
  watchlist: [],
  settings: { ...DEFAULT_SETTINGS },
  alerts: [],
  groups: [],
  editHold: null,
  holdDraft: { shares: '', cost: '' },
  groupDraft: [],
  newGroupName: '',
  quotes: new Map(),
  trends: new Map(),
  klineCache: new Map(),
  constituents: new Map(),
  navCache: new Map(),
  holdingsCache: new Map(),
  indices: [],
  hits: [],
  lastUpdated: '',
  refreshing: false,
  marketPaused: false,
  aboutModal: null,
};

// ── derived helpers ──────────────────────────────────────────────────────────
const colors = () => colorsOf(state.settings);
const quoteFor = (secid: string) => state.quotes.get(secid);

// Per-market session status (Beijing time). US uses the CN-time window ≈ 21:30–04:00.
// `?forceopen=US` / `?forceopen=A,HK` / `?forceopen=none` 仅供 E2E 与预览固定市场状态。
const FORCE_OPEN = new URLSearchParams(location.search).get('forceopen');
function marketOpen(m: 'A' | 'HK' | 'US'): boolean {
  if (FORCE_OPEN != null) return FORCE_OPEN !== 'none' && FORCE_OPEN.split(',').includes(m);
  return marketSessionOpen(m);
}

interface GroupDef {
  label: string;
  custom: boolean;
  f: (w: WatchItem) => boolean;
}
function groupDefs(): GroupDef[] {
  return [
    { label: '全部自选', custom: false, f: () => true },
    { label: '持仓', custom: false, f: (w) => !!w.hold },
    ...state.groups.map((gn) => ({ label: gn, custom: true, f: (w: WatchItem) => (w.groups ?? []).includes(gn) })),
  ];
}

// ── persistence ──────────────────────────────────────────────────────────────
async function persist() {
  await saveStore({ watchlist: state.watchlist, settings: state.settings, alerts: state.alerts, groups: state.groups });
}

// ── 行情站点访问权限（可能被用户/企业策略关闭 → 一键重新授权）────────────────
const DATA_ORIGINS = [
  'https://qt.gtimg.cn/*',
  'https://web.ifzq.gtimg.cn/*',
  'https://smartbox.gtimg.cn/*',
  'https://hq.sinajs.cn/*',
  'https://push2.eastmoney.com/*',
  'https://push2his.eastmoney.com/*',
  'https://searchapi.eastmoney.com/*',
  'https://fundmobapi.eastmoney.com/*',
  'https://news.10jqka.com.cn/*',
];
async function checkPerms() {
  if (!inExtension() || !chrome.permissions?.contains) return;
  try {
    state.permsMissing = !(await chrome.permissions.contains({ origins: DATA_ORIGINS }));
  } catch (e) {
    console.warn('[popup] perms check failed', e);
  }
}
async function grantPerms() {
  try {
    const ok = await chrome.permissions.request({ origins: DATA_ORIGINS });
    if (ok) {
      state.permsMissing = false;
      toast('已授权 · 正在拉取行情');
      refreshQuotes();
    } else {
      toast('未授权 · 行情无法加载');
    }
  } catch (e) {
    console.warn('[popup] perms request failed', e);
    toast('授权失败 · 请在扩展详情页手动开启站点权限');
  }
  render();
}

// ── data loading ─────────────────────────────────────────────────────────────
const anyMarketOpen = () => marketOpen('A') || marketOpen('HK') || marketOpen('US');

/** auto=true 为定时刷新：开启「节假日自动切换休市」且全市场收盘时跳过网络请求。 */
async function refreshQuotes(auto = false) {
  if (auto && state.settings.toggles.holiday && !anyMarketOpen() && state.lastUpdated) {
    state.marketPaused = true;
    render();
    return;
  }
  state.marketPaused = false;
  const wanted = new Set(state.watchlist.map((w) => w.secid));
  if (state.detailSecid) wanted.add(state.detailSecid);
  // 场外基金的持仓成分股并入同一批请求：盘中估算随每次刷新更新
  for (const w of state.watchlist) {
    const hs = state.holdingsCache.get(w.secid.slice(w.secid.indexOf('.') + 1));
    if (hs) for (const st of hs.stocks) wanted.add(st.secid);
  }
  const indexIds = INDEX_SECIDS.map(([id]) => id);
  state.refreshing = true;
  render();
  try {
    // 自选 + 指数合并为一次批量请求（腾讯单请求 ~0.2s 全市场）。
    const rows = await router.getQuotes([...wanted, ...indexIds]);
    const indexSet = new Set(indexIds);
    const idx: Quote[] = [];
    for (const q of rows) {
      state.quotes.set(q.secid, q);
      if (indexSet.has(q.secid)) idx.push(q);
    }
    if (idx.length) state.indices = indexIds.map((id) => idx.find((q) => q.secid === id)).filter((q): q is Quote => !!q);
    state.lastUpdated = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 工具栏角标与弹窗同步：每次拿到新行情立刻推给 service worker 重算角标，
    // 否则角标要等下一次 alarm（最短 30s、默认几分钟）才更新，与列表数据错位。
    pushQuotesToBadge(rows);
    // 自选里的场外基金：首次发现时拉取前十大持仓（幂等），供盘中估算
    for (const w of state.watchlist) if (state.quotes.get(w.secid)?.otc) loadFundHoldings(w.secid);
    // 详情页开着分时图时，跟随刷新拉一次最新分时（场外基金无分时，跳过）。
    if (state.detailSecid && state.detailTab === '分时' && !quoteFor(state.detailSecid)?.otc) loadTrends(state.detailSecid);
  } catch (e) {
    console.error('[popup] refresh failed', e);
  } finally {
    state.refreshing = false;
    render();
  }
}

async function loadTrends(secid: string) {
  try {
    const t = await router.getTrends(secid);
    state.trends.set(secid, t);
    render();
  } catch (e) {
    console.info('[popup] trends unavailable', e);
    // 标记「已尝试但无数据」：详情页显示明确文案而非永远「加载中」
    //（典型场景：美股休市时段 + 分时源不可达）。
    if (!state.trends.has(secid)) state.trends.set(secid, { secid, prevClose: 0, points: [] });
    render();
  }
}

/** ETF 持仓成分股 + 成分实时报价。 */
async function loadConstituents(fundCode: string) {
  try {
    const cons = await getConstituents(fundCode);
    state.constituents.set(fundCode, cons);
    render();
    if (cons.length) {
      const qs = await router.getQuotes(cons.map((c) => c.secid));
      for (const q of qs) state.quotes.set(q.secid, q);
      render();
    }
  } catch (e) {
    // 部分基金无成分股数据属正常（如货币基金），降级 info 避免进扩展错误页
    console.info('[popup] constituents unavailable', e);
    state.constituents.set(fundCode, []);
    render();
  }
}

// True while a CJK IME composition is in progress. Recreating the <input> mid-
// composition (which our full re-render does) aborts the IME and makes Chinese
// names untypeable — so we suppress search + render until composition ends.
// Route search through the service worker so it works despite Eastmoney's search
// API lacking CORS (MV3 extension pages are CORS-bound; the SW is not). In the
// dev preview there is no extension SW, so it falls back to a direct call which
// can only reach CORS-open sources → mock.
function inExtension(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}
/** 把最新报价推给 service worker，让工具栏角标/到价提醒跟随本次刷新即时更新。 */
function pushQuotesToBadge(quotes: Quote[]) {
  if (!inExtension()) return;
  try {
    chrome.runtime.sendMessage({ type: 'quotes-refreshed', quotes }, () => void chrome.runtime.lastError);
  } catch {
    /* SW 暂不可用（如扩展刚重载）时静默跳过，下一次 alarm 会兜底 */
  }
}
function swSearch(q: string): Promise<SearchHit[]> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'data', method: 'search', args: [q] }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (resp?.ok) resolve(resp.result as SearchHit[]);
      else reject(new Error(resp?.error || 'sw search failed'));
    });
  });
}
function doSearch(q: string): Promise<SearchHit[]> {
  // 同花顺 → 腾讯 smartbox → 东财（扩展里经 SW 转发绕过 CORS）。
  return router.search(q, inExtension() ? swSearch : undefined);
}

let imeComposing = false;
let searchTimer: number | undefined;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = state.query.trim();
    if (!q) {
      state.hits = [];
      render();
      return;
    }
    try {
      const hits = await doSearch(q);
      state.hits = hits;
      render();
      const qs = await router.getQuotes(hits.map((x) => x.secid));
      for (const quote of qs) state.quotes.set(quote.secid, quote);
      render();
    } catch (e) {
      console.error('[popup] search failed', e);
    }
  }, 220) as unknown as number;
}

// ── refresh loop keyed to the 刷新频率 setting ───────────────────────────────
let refreshTimer: number | undefined;
function restartLoop() {
  const ms = refreshMs(state.settings);
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshQuotes(true), ms) as unknown as number;
}

// ── mutations ────────────────────────────────────────────────────────────────
function setState(patch: Partial<AppState>) {
  Object.assign(state, patch);
  render();
}
function isEtf(secid: string): boolean {
  const w = state.watchlist.find((x) => x.secid === secid);
  if (w?.etf) return true;
  const name = quoteFor(secid)?.name ?? w?.name ?? '';
  return /ETF/i.test(name);
}
function openDetail(secid: string) {
  setState({ detailSecid: secid, detailTab: '分时', screen: null });
  if (quoteFor(secid)?.otc) {
    // 场外基金：拉净值走势 + 持仓（盘中估算），不拉分时
    loadNavHistory(secid);
    loadFundHoldings(secid);
  } else if (!state.trends.has(secid)) loadTrends(secid);
  if (!quoteFor(secid)) refreshQuotes(); // 成分股等非自选标的先补一次报价
  const code = secid.slice(secid.indexOf('.') + 1);
  if (isEtf(secid) && !state.constituents.has(code)) loadConstituents(code);
}

// ── 场外基金：前十大持仓 + 盘中加权估算 ──────────────────────────────────────
const holdingsLoading = new Set<string>();
async function loadFundHoldings(secid: string) {
  const code = secid.slice(secid.indexOf('.') + 1);
  if (state.holdingsCache.has(code) || holdingsLoading.has(code)) return;
  holdingsLoading.add(code);
  try {
    const hs = await getFundHoldings(code);
    state.holdingsCache.set(code, hs);
    if (hs.stocks.length) {
      // 立即补一次成分股报价，让估算马上可用（后续随整体刷新更新）
      const qs = await router.getQuotes(hs.stocks.map((s) => s.secid));
      for (const q of qs) state.quotes.set(q.secid, q);
    }
  } catch (e) {
    console.info('[popup] fund holdings unavailable', e);
    state.holdingsCache.set(code, { stocks: [], asOf: '' });
  } finally {
    holdingsLoading.delete(code);
    render();
  }
}

/** 盘中估算：前十大持仓涨跌幅按权重加权（覆盖不足一半成分时不给出）。 */
function fundEstimate(secid: string): { pct: number; coverage: number; asOf: string } | null {
  const code = secid.slice(secid.indexOf('.') + 1);
  const hs = state.holdingsCache.get(code);
  if (!hs || !hs.stocks.length) return null;
  let wSum = 0;
  let acc = 0;
  let n = 0;
  for (const s of hs.stocks) {
    const q = state.quotes.get(s.secid);
    if (!q) continue;
    acc += s.weight * q.changePct;
    wSum += s.weight;
    n++;
  }
  if (!wSum || n < Math.ceil(hs.stocks.length / 2)) return null;
  return { pct: acc / wSum, coverage: Math.round(hs.stocks.reduce((a, s) => a + s.weight, 0)), asOf: hs.asOf };
}

// ── 场外基金历史净值 ─────────────────────────────────────────────────────────
const navLoading = new Set<string>();
async function loadNavHistory(secid: string) {
  const code = secid.slice(secid.indexOf('.') + 1);
  if (state.navCache.has(code) || navLoading.has(code)) return;
  navLoading.add(code);
  try {
    const rows = await getFundNav(code);
    state.navCache.set(code, rows);
  } catch (e) {
    console.info('[popup] fund nav history failed', e);
    state.navCache.set(code, []);
  } finally {
    navLoading.delete(code);
    render();
  }
}
function toggleWatch(hit: SearchHit) {
  const exists = state.watchlist.some((w) => w.secid === hit.secid);
  if (exists) state.watchlist = state.watchlist.filter((w) => w.secid !== hit.secid);
  else {
    state.watchlist = [
      ...state.watchlist,
      { secid: hit.secid, code: hit.code, market: hit.market, name: hit.name, etf: hit.etf },
    ];
  }
  persist();
  render();
  refreshQuotes();
}
/** 详情页把非自选标的（如 ETF 成分股）一键加入自选。 */
function addCurrentToWatch(secid: string) {
  const q = quoteFor(secid);
  if (!q || state.watchlist.some((w) => w.secid === secid)) return;
  state.watchlist = [
    ...state.watchlist,
    { secid, code: q.code, market: q.market, name: q.name, etf: /ETF/i.test(q.name) || undefined },
  ];
  persist();
  render();
  toast(`已添加「${q.name}」到自选`);
}

// ── 轻量 toast ───────────────────────────────────────────────────────────────
let toastTimer: number | undefined;
function toast(msg: string) {
  document.querySelector('.toast')?.remove();
  const el = h('div', { class: 'toast' }, msg);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 2200) as unknown as number;
}

// v6 设计：无独立头部行，指数条置顶；每个芯片带该市场交易状态点（绿=交易中）。
// 排序：开市中的市场优先展示（如 15:00 后 A 股收市→恒生提前；夜盘→纳斯达克提前），
// 组内保持原有顺序；全部休市时回落到默认顺序。
function renderIndexStrip() {
  const { up, down } = colors();
  const bySecid = new Map(state.indices.map((q) => [q.secid, q]));
  const ordered = INDEX_SECIDS
    .map((entry, i) => ({ entry, i, open: marketOpen(entry[2]) }))
    .sort((a, b) => Number(b.open) - Number(a.open) || a.i - b.i)
    .map((x) => x.entry);
  return h(
    'div',
    { class: 'idx-strip' },
    ordered.map(([secid, name, mkt]) => {
      const q = bySecid.get(secid);
      const has = !!q && Number.isFinite(q.price);
      const c = has ? (q!.changePct >= 0 ? up : down) : 'var(--sub)';
      const open = marketOpen(mkt);
      const mktCn = mkt === 'A' ? 'A股' : mkt === 'HK' ? '港股' : '美股';
      return h('div', { class: 'idx-chip', title: `${mktCn}${open ? ' · 交易中' : ' · 休市'}` }, [
        h('div', { class: 'idx-top' }, [
          h('span', { class: `idx-dot${open ? ' open' : ''}` }),
          h('span', { class: 'idx-name' }, name),
        ]),
        h('div', { class: 'idx-vals' }, [
          h('span', { class: 'idx-val', style: `color:${c}` }, has ? fmt(q!.price, 2) : '—'),
          h('span', { class: 'idx-pct', style: `color:${c}` }, has ? sgn(q!.changePct, 2) + '%' : ''),
        ]),
      ]);
    })
  );
}

// ── render: list ─────────────────────────────────────────────────────────────
function mktTag(m: Market) {
  const k = MKT[m];
  return h('span', { class: 'mkt-tag', style: `color:${k.fg};background:${k.bg}` }, k.tag);
}

function renderRow(w: WatchItem) {
  const { up, down } = colors();
  const q = quoteFor(w.secid);
  const s = state.settings;
  const dec = q?.otc ? 4 : q ? decimalsFor(q.price) : 2;
  const color = q ? (q.changePct >= 0 ? up : down) : 'var(--sub)';
  const pnl = q ? pnlOf(q, w.hold, up, down) : null;
  const est = q?.otc ? fundEstimate(w.secid) : null;
  const menuOpen = state.menu === w.secid;
  const showHold = s.toggles.pnl;
  return h(
    'div',
    {
      class: `row${menuOpen ? ' menu-open' : ''}`,
      onclick: () => openDetail(w.secid),
      oncontextmenu: (e: Event) => openMenu(w.secid, e),
    },
    [
      h('div', { class: 'row-main' }, [
        h('div', { class: 'row-top' }, [
          h('span', { class: 'row-name' }, q?.name ?? w.name),
          mktTag(w.market),
          q?.otc ? h('span', { class: 'otc-tag', title: '场外基金 · 显示最新净值，非实时行情' }, '场外') : null,
          w.star ? h('span', { class: 'star', title: '特别关注' }, '★') : null,
          w.pinned || w.pinnedBottom ? h('span', { class: 'pin-badge' }, w.pinned ? '置顶' : '置底') : null,
        ]),
        h('div', { class: 'code' }, w.code),
      ]),
      h('div', { class: 'row-price' }, [
        h('div', { class: 'price', style: `color:${color}` }, q ? fmt(q.price, dec) : '—'),
        s.toggles.chg
          ? q?.otc
            ? h('div', { class: 'chg', style: 'color:var(--sub)', title: '净值日期（非实时）' }, `净值 ${(q.navDate ?? '').slice(5)}`)
            : h('div', { class: 'chg', style: `color:${color}` }, q ? sgn(q.changeAmt, dec) : '')
          : null,
      ]),
      h('div', { class: 'row-pct' }, [
        // 场外基金：该列语义是「当日」——主徽章放今日盘中估算，昨日净值涨跌降为下行小字
        q?.otc && est
          ? h('div', {
              class: 'pct-badge',
              title: `盘中估算 · 按 ${est.asOf} 前十大持仓加权，非官方数据`,
              style: `background:${est.pct >= 0 ? up : down};box-shadow:0 2px 6px ${hexToRgba(est.pct >= 0 ? up : down, 0.28)}`,
            }, `估 ${sgn(est.pct, 2)}%`)
          : h('div', { class: 'pct-badge', style: `background:${color};box-shadow:0 2px 6px ${hexToRgba(color === up ? up : down, 0.28)}` }, q ? sgn(q.changePct, 2) + '%' : '—'),
        s.toggles.today
          ? q?.otc
            ? est
              ? h('div', { class: 'day', title: '昨日净值涨跌', style: `color:${color}` }, `昨 ${sgn(q.changePct, 2)}%`)
              : h('div', { class: 'day na' }, '—')
            : h('div', { class: `day${pnl ? '' : ' na'}`, title: '当日盈亏', style: pnl ? `color:${pnl.dayColor}` : '' }, pnl ? pnl.dayText : '—')
          : null,
      ]),
      showHold
        ? h('div', { class: 'row-hold' }, [
            h('div', { class: `pnl${pnl ? '' : ' na'}`, title: '持有盈亏', style: pnl ? `color:${pnl.color}` : '' }, pnl ? pnl.amtText : '—'),
            pnl ? h('div', { class: 'pnl-pct', style: `color:${pnl.color}` }, pnl.pctText) : null,
          ])
        : null,
    ]
  );
}

function renderRowMenu(w: WatchItem) {
  const defs = groupDefs();
  const curDef = defs[Math.min(state.group, defs.length - 1)];
  const rmLabel = curDef.custom ? `移出「${curDef.label}」` : '删除自选';
  const rmAction = curDef.custom ? () => removeFromGroup(w.secid, curDef.label) : () => removeFromWatch(w.secid);
  const item = (label: string, onClick: () => void, cls = '') =>
    h('div', { class: `row-menu-item ${cls}`, onclick: (e: Event) => { e.stopPropagation(); onClick(); } }, label);
  // 浮层定位：跟随鼠标、贴边自动收拢（尺寸按 5 项菜单估算，误差由 8px 余量吸收）
  const MENU_W = 172;
  const MENU_H = 218;
  const x = Math.max(8, Math.min(state.menuPos.x, innerWidth - MENU_W - 8));
  const y = Math.max(8, Math.min(state.menuPos.y, innerHeight - MENU_H - 8));
  return h('div', { class: 'row-menu', style: `left:${x}px;top:${y}px`, onclick: (e: Event) => e.stopPropagation() }, [
    item(w.pinned ? '取消置顶' : '置顶', () => togglePin(w.secid)),
    item(w.pinnedBottom ? '取消置底' : '置底', () => togglePinBottom(w.secid)),
    item(w.star ? '取消特别关注' : '特别关注', () => toggleStar(w.secid)),
    item('分组 / 持仓设置', () => openHold(w.secid)),
    item(rmLabel, rmAction, 'danger'),
  ]);
}

function renderList() {
  const s = state.settings;
  const defs = groupDefs();
  const gi = Math.min(state.group, defs.length - 1);
  const curDef = defs[gi];
  const rows = sortedWatchlist().filter(curDef.f);
  const emptyText =
    curDef.label === '持仓'
      ? '暂无持仓 · 在添加页为股票配置份额与成本后显示'
      : curDef.custom
        ? `「${curDef.label}」分组暂无股票 · 右键股票可移入分组`
        : '还没有自选 · 点右上角 ＋ 添加股票';
  const menuItem = state.menu ? state.watchlist.find((w) => w.secid === state.menu) : undefined;
  return h('div', { class: 'screen' }, [
    state.menu
      ? h('div', {
          class: 'menu-overlay',
          onclick: () => closeMenu(),
          oncontextmenu: (e: Event) => {
            e.preventDefault();
            closeMenu();
          },
        })
      : null,
    // 右键菜单渲染在屏幕层（fixed 浮层），不嵌在行内，避免被列表裁剪/视觉粘连
    menuItem ? renderRowMenu(menuItem) : null,
    h('div', { class: 'groups' }, [
      h('div', { class: 'seg group-seg' }, defs.map((g, i) =>
        h('button', { class: `seg-item ${i === gi ? 'active' : ''}`, onclick: () => setState({ group: i }) }, g.label)
      )),
    ]),
    h('div', { class: 'col-head' }, [
      h('div', { class: 'c-name' }, '名称 · 代码'),
      h('div', { class: 'c-price' }, '现价·涨跌'),
      h('div', { class: 'c-pct' }, s.toggles.today ? '涨跌幅·当日' : '涨跌幅'),
      s.toggles.pnl ? h('div', { class: 'c-hold' }, '持有盈亏') : null,
    ]),
    state.permsMissing
      ? h('div', { class: 'offline-banner' }, [
          h('span', {}, '行情站点访问权限未开启，无法拉取实时数据。'),
          h('button', { class: 'grant-btn', onclick: () => grantPerms() }, '一键授权'),
        ])
      : router.isOffline()
        ? h('div', { class: 'offline-banner' }, '⚠ 行情接口不可达，当前为示例数据 — 请检查网络后点右上角 ⟳ 重试')
        : null,
    h('div', { class: 'scroll zoomable' }, rows.length ? rows.map(renderRow) : [h('div', { class: 'empty-note' }, emptyText)]),
    // 底栏：仅更新时间（配色/频率等信息在设置页）+ 右侧快捷操作 ⟳ ＋ ⚙
    h('div', { class: 'footer' }, [
      h('div', { class: 'foot-status' }, [
        h('span', { class: 'foot-time' }, `${state.lastUpdated || '—'} 更新`),
      ]),
      h('button', { class: `qa-btn${state.refreshing ? ' spinning' : ''}`, title: '立即刷新', onclick: () => refreshQuotes() }, '⟳'),
      h('button', { class: 'qa-btn plus', title: '添加自选', onclick: () => setState({ screen: 'add', query: '', hits: [] }) }, '＋'),
      h('button', { class: 'qa-btn', title: '设置', onclick: () => setState({ screen: 'settings' }) }, '⚙'),
    ]),
  ]);
}

// ── render: detail ───────────────────────────────────────────────────────────
function renderDetail() {
  const { up, down } = colors();
  const secid = state.detailSecid!;
  const q = quoteFor(secid);
  const w = state.watchlist.find((x) => x.secid === secid);
  const m = q?.market ?? w?.market ?? 'SH';
  const k = MKT[m];
  const otc = !!q?.otc;
  if (otc) {
    // 幂等：已缓存/加载中会直接返回
    loadNavHistory(secid);
    loadFundHoldings(secid);
  }
  const est = otc ? fundEstimate(secid) : null;
  const dec = otc ? 4 : q ? decimalsFor(q.price) : 2;
  const color = q ? (q.changePct >= 0 ? up : down) : 'var(--fg)';
  const isIntraday = state.detailTab === '分时';
  // 分时坐标按市场时段映射：A股 240 分钟 / 港股 330 分钟 / 美股（美东）390 分钟
  const sessionKind: SessionKind = m === 'HK' ? 'HK' : m === 'US' ? 'US' : 'CN';
  let trends = isIntraday ? state.trends.get(secid) : undefined;
  if (trends && q && trends.points.length) {
    // Keep the intraday tail pinned to the live price / 昨收.
    const pts = trends.points.slice();
    pts[pts.length - 1] = { ...pts[pts.length - 1], price: q.price };
    trends = { ...trends, points: pts, prevClose: q.prevClose || trends.prevClose };
  }
  const klines = isIntraday ? undefined : state.klineCache.get(`${secid}:${state.detailTab}`);
  // 图表画布宽度跟随外壳布局宽度（反向缩放时外壳布局宽会大于 500）：
  // 价格卡外边距 14×2 + 内边距 16×2 = 60。
  const chartW = Math.max(380, (document.querySelector('.shell')?.clientWidth ?? 500) - 60);
  const chart = isIntraday
    ? trends
      ? timeShareChart(trends, { w: chartW, h: 156, padL: 8, padR: 48, padT: 8, padB: 18 }, sessionKind)
      : null
    : klines
      ? candleChart(klines, { w: chartW, h: 168, padL: 8, padR: 48, padT: 8, padB: 18 })
      : null;
  const chartEmptyMsg = isIntraday && trends && !trends.points.length ? '暂无分时数据 · 休市或数据源不可用' : '加载中…';
  const pnl = q && w ? pnlOf(q, w.hold, up, down) : null;

  return h('div', { class: 'screen scroll-y' }, [
    h('div', { class: 'sc-head' }, [
      h('button', { class: 'back-btn', onclick: () => setState({ detailSecid: null }) }, '‹'),
      h('div', { style: 'flex:1;min-width:0' }, [
        h('div', { class: 'dt-name' }, [h('span', { class: 'n' }, q?.name ?? w?.name ?? ''), mktTag(m)]),
        h('div', { class: 'code' }, `${w?.code ?? q?.code ?? secid.slice(secid.indexOf('.') + 1)} · ${k.where}`),
      ]),
      h('div', { title: '特别关注', style: `color:${w?.star ? '#ffb52e' : '#c4c4c9'};font-size:19px;cursor:pointer`, onclick: () => toggleStar(secid) }, w?.star ? '★' : '☆'),
    ]),

    h('div', { class: 'price-card' }, [
      h('div', { class: 'big-price' }, [
        h('div', { class: 'p', style: `color:${color}` }, q ? fmt(q.price, dec) : '—'),
        h('div', { class: 'c', style: `color:${color}` }, q ? `${sgn(q.changeAmt, dec)}　${sgn(q.changePct, 2)}%` : ''),
      ]),
      otc
        ? h('div', { class: 'nav-note' }, `场外基金 · 非实时行情 · 净值日期 ${q?.navDate || '—'}`)
        : h('div', { class: 'chart-tabs' }, (['分时', '日K', '周K', '月K'] as DetailTab[]).map((tab) =>
            h('button', { class: `seg-item ${state.detailTab === tab ? 'active' : ''}`, onclick: () => switchTab(secid, tab) }, tab)
          )),
      // 支付宝式盘中参考：按最新季报前十大持仓加权估算今日涨跌（明确标注非官方）
      otc && est
        ? h('div', { class: 'nav-est', style: `color:${est.pct >= 0 ? up : down}` },
            `盘中估算 ${sgn(est.pct, 2)}% · 按 ${est.asOf} 前十大持仓加权（覆盖约 ${est.coverage}% 仓位）· 非官方数据`)
        : null,
      otc ? renderNavChart(secid, chartW) : renderChart(chart, color, up, down, chartEmptyMsg),
      otc
        ? renderNavAxis(secid)
        : isIntraday
          ? h(
              'div',
              { class: 'chart-axis', style: 'padding-right:48px' },
              (sessionKind === 'HK'
                ? ['09:30', '12:00 / 13:00', '16:00']
                : sessionKind === 'US'
                  ? ['09:30', '12:45', '16:00']
                  : ['09:30', '11:30 / 13:00', '15:00']
              ).map((s) => h('span', {}, s))
            )
          : null,
      !otc && isIntraday
        ? h('div', { class: 'chart-legend' }, [
            h('span', {}, [h('span', { class: 'legend-swatch', style: `background:${color}` }), '分时']),
            h('span', {}, [h('span', { class: 'legend-swatch', style: 'background:#e0a13a' }), '均价']),
            h('span', {}, [h('span', { class: 'legend-swatch', style: 'border-top:1px dashed #b0b0b5;height:0' }), q ? `昨收 ${fmt(q.prevClose, dec)}` : '昨收']),
            sessionKind === 'US' ? h('span', {}, '美东时间') : null,
          ])
        : null,
    ]),

    q ? h('div', { class: 'metrics zoomable' }, metricsFor(q, up, down).map((mt) =>
      h('div', { class: 'metric' }, [h('div', { class: 'l' }, mt.label), h('div', { class: 'v', style: mt.color ? `color:${mt.color}` : '' }, mt.value)])
    )) : null,

    pnl && w?.hold ? h('div', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('span', { class: 't' }, '我的持仓'),
        h('span', { class: 's' }, `持有 ${w.hold.shares} 股 · 成本 ${fmt(w.hold.cost, dec)}`),
      ]),
      h('div', { class: 'hold-grid' }, [
        h('div', { class: 'hold-cell' }, [h('div', { class: 'l' }, '持仓市值'), h('div', { class: 'v' }, pnl.mvText)]),
        h('div', { class: 'hold-cell' }, [h('div', { class: 'l' }, '持有盈亏'), h('div', { class: 'v', style: `color:${pnl.color}` }, `${pnl.amtText} · ${pnl.pctText}`)]),
      ]),
    ]) : null,

    renderConstituents(secid),

    h('div', { class: 'actions' }, w
      ? [
          h('button', { class: 'btn ghost', onclick: () => addAlert(secid) }, '设置到价提醒'),
          h('button', { class: 'btn primary', onclick: () => openHold(secid) }, '分组 / 持仓设置'),
        ]
      : [
          h('button', { class: 'btn ghost', onclick: () => addAlert(secid) }, '设置到价提醒'),
          h('button', { class: 'btn primary', onclick: () => addCurrentToWatch(secid) }, '＋ 添加自选'),
        ]),
  ]);
}

// ── ETF 持仓成分股（设计稿：按权重排列 · 点击查看个股）──────────────────────
function renderConstituents(secid: string) {
  if (!isEtf(secid)) return null;
  const { up, down } = colors();
  const code = secid.slice(secid.indexOf('.') + 1);
  const cons = state.constituents.get(code);
  if (cons && !cons.length) return null; // 拉取过但无数据（如货币基金）
  return h('div', { class: 'panel' }, [
    h('div', { class: 'panel-head' }, [
      h('span', { class: 't' }, '持仓成分股'),
      h('span', { class: 's' }, '按权重排列 · 点击查看个股'),
    ]),
    !cons
      ? h('div', { class: 'cons-loading' }, '成分股加载中…')
      : h('div', {}, cons.slice(0, 10).map((c) => {
          const q = quoteFor(c.secid);
          const color = q ? (q.changePct >= 0 ? up : down) : 'var(--sub)';
          const cdec = q ? decimalsFor(q.price) : 2;
          return h('div', { class: 'cons-row', onclick: () => openDetail(c.secid) }, [
            h('div', { style: 'flex:1;min-width:0' }, [
              h('div', { class: 'row-top' }, [h('span', { class: 'cons-name' }, q?.name ?? c.name), mktTag(marketOfSecid(c.secid))]),
              h('div', { class: 'code' }, `权重 ${c.weight.toFixed(2)}%`),
            ]),
            h('div', { class: 'cons-price', style: `color:${color}` }, q ? fmt(q.price, cdec) : '—'),
            h('div', { class: 'pct-badge sm', style: `background:${color}` }, q ? sgn(q.changePct, 2) + '%' : '—'),
            h('span', { class: 'chev' }, '›'),
          ]);
        })),
  ]);
}

// ── 场外基金净值走势（近 60 个交易日单位净值折线）────────────────────────────
function renderNavChart(secid: string, W: number) {
  const { up, down } = colors();
  const H = 156;
  const code = secid.slice(secid.indexOf('.') + 1);
  const hist = state.navCache.get(code);
  const empty = (msg: string) =>
    h('div', { class: 'chart-wrap' }, [
      svg('svg', { width: String(W), height: String(H), class: 'chart' }, [
        svg('text', { x: String(W / 2), y: String(H / 2), 'text-anchor': 'middle', fill: 'var(--sub)', 'font-size': '12' }, msg),
      ]),
    ]);
  if (!hist) return empty('净值走势加载中…');
  if (hist.length < 2) return empty('暂无净值走势数据');
  const color = hist[hist.length - 1].nav >= hist[0].nav ? up : down;
  const trends: Trends = { secid, prevClose: hist[0].nav, points: hist.map((p) => ({ t: p.date.slice(5), price: p.nav, vol: 0 })) };
  const c = buildTrendChart(trends, W, H)!;
  const navs = hist.map((p) => p.nav);
  const mx = Math.max(...navs);
  const mn = Math.min(...navs);
  const svgEl = svg('svg', { width: String(W), height: String(H), viewBox: `0 0 ${W} ${H}`, class: 'chart' }, [
    svg('defs', {}, [
      svg('linearGradient', { id: 'navFill', x1: '0', y1: '0', x2: '0', y2: '1' }, [
        svg('stop', { offset: '0', 'stop-color': color, 'stop-opacity': '0.18' }),
        svg('stop', { offset: '1', 'stop-color': color, 'stop-opacity': '0' }),
      ]),
    ]),
    svg('path', { d: c.area, fill: 'url(#navFill)' }),
    svg('path', { d: c.line, fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    svg('circle', { cx: c.lastX.toFixed(1), cy: c.lastY.toFixed(1), r: '3', fill: color }),
    svg('circle', { cx: c.lastX.toFixed(1), cy: c.lastY.toFixed(1), r: '6.5', fill: color, opacity: '0.16' }),
    svg('text', { x: String(W - 4), y: '14', 'text-anchor': 'end', 'font-size': '9', fill: 'var(--sub)', 'font-variant-numeric': 'tabular-nums' }, fmt(mx, 4)),
    svg('text', { x: String(W - 4), y: String(H - 6), 'text-anchor': 'end', 'font-size': '9', fill: 'var(--sub)', 'font-variant-numeric': 'tabular-nums' }, fmt(mn, 4)),
  ]);
  return h('div', { class: 'chart-wrap' }, [svgEl]);
}

function renderNavAxis(secid: string) {
  const code = secid.slice(secid.indexOf('.') + 1);
  const hist = state.navCache.get(code);
  if (!hist || hist.length < 2) return null;
  return h('div', { class: 'chart-axis' }, [
    h('span', {}, hist[0].date),
    h('span', {}, `净值走势 · 近 ${hist.length} 个交易日`),
    h('span', {}, hist[hist.length - 1].date),
  ]);
}

function marketOfSecid(secid: string): Market {
  const pfx = secid.slice(0, secid.indexOf('.'));
  return pfx === '1' ? 'SH' : pfx === '0' ? 'SZ' : pfx === '116' ? 'HK' : 'US';
}

function renderChart(chart: TimeShareChart | CandleChart | null, color: string, up: string, down: string, emptyMsg = '加载中…') {
  const W = chart ? chart.w : 436;
  const H = chart ? chart.h : 156;
  if (!chart) {
    return h('div', { class: 'chart-wrap' }, [
      svg('svg', { width: String(W), height: String(H), class: 'chart' }, [
        svg('text', { x: String(W / 2), y: String(H / 2), 'text-anchor': 'middle', fill: 'var(--sub)', 'font-size': '12' }, emptyMsg),
      ]),
    ]);
  }
  const prevClose = chart.points[0]?.prevClose ?? 0;
  const dec = decimalsFor(prevClose || chart.points[0]?.price || 1);
  const gridR = W - chart.padR;

  // price grid + right-side labels
  const yEls: (Node | null)[] = [];
  for (const tick of chart.yTicks) {
    const isPrev = chart.kind === 'time' && Math.abs(tick.pct ?? 1) < 1e-6;
    yEls.push(
      svg('line', {
        x1: String(chart.padL), y1: tick.pos.toFixed(1), x2: String(gridR), y2: tick.pos.toFixed(1),
        stroke: isPrev ? 'rgba(120,120,128,.45)' : 'var(--sep)', 'stroke-width': isPrev ? '1' : '0.6',
        'stroke-dasharray': isPrev ? '4 3' : '',
      })
    );
    const lblColor =
      chart.kind === 'time'
        ? (tick.pct ?? 0) > 0 ? up : (tick.pct ?? 0) < 0 ? down : 'var(--sub)'
        : 'var(--sub)';
    yEls.push(
      svg('text', { x: String(W - 4), y: (tick.pos + 3).toFixed(1), 'text-anchor': 'end', 'font-size': '9', fill: lblColor, 'font-variant-numeric': 'tabular-nums' }, fmt(tick.price ?? 0, dec))
    );
  }

  const seriesEls: Node[] = [];
  if (chart.kind === 'time') {
    seriesEls.push(
      svg('defs', {}, [
        svg('linearGradient', { id: 'areaFill', x1: '0', y1: '0', x2: '0', y2: '1' }, [
          svg('stop', { offset: '0', 'stop-color': color, 'stop-opacity': '0.18' }),
          svg('stop', { offset: '1', 'stop-color': color, 'stop-opacity': '0' }),
        ]),
      ]),
      svg('path', { d: chart.area, fill: 'url(#areaFill)' }),
      svg('path', { d: chart.avg, fill: 'none', stroke: '#e0a13a', 'stroke-width': '1.1', opacity: '0.8' }),
      svg('path', { d: chart.line, fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
      svg('circle', { cx: chart.lastX.toFixed(1), cy: chart.lastY.toFixed(1), r: '3', fill: color }),
      svg('circle', { cx: chart.lastX.toFixed(1), cy: chart.lastY.toFixed(1), r: '6.5', fill: color, opacity: '0.16' })
    );
  } else {
    for (const c of chart.candles) {
      const cc = c.up ? up : down;
      seriesEls.push(
        svg('line', { x1: c.cx.toFixed(1), y1: c.wickTop.toFixed(1), x2: c.cx.toFixed(1), y2: c.wickBot.toFixed(1), stroke: cc, 'stroke-width': '1' }),
        svg('rect', { x: c.x.toFixed(1), y: c.bodyTop.toFixed(1), width: c.bw.toFixed(1), height: c.bodyH.toFixed(1), fill: cc, rx: '0.4' })
      );
    }
    chart.xTicks.forEach((xt, i) => {
      // 首尾刻度分别左/右对齐，避免被图表边缘裁切。
      const isFirst = i === 0;
      const isLast = i === chart.xTicks.length - 1;
      const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle';
      const x = isFirst ? chart.padL : isLast ? Math.min(xt.pos + 10, W - chart.padR) : xt.pos;
      seriesEls.push(
        svg('text', { x: x.toFixed(1), y: String(H - 5), 'text-anchor': anchor, 'font-size': '9', fill: 'var(--sub)', 'font-variant-numeric': 'tabular-nums' }, xt.label ?? '')
      );
    });
  }

  // crosshair (hidden until hover) + transparent capture layer
  const vline = svg('line', { stroke: 'var(--sub2)', 'stroke-width': '0.8', 'stroke-dasharray': '3 3', opacity: '0' });
  const hdot = svg('circle', { r: '3.5', fill: color, stroke: 'var(--popbg)', 'stroke-width': '1', opacity: '0' });
  const capture = svg('rect', { x: '0', y: '0', width: String(W), height: String(H), fill: 'transparent', 'pointer-events': 'all' });

  const svgEl = svg('svg', { width: String(W), height: String(H), viewBox: `0 0 ${W} ${H}`, class: 'chart' }, [
    ...yEls.filter(Boolean) as Node[],
    ...seriesEls,
    vline,
    hdot,
    capture,
  ]) as SVGSVGElement;

  const tip = h('div', { class: 'chart-tip' });
  tip.style.display = 'none';
  const wrap = h('div', { class: 'chart-wrap' }, [svgEl, tip]);
  attachHover(svgEl, tip, chart, vline as SVGLineElement, hdot as SVGCircleElement, up, down, dec, W, H);
  return wrap;
}

function attachHover(
  svgEl: SVGSVGElement,
  tip: HTMLElement,
  chart: TimeShareChart | CandleChart,
  vline: SVGLineElement,
  hdot: SVGCircleElement,
  up: string,
  down: string,
  dec: number,
  W: number,
  H: number
) {
  const move = (e: MouseEvent) => {
    const rect = svgEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / (rect.width || W));
    const pt = nearestPoint(chart.points, x);
    if (!pt) return;
    vline.setAttribute('x1', pt.x.toFixed(1));
    vline.setAttribute('x2', pt.x.toFixed(1));
    vline.setAttribute('y1', String(chart.padT));
    vline.setAttribute('y2', String(H - chart.padB));
    vline.setAttribute('opacity', '1');
    hdot.setAttribute('cx', pt.x.toFixed(1));
    hdot.setAttribute('cy', pt.y.toFixed(1));
    hdot.setAttribute('opacity', '1');
    tip.replaceChildren(...tooltipRows(chart.kind, pt, up, down, dec));
    tip.style.display = 'block';
    const tipW = 104;
    let left = pt.x + 12;
    if (left + tipW > W) left = pt.x - tipW - 12;
    tip.style.left = Math.max(2, left).toFixed(0) + 'px';
    tip.style.top = '4px';
  };
  const leave = () => {
    vline.setAttribute('opacity', '0');
    hdot.setAttribute('opacity', '0');
    tip.style.display = 'none';
  };
  svgEl.addEventListener('mousemove', move);
  svgEl.addEventListener('mouseleave', leave);
}

function tooltipRows(kind: 'time' | 'kline', pt: ChartPoint, up: string, down: string, dec: number): Node[] {
  const chgPct = pt.prevClose ? ((pt.price - pt.prevClose) / pt.prevClose) * 100 : 0;
  const c = chgPct >= 0 ? up : down;
  const row = (k: string, v: string, color?: string) =>
    h('div', { class: 'tip-row' }, [h('span', { class: 'tip-k' }, k), h('span', { class: 'tip-v', style: color ? `color:${color}` : '' }, v)]);
  const rows: Node[] = [h('div', { class: 'tip-title' }, pt.t)];
  if (kind === 'time') {
    rows.push(row('价', fmt(pt.price, dec), c), row('均', fmt(pt.avg ?? pt.price, dec)), row('涨幅', sgn(chgPct, 2) + '%', c));
  } else {
    rows.push(
      row('开', fmt(pt.open ?? pt.price, dec)),
      row('高', fmt(pt.high ?? pt.price, dec), up),
      row('低', fmt(pt.low ?? pt.price, dec), down),
      row('收', fmt(pt.price, dec), c),
      row('涨幅', sgn(chgPct, 2) + '%', c)
    );
  }
  return rows;
}

async function switchTab(secid: string, tab: DetailTab) {
  state.detailTab = tab;
  render();
  if (tab === '分时') {
    if (!state.trends.has(secid)) loadTrends(secid);
    return;
  }
  const cacheKey = `${secid}:${tab}`;
  if (state.klineCache.has(cacheKey)) return;
  const klt = tab === '日K' ? 101 : tab === '周K' ? 102 : 103;
  try {
    const kl = await router.getKline(secid, klt);
    if (kl.length) {
      state.klineCache.set(cacheKey, kl);
      render();
    }
  } catch (e) {
    console.error('[popup] kline failed', e);
  }
}

function toggleStar(secid: string) {
  // 特别关注 / 收藏。非自选标的（如成分股详情页）先加自选再收藏 —— 闭环。
  if (!state.watchlist.some((w) => w.secid === secid)) {
    const q = quoteFor(secid);
    if (!q) return;
    state.watchlist = [
      ...state.watchlist,
      { secid, code: q.code, market: q.market, name: q.name, etf: /ETF/i.test(q.name) || undefined, star: true },
    ];
    toast(`已添加「${q.name}」到自选并特别关注`);
  } else {
    state.watchlist = state.watchlist.map((w) => (w.secid === secid ? { ...w, star: !w.star } : w));
  }
  state.menu = null;
  persist();
  render();
}
function togglePin(secid: string) {
  // 置顶（与置底互斥：开启置顶则清除置底）
  const on = !state.watchlist.find((w) => w.secid === secid)?.pinned;
  state.watchlist = state.watchlist.map((w) => {
    if (w.secid !== secid) return w;
    return { ...w, pinned: on, pinnedBottom: on ? false : w.pinnedBottom };
  });
  // 新置顶的移到最前：多只置顶时最新置顶排第一，列表显示与工具栏角标都盯它
  if (on) {
    const item = state.watchlist.find((w) => w.secid === secid)!;
    state.watchlist = [item, ...state.watchlist.filter((w) => w.secid !== secid)];
  }
  state.menu = null;
  persist();
  render();
}
function togglePinBottom(secid: string) {
  // 置底（与置顶互斥：开启置底则清除置顶）；新置底的沉到最末
  const on = !state.watchlist.find((w) => w.secid === secid)?.pinnedBottom;
  state.watchlist = state.watchlist.map((w) => {
    if (w.secid !== secid) return w;
    return { ...w, pinnedBottom: on, pinned: on ? false : w.pinned };
  });
  if (on) {
    const item = state.watchlist.find((w) => w.secid === secid)!;
    state.watchlist = [...state.watchlist.filter((w) => w.secid !== secid), item];
  }
  state.menu = null;
  persist();
  render();
}

// ── 自选设置（分组 + 持仓）modal ──────────────────────────────────────────────
function openHold(secid: string) {
  const w = state.watchlist.find((x) => x.secid === secid);
  state.editHold = secid;
  state.menu = null;
  state.groupDraft = [...(w?.groups ?? [])];
  state.newGroupName = '';
  state.holdDraft = { shares: w?.hold ? String(w.hold.shares) : '', cost: w?.hold ? String(w.hold.cost) : '' };
  render();
}
function closeHold() {
  state.editHold = null;
  render();
}
function toggleGroupDraft(name: string) {
  state.groupDraft = state.groupDraft.includes(name)
    ? state.groupDraft.filter((x) => x !== name)
    : [...state.groupDraft, name];
  render();
}
function addGroup() {
  const n = state.newGroupName.trim();
  state.newGroupName = '';
  if (!n) return render();
  if (!state.groups.includes(n)) state.groups = [...state.groups, n];
  if (!state.groupDraft.includes(n)) state.groupDraft = [...state.groupDraft, n];
  persist();
  render();
}
/** 删除分组：从分组列表、所有自选的分组归属和当前草稿中一并移除（设计稿 chip 悬停 ✕）。 */
function deleteGroup(name: string) {
  state.groups = state.groups.filter((g) => g !== name);
  state.watchlist = state.watchlist.map((w) =>
    w.groups?.includes(name) ? { ...w, groups: w.groups.filter((g) => g !== name) } : w
  );
  state.groupDraft = state.groupDraft.filter((g) => g !== name);
  state.group = 0; // 回到「全部自选」，避免停留在已删除的分组标签
  persist();
  render();
}
function saveHold() {
  const secid = state.editHold;
  if (!secid) return;
  const shares = parseFloat(state.holdDraft.shares) || 0;
  const cost = parseFloat(state.holdDraft.cost) || 0;
  state.watchlist = state.watchlist.map((w) =>
    w.secid === secid
      ? { ...w, hold: shares > 0 ? { shares, cost } : undefined, groups: state.groupDraft.length ? [...state.groupDraft] : undefined }
      : w
  );
  state.editHold = null;
  persist();
  render();
  refreshQuotes();
}
function clearHoldDraft() {
  state.holdDraft = { shares: '', cost: '' };
  render();
}
function removeFromGroup(secid: string, group: string) {
  state.watchlist = state.watchlist.map((w) =>
    w.secid === secid ? { ...w, groups: (w.groups ?? []).filter((g) => g !== group) } : w
  );
  state.menu = null;
  persist();
  render();
}
function removeFromWatch(secid: string) {
  state.watchlist = state.watchlist.filter((w) => w.secid !== secid);
  state.menu = null;
  persist();
  render();
  refreshQuotes();
}
function openMenu(secid: string, e: Event) {
  e.preventDefault();
  e.stopPropagation();
  const me = e as MouseEvent;
  state.menuPos = { x: me.clientX, y: me.clientY };
  state.menu = state.menu === secid ? null : secid;
  render();
}
function closeMenu() {
  if (state.menu === null) return;
  state.menu = null;
  render();
}

/**
 * 排序规则见 core/compute.displaySort（弹窗与角标共用）；
 * 这里只额外叠加 E2E/预览的 forceopen 覆盖。
 */
function sortedWatchlist(): WatchItem[] {
  return displaySort(state.watchlist, marketOpen);
}

function addAlert(secid: string) {
  const q = quoteFor(secid);
  const w = state.watchlist.find((x) => x.secid === secid);
  const cur = q ? fmt(q.price, decimalsFor(q.price)) : '';
  const input = prompt(`为「${q?.name ?? w?.name ?? secid}」设置到价提醒\n当前价 ${cur}，输入目标价：`);
  if (!input) return;
  const value = parseFloat(input);
  if (!Number.isFinite(value) || !q) return;
  state.alerts = [
    ...state.alerts.filter((a) => !(a.secid === secid && a.value === value)),
    { secid, name: q.name, dir: value >= q.price ? 'above' : 'below', value, once: true },
  ];
  persist();
  alert(`已设置：${q.name} ${value >= q.price ? '涨到' : '跌到'} ${value} 时提醒`);
}

// ── render: add ──────────────────────────────────────────────────────────────
function renderAdd() {
  const { up } = colors();
  const chips: AddMkt[] = ['全部', '沪深', '港股', '美股', 'ETF'];
  const mkMatch = (hit: SearchHit) => {
    const am = state.addMkt;
    if (am === '全部') return true;
    if (am === '沪深') return (hit.market === 'SH' || hit.market === 'SZ') && !hit.etf;
    if (am === '港股') return hit.market === 'HK';
    if (am === '美股') return hit.market === 'US';
    if (am === 'ETF') return !!hit.etf;
    return true;
  };
  // With no query, show the current watch list (all marked 已添加).
  const baseHits: SearchHit[] = state.query.trim()
    ? state.hits
    : state.watchlist.map((w) => ({ secid: w.secid, code: w.code, market: w.market, name: w.name, etf: w.etf }));
  const list = baseHits.filter(mkMatch);

  return h('div', { class: 'screen' }, [
    h('div', { class: 'sc-head' }, [
      h('button', { class: 'back-btn', onclick: () => setState({ screen: null }) }, '‹'),
      h('div', { class: 'sc-title' }, '添加自选'),
      h('div', { class: 'sc-action', onclick: () => setState({ screen: null }) }, '完成'),
    ]),
    h('div', { class: 'search' }, [
      h('span', { style: 'color:var(--sub);font-size:14px' }, '🔍'),
      h('input', {
        id: 'add-search',
        value: state.query,
        placeholder: '输入代码 / 名称 / 拼音，支持批量添加',
        oncompositionstart: () => {
          imeComposing = true;
        },
        oncompositionend: (e: Event) => {
          imeComposing = false;
          state.query = (e.target as HTMLInputElement).value;
          scheduleSearch();
        },
        oninput: (e: Event) => {
          state.query = (e.target as HTMLInputElement).value;
          if (!imeComposing) scheduleSearch(); // wait for compositionend when using an IME
        },
      }),
    ]),
    h('div', { class: 'mkt-chips' }, chips.map((c) =>
      h('button', { class: 'mkt-chip', style: state.addMkt === c ? `color:#fff;background:${up};font-weight:600` : '', onclick: () => setState({ addMkt: c }) }, c)
    )),
    h('div', { class: 'scroll zoomable', id: 'add-list' }, renderAddRows(list)),
    h('div', { class: 'footer-mini' }, [
      h('span', {}, `当前自选 ${state.watchlist.length} 只`),
      h('span', {}, '点右上角完成保存'),
    ]),
  ]);
}

function renderAddRows(list: SearchHit[]) {
  const { up, down } = colors();
  if (!list.length) {
    return [h('div', { class: 'src-note', style: 'padding:24px;text-align:center' }, state.query.trim() ? `没有匹配「${state.query.trim()}」的股票` : '暂无自选 · 在上方搜索添加')];
  }
  return list.map((hit) => {
    const q = quoteFor(hit.secid);
    const w = state.watchlist.find((x) => x.secid === hit.secid);
    const dec = q ? decimalsFor(q.price) : 2;
    const color = q ? (q.changePct >= 0 ? up : down) : 'var(--sub)';
    return h('div', { class: 'u-row' }, [
      h('div', { style: 'flex:1;min-width:0' }, [
        h('div', { class: 'row-top' }, [h('span', { class: 'row-name' }, hit.name), mktTag(hit.market)]),
        h('div', { class: 'code' }, hit.code),
      ]),
      h('div', { style: 'text-align:right;width:80px' }, [
        h('div', { class: 'price', style: `color:${color}` }, q ? fmt(q.price, dec) : '—'),
        h('div', { class: 'chg', style: `color:${color}` }, q ? sgn(q.changePct, 2) + '%' : ''),
      ]),
      // Already-added rows: 配置/已配置 + 移除.  Not added: single ＋添加.
      w
        ? h('div', { class: 'u-actions' }, [
            h('button', { class: `u-btn cfg ${w.hold ? 'done' : ''}`, onclick: () => openHold(hit.secid) }, w.hold ? '已配置' : '配置'),
            h('button', { class: 'u-btn rm', onclick: () => toggleWatch(hit) }, '移除'),
          ])
        : h('button', { class: 'u-btn add', onclick: () => toggleWatch(hit) }, '＋ 添加'),
    ]);
  });
}

// ── render: settings ─────────────────────────────────────────────────────────
function seg<T>(opts: Array<[string, NoInfer<T>]>, cur: T, set: (v: T) => void) {
  return h('div', { class: 'seg inline' }, opts.map(([label, v]) =>
    h('button', { class: `seg-item ${v === cur ? 'active' : ''}`, onclick: () => set(v) }, label)
  ));
}
function switchRow(label: string, on: boolean, toggle: () => void, sub?: string) {
  return h('div', { class: 'switch-row' }, [
    h('div', {}, [h('span', { class: 'l' }, label), sub ? h('div', { class: 'muted' }, sub) : null]),
    h('div', { class: `switch ${on ? 'on' : ''}`, style: on ? `background:${colors().down}` : '', onclick: toggle }, [h('div', { class: 'knob' })]),
  ]);
}
function updateSetting(patch: Partial<Settings>) {
  state.settings = { ...state.settings, ...patch };
  persist();
  applyTheme();
  restartLoop();
  render();
}

function renderSettings() {
  const s = state.settings;
  return h('div', { class: 'screen scroll-y' }, [
    h('div', { class: 'sc-head' }, [
      h('button', { class: 'back-btn', onclick: () => setState({ screen: null }) }, '‹'),
      h('div', { class: 'sc-title' }, '设置'),
    ]),
    h('div', { class: 'set-card' }, [
      h('div', { class: 'set-title' }, '外观'),
      h('div', { class: 'set-field' }, [h('div', { class: 'set-label' }, '主题'), seg([['浅色', 'light'], ['深色', 'dark'], ['跟随系统', 'auto']], s.theme, (v) => updateSetting({ theme: v }))]),
      h('div', { class: 'set-field' }, [h('div', { class: 'set-label' }, '涨跌颜色'), seg([['红涨绿跌', 'rg'], ['绿涨红跌', 'gr']], s.colorMode, (v) => updateSetting({ colorMode: v }))]),
      h('div', { class: 'set-field' }, [h('div', { class: 'set-label' }, '字号'), seg([['标准', 'std'], ['大号', 'lg']], s.fontSize, (v) => updateSetting({ fontSize: v }))]),
    ]),
    h('div', { class: 'set-card' }, [
      h('div', { class: 'set-title' }, '列表内容'),
      switchRow('显示涨跌额', s.toggles.chg, () => updateSetting({ toggles: { ...s.toggles, chg: !s.toggles.chg } })),
      switchRow('显示当日盈亏', s.toggles.today, () => updateSetting({ toggles: { ...s.toggles, today: !s.toggles.today } })),
      switchRow('显示持有盈亏', s.toggles.pnl, () => updateSetting({ toggles: { ...s.toggles, pnl: !s.toggles.pnl } })),
    ]),
    h('div', { class: 'set-card' }, [
      h('div', { class: 'set-title' }, '角标与刷新'),
      h('div', { class: 'set-field' }, [h('div', { class: 'set-label' }, '图标角标'), seg([['关闭', 'off'], ['单只股票', 'single'], ['全部盈亏', 'all']], s.badgeMode, (v) => updateSetting({ badgeMode: v }))]),
      h('div', { class: 'set-field' }, [
        h('div', { class: 'set-label' }, '刷新频率'),
        seg([['3 分钟', 3], ['5 分钟', 5], ['10 分钟', 10]], s.refreshCustom && s.refreshCustom > 0 ? -1 : s.refresh, (v) => updateSetting({ refresh: v, refreshCustom: undefined })),
        h('div', { class: 'custom-refresh' }, [
          h('span', { class: 'cr-label' }, '自定义'),
          h('input', {
            id: 'refresh-custom',
            type: 'number',
            min: '1',
            placeholder: '分钟数',
            value: s.refreshCustom != null ? String(s.refreshCustom) : '',
            oninput: (e: Event) => {
              const raw = (e.target as HTMLInputElement).value.trim();
              const v = parseInt(raw, 10);
              updateSetting({ refreshCustom: raw && Number.isFinite(v) && v > 0 ? v : undefined });
            },
          }),
          h('span', { class: 'cr-label' }, '分钟'),
        ]),
      ]),
      switchRow('节假日自动切换休市', s.toggles.holiday, () => updateSetting({ toggles: { ...s.toggles, holiday: !s.toggles.holiday } })),
    ]),
    h('div', { class: 'set-card', style: 'padding:0;overflow:hidden' }, [
      h('div', { class: 'list-item' }, [
        h('div', {}, [h('div', { class: 'set-label', style: 'margin:0;font-weight:600' }, '账号同步'), h('div', { class: 'muted' }, '登录后自选与配置跨设备同步')]),
        h('button', { class: 'pill-btn', onclick: () => toast('账号同步即将上线 · 当前数据保存在本地') }, '登录'),
      ]),
      h('div', { class: 'list-item tappable', onclick: importConfig }, [h('span', { class: 'set-label', style: 'margin:0' }, '导入配置'), h('span', { class: 'chev' }, '›')]),
      h('div', { class: 'list-item tappable', onclick: exportConfig }, [h('span', { class: 'set-label', style: 'margin:0' }, '导出配置'), h('span', { class: 'chev' }, '›')]),
    ]),
    h('div', { class: 'set-card', style: 'padding:0;overflow:hidden' }, [
      h('div', { class: 'list-item' }, [h('span', { class: 'set-label', style: 'margin:0' }, '当前版本'), h('span', { class: 'muted' }, inExtension() ? `v${chrome.runtime.getManifest().version}` : 'dev')]),
      h('div', { class: 'list-item' }, [
        h('span', { class: 'set-label', style: 'margin:0' }, '数据源'),
        h('span', { class: 'muted' }, router.isOffline()
          ? '示例数据（离线）'
          : (router.lastQuoteSources.length ? router.lastQuoteSources.map((n) => SOURCE_LABEL[n]).join(' · ') : '腾讯 · 新浪 · 东方财富') + ' 多源自动切换'),
      ]),
      h('div', { class: 'list-item tappable', onclick: () => setState({ aboutModal: 'source' }) }, [h('span', { class: 'set-label', style: 'margin:0' }, '关于扩展'), h('span', { class: 'chev' }, '›')]),
      h('div', { class: 'list-item tappable', onclick: () => setState({ aboutModal: 'privacy' }) }, [h('span', { class: 'set-label', style: 'margin:0' }, '隐私协议'), h('span', { class: 'chev' }, '›')]),
    ]),
  ]);
}

// ── 关于弹窗（源码地址 / 隐私协议）──────────────────────────────────────────
function renderAboutModal() {
  const kind = state.aboutModal!;
  const title = kind === 'source' ? '关于扩展' : '隐私协议';
  const body =
    kind === 'source'
      ? [
          h('p', {}, '盯盘助手 · 实时行情盯盘 Chrome 扩展（Manifest V3，零运行时框架）。'),
          h('p', {}, '行情数据来自腾讯 / 新浪 / 东方财富公开行情接口，多源自动切换；所有数据仅在浏览器本地处理。'),
        ]
      : [
          h('p', {}, '本扩展不收集、不上传任何个人数据。'),
          h('p', {}, '自选列表、持仓与设置仅保存在浏览器本地存储（chrome.storage.local），导入 / 导出均为本地文件操作。'),
          h('p', {}, '行情数据请求直接发往腾讯 / 新浪 / 东方财富公开行情接口，不经过任何中间服务器。'),
        ];
  return h('div', { class: 'modal-overlay', onclick: () => setState({ aboutModal: null }) }, [
    h('div', { class: 'modal-card', onclick: (e: Event) => e.stopPropagation() }, [
      h('div', { class: 'modal-head' }, [
        h('div', {}, [h('div', { class: 'modal-title' }, title)]),
        h('div', { class: 'modal-close', onclick: () => setState({ aboutModal: null }) }, '✕'),
      ]),
      h('div', { class: 'about-body' }, body),
      h('div', { class: 'modal-actions' }, [
        h('div', { class: 'mbtn save', onclick: () => setState({ aboutModal: null }) }, '知道了'),
      ]),
    ]),
  ]);
}

function exportConfig() {
  const data = JSON.stringify({ watchlist: state.watchlist, settings: state.settings, alerts: state.alerts }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stockwatch-config.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (Array.isArray(parsed.watchlist)) state.watchlist = parsed.watchlist;
      if (parsed.settings) state.settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
      if (Array.isArray(parsed.alerts)) state.alerts = parsed.alerts;
      await persist();
      applyTheme();
      render();
      refreshQuotes();
    } catch {
      alert('配置文件无法解析');
    }
  };
  input.click();
}

// ── root render ──────────────────────────────────────────────────────────────
function screenKey(): string {
  return state.screen ?? (state.detailSecid ? 'detail:' + state.detailSecid : 'list');
}
let lastScreenKey = '';

// ── 自选设置 modal（分组多选 + 持仓 股数/成本）────────────────────────────────
function renderHoldEdit() {
  const secid = state.editHold!;
  const w = state.watchlist.find((x) => x.secid === secid);
  const q = quoteFor(secid);
  const name = q?.name ?? w?.name ?? secid;
  const chip = (g: string) => {
    const active = state.groupDraft.includes(g);
    return h('div', { class: `grp-chip ${active ? 'active' : ''}`, onclick: () => toggleGroupDraft(g) }, [
      `${active ? '✓ ' : ''}${g}`,
      h('span', {
        class: 'grp-del',
        title: '删除分组',
        onclick: (e: Event) => {
          e.stopPropagation();
          deleteGroup(g);
        },
      }, '✕'),
    ]);
  };
  return h('div', { class: 'modal-overlay', onclick: () => closeHold() }, [
    h('div', { class: 'modal-card', onclick: (e: Event) => e.stopPropagation() }, [
      h('div', { class: 'modal-head' }, [
        h('div', {}, [h('div', { class: 'modal-title' }, '自选设置'), h('div', { class: 'modal-sub' }, name)]),
        h('div', { class: 'modal-close', onclick: () => closeHold() }, '✕'),
      ]),
      h('div', { class: 'modal-label' }, '分组（可多选 · 所有自选都在「全部自选」中）'),
      state.groups.length ? h('div', { class: 'grp-chips' }, state.groups.map(chip)) : null,
      h('div', { class: 'grp-new' }, [
        h('input', {
          id: 'new-group',
          value: state.newGroupName,
          placeholder: '新建分组名称',
          oncompositionstart: () => { imeComposing = true; },
          oncompositionend: (e: Event) => { imeComposing = false; state.newGroupName = (e.target as HTMLInputElement).value; },
          oninput: (e: Event) => { state.newGroupName = (e.target as HTMLInputElement).value; },
          onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') addGroup(); },
        }),
        h('div', { class: 'grp-add-btn', onclick: () => addGroup() }, '新建'),
      ]),
      h('div', { class: 'modal-label mt' }, '持有份额（股）'),
      h('input', {
        id: 'hold-shares', class: 'modal-input', type: 'number', min: '0', placeholder: '如 100',
        value: state.holdDraft.shares,
        oninput: (e: Event) => { state.holdDraft.shares = (e.target as HTMLInputElement).value; },
      }),
      h('div', { class: 'modal-label' }, '成本价'),
      h('input', {
        id: 'hold-cost', class: 'modal-input', type: 'number', min: '0', step: '0.01', placeholder: '如 1720.00',
        value: state.holdDraft.cost,
        oninput: (e: Event) => { state.holdDraft.cost = (e.target as HTMLInputElement).value; },
      }),
      h('div', { class: 'modal-hint-row' }, [
        h('span', { class: 'modal-hint' }, '填写后自动计算持仓市值与盈亏'),
        h('span', { class: 'clear-hold', onclick: () => clearHoldDraft() }, '清除持仓'),
      ]),
      h('div', { class: 'modal-actions' }, [
        h('div', { class: 'mbtn cancel', onclick: () => closeHold() }, '取消'),
        h('div', { class: 'mbtn save', onclick: () => saveHold() }, '保存'),
      ]),
    ]),
  ]);
}

const KNOWN_INPUTS = ['add-search', 'refresh-custom', 'new-group', 'hold-shares', 'hold-cost'];

function render() {
  // Never tear down the DOM mid-IME-composition — it would abort Chinese input.
  // Guard on focus too so a stuck flag can never freeze the whole UI.
  if (imeComposing && KNOWN_INPUTS.includes((document.activeElement as HTMLElement | null)?.id ?? '')) return;
  const app = document.getElementById('app')!;
  // Preserve focus/caret in text inputs across full re-renders.
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active && KNOWN_INPUTS.includes(active.id) ? active.id : null;
  let caret: number | null = null;
  try { caret = focusId ? active!.selectionStart : null; } catch { caret = null; }
  // Preserve scroll position so the 3s refresh doesn't jump the list to the top.
  const sameScreen = screenKey() === lastScreenKey;
  const prevScroll = sameScreen ? (app.querySelector('.scroll, .scroll-y') as HTMLElement | null)?.scrollTop ?? 0 : 0;

  const body: Node[] = [renderIndexStrip()];
  if (state.screen === 'add') body.push(renderAdd());
  else if (state.screen === 'settings') body.push(renderSettings());
  else if (state.detailSecid) body.push(renderDetail());
  else body.push(renderList());
  if (state.editHold) body.push(renderHoldEdit()); // 自选设置 modal overlays any screen
  if (state.aboutModal) body.push(renderAboutModal());
  app.replaceChildren(...body);
  lastScreenKey = screenKey();

  if (sameScreen && prevScroll) {
    const el = app.querySelector('.scroll, .scroll-y') as HTMLElement | null;
    if (el) el.scrollTop = prevScroll;
  }
  if (focusId) {
    const inp = document.getElementById(focusId) as HTMLInputElement | null;
    if (inp) {
      inp.focus();
      if (caret !== null) { try { inp.setSelectionRange(caret, caret); } catch { /* number inputs reject */ } }
    }
  }
  // 弹窗窗口尺寸可能在无 resize 事件的情况下被 Chrome 调整（headless/缩放场景），
  // 每次渲染顺手校准一次（幂等且极廉价）。
  fitPopupSize();
}

function applyTheme() {
  const t = state.settings.theme;
  // `?forcetheme=dark|light` 仅供预览/测试，不写入设置。
  const force = new URLSearchParams(location.search).get('forcetheme');
  const dark = force ? force === 'dark' : t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.font = state.settings.fontSize; // 字号：std / lg
}

// ── 弹窗尺寸钉定 ─────────────────────────────────────────────────────────────
// Chrome 弹窗上限 800×600 逻辑像素；浏览器缩放>100% 时视口小于 CSS 基准 500×600，
// 内容会被硬裁掉（底栏消失 + 出现第二个滚动条）。窗口就位后把 body 钉到实际视口
// （确定像素值，不会像 max-height:100vh 那样与初始极小视口互锁塌缩），
// 底栏固定可见，仅列表一个滚动条。
function fitPopupSize() {
  if (document.documentElement.dataset.ctx === 'side') return; // 侧边栏走 100vh CSS
  const vw = innerWidth;
  const vh = innerHeight;
  document.body.style.height = vh >= 200 && vh < 600 ? `${vh}px` : '';
  document.body.style.width = vw >= 320 && vw < 500 ? `${vw}px` : '';
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function init() {
  // 侧边栏上下文（popup.html?ctx=side）铺满面板；popup 上下文基准 500×600。
  if (new URLSearchParams(location.search).get('ctx') === 'side') {
    document.documentElement.dataset.ctx = 'side';
  }
  addEventListener('resize', fitPopupSize);
  requestAnimationFrame(fitPopupSize);
  setTimeout(fitPopupSize, 150);
  setTimeout(fitPopupSize, 600);
  const store = await loadStore();
  state.watchlist = store.watchlist;
  state.settings = store.settings;
  state.alerts = store.alerts;
  state.groups = store.groups;
  applyTheme();
  render();
  await checkPerms();
  await refreshQuotes();
  // `?norefresh=1` freezes the auto-refresh loop (used by the dev preview so the
  // DOM stays stable for inspection); the packaged extension always polls.
  if (new URLSearchParams(location.search).get('norefresh') !== '1') restartLoop();
  onStoreChanged((s) => {
    state.watchlist = s.watchlist;
    state.settings = s.settings;
    state.alerts = s.alerts;
    state.groups = s.groups;
    applyTheme();
    render();
  });
}

init();
