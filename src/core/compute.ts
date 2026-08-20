import type { Quote, Holding, Trends, WatchItem, Market } from '../data/types';
import { fmt, sgn, decimalsFor, decimalsForCrypto, volWan, yi, pct } from './format';

/** 列表 / 详情共用的价格小数位（场外基金看净值、币圈按币价数量级）。 */
export function priceDecimals(q: Quote | undefined, fallback = 2): number {
  if (!q) return fallback;
  if (q.otc) return 4;
  if (q.market === 'CRYPTO') return decimalsForCrypto(q.price);
  return decimalsFor(q.price);
}

// ── 市场交易时段与列表显示顺序（弹窗列表与工具栏角标共用，保证两边一致）────────
export type SessionMarket = 'A' | 'HK' | 'US' | 'CRYPTO';

/** A股/港/美 当前是否盘中（北京时间；美股取 CN 时间窗 ≈ 21:30–04:00）。币圈 7×24 恒开。 */
export function marketSessionOpen(m: SessionMarket, now = new Date()): boolean {
  const day = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (m === 'CRYPTO') return true; // 加密货币无休市，永远盘中
  if (m === 'US') {
    const inWindow = mins >= 21 * 60 + 30 || mins <= 4 * 60;
    const sessionDay = mins <= 4 * 60 ? (day + 6) % 7 : day; // 凌晨段归前一交易日
    return inWindow && sessionDay >= 1 && sessionDay <= 5;
  }
  if (day === 0 || day === 6) return false;
  if (m === 'HK') return (mins >= 570 && mins <= 720) || (mins >= 780 && mins <= 960); // 9:30-12:00, 13:00-16:00
  return (mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900); // A: 9:30-11:30, 13:00-15:00
}

export const sessionOf = (m: Market): SessionMarket => (m === 'SH' || m === 'SZ' ? 'A' : m);

/**
 * 显示顺序：收藏 → (置顶 → 普通 → 置底) → 开盘中的市场靠前 → 原序。
 * 角标的「第一只」也按此顺序取，与用户在列表里看到的第一行一致。
 */
export function displaySort(watchlist: WatchItem[], isOpen: (m: SessionMarket) => boolean): WatchItem[] {
  const posRank = (w: WatchItem) => (w.pinned ? 0 : w.pinnedBottom ? 2 : 1);
  const openRank = (w: WatchItem) => (isOpen(sessionOf(w.market)) ? 0 : 1);
  return watchlist
    .map((w, i) => ({ w, i }))
    .sort(
      (a, b) =>
        Number(!!b.w.star) - Number(!!a.w.star) ||
        posRank(a.w) - posRank(b.w) ||
        openRank(a.w) - openRank(b.w) ||
        a.i - b.i
    )
    .map((x) => x.w);
}

export function hexToRgba(hex: string, a: number): string {
  const m = hex.replace('#', '');
  const n = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export interface Pnl {
  amt: number;
  pct: number;
  marketValue: number;
  color: string;
  amtText: string;
  pctText: string;
  mvText: string;
  /** 当日盈亏 = 当日涨跌额 × 持股数 */
  dayAmt: number;
  dayText: string;
  dayColor: string;
}

export function pnlOf(q: Quote, hold: Holding | undefined, up: string, down: string): Pnl | null {
  if (!hold) return null;
  const amt = (q.price - hold.cost) * hold.shares;
  const marketValue = q.price * hold.shares;
  const p = ((q.price - hold.cost) / hold.cost) * 100;
  const color = amt >= 0 ? up : down;
  const dayAmt = q.changeAmt * hold.shares;
  return {
    amt,
    pct: p,
    marketValue,
    color,
    amtText: sgn(amt, 0),
    pctText: sgn(p, 2) + '%',
    mvText: fmt(marketValue, 0),
    dayAmt,
    dayText: sgn(dayAmt, 0),
    dayColor: dayAmt >= 0 ? up : down,
  };
}

// ── detail 分时 chart ───────────────────────────────────────────────────────
export interface TrendChart {
  line: string;
  area: string;
  avg: string;
  prevY: number;
  lastX: number;
  lastY: number;
}

export function buildTrendChart(trends: Trends, w = 392, h = 150): TrendChart | null {
  const pts = trends.points;
  if (!pts.length) return null;
  const PADL = 12, PADR = 12, PADT = 10, PADB = 12;
  const prices = pts.map((p) => p.price);
  const mn = Math.min(trends.prevClose, ...prices) * 0.999;
  const mx = Math.max(trends.prevClose, ...prices) * 1.001;
  const rg = mx - mn || 1;
  const X = (i: number) => PADL + (i / (pts.length - 1)) * (w - PADL - PADR);
  const Y = (v: number) => PADT + (1 - (v - mn) / rg) * (h - PADT - PADB);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.price).toFixed(1)).join(' ');
  const area = `${line} L ${X(pts.length - 1).toFixed(1)} ${(h - PADB).toFixed(1)} L ${PADL} ${(h - PADB).toFixed(1)} Z`;
  const avg = pts
    .map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.avg ?? p.price).toFixed(1))
    .join(' ');
  return {
    line,
    area,
    avg,
    prevY: Y(trends.prevClose),
    lastX: X(pts.length - 1),
    lastY: Y(pts[pts.length - 1].price),
  };
}

// ── detail metrics grid ─────────────────────────────────────────────────────
export interface Metric {
  label: string;
  value: string;
  color?: string;
}

export function metricsFor(q: Quote, up: string, down: string): Metric[] {
  const d = priceDecimals(q);
  const neutral = 'var(--fg)';
  const isCN = q.market === 'SH' || q.market === 'SZ';
  if (q.market === 'CRYPTO') {
    // 币圈没有开收盘，全行业按「滚动 24 小时」看盘：昨收 → 24h 前价，
    // 今开/最高/最低 → 24h 开/高/低；市盈率、换手、市值等股票指标不适用。
    const open = q.open ?? q.prevClose;
    return [
      { label: '24h开', value: fmt(open, d), color: open >= q.prevClose ? up : down },
      { label: '24h最高', value: fmt(q.high ?? NaN, d), color: up },
      { label: '24h最低', value: fmt(q.low ?? NaN, d), color: down },
      { label: '24h前价', value: fmt(q.prevClose, d), color: neutral },
      { label: '24h均价', value: q.vwap != null ? fmt(q.vwap, d) : '—', color: neutral },
      { label: '振幅', value: pct(q.amplitude), color: neutral },
      { label: `24h成交量`, value: q.volume != null ? `${fmt(q.volume, 0)} ${q.code}` : '—', color: neutral },
      { label: '24h成交额', value: q.amount != null ? yi(q.amount) : '—', color: neutral },
      { label: '计价单位', value: 'USDT', color: neutral },
    ];
  }
  if (q.otc) {
    // 场外基金：无盘口指标，展示净值信息
    const c = q.changePct >= 0 ? up : down;
    return [
      { label: '单位净值', value: fmt(q.price, 4), color: c },
      { label: '日涨跌', value: sgn(q.changePct, 2) + '%', color: c },
      { label: '累计净值', value: q.accNav != null ? fmt(q.accNav, 4) : '—', color: neutral },
      { label: '净值日期', value: q.navDate || '—', color: neutral },
    ];
  }
  return [
    { label: '今开', value: fmt(q.open ?? NaN, d), color: (q.open ?? q.prevClose) >= q.prevClose ? up : down },
    { label: '最高', value: fmt(q.high ?? NaN, d), color: up },
    { label: '最低', value: fmt(q.low ?? NaN, d), color: down },
    { label: '昨收', value: fmt(q.prevClose, d), color: neutral },
    // 成交量口径：A股为「手」，港美股为「股」。
    { label: '成交量', value: isCN ? volWan(q.volume) : q.volume != null ? fmt(q.volume / 1e4, 1) + ' 万股' : '—', color: neutral },
    { label: '成交额', value: yi(q.amount), color: neutral },
    { label: '换手率', value: pct(q.turnover), color: neutral },
    { label: '振幅', value: pct(q.amplitude), color: neutral },
    { label: '市盈(动)', value: fmt(q.pe ?? NaN, 2), color: neutral },
    { label: '市净率', value: fmt(q.pb ?? NaN, 2), color: neutral },
    { label: '总市值', value: yi(q.mcap, 0), color: neutral },
    { label: '52周高', value: q.high52 && q.high52 > 0 ? fmt(q.high52, d) : '—', color: neutral },
  ];
}

// ── toolbar badge (角标) ─────────────────────────────────────────────────────
export interface BadgeState {
  show: boolean;
  text: string;
  color: string;
}

export function badgeState(
  quotes: Quote[],
  mode: 'off' | 'single' | 'all',
  badgeSecid: string | undefined,
  up: string,
  down: string
): BadgeState {
  if (mode === 'off' || !quotes.length) return { show: false, text: '', color: up };
  if (mode === 'all') {
    // total holdings P&L handled by caller-supplied quotes carrying .hold via a map;
    // here we only get quotes, so 'all' badge is computed in the worker where holds live.
    return { show: false, text: '', color: up };
  }
  const q = quotes.find((x) => x.secid === badgeSecid) ?? quotes[0];
  const p = q.changePct;
  return { show: true, text: sgn(p, 2) + '%', color: p >= 0 ? up : down };
}
