import type { Trends, Kline } from '../data/types';

// A cursor-snap point shared by both chart kinds; carries enough raw data for
// the popup to format a floating tooltip.
export interface ChartPoint {
  x: number;
  y: number;
  t: string; // "HH:MM" (分时) or "YYYY-MM-DD" (K线)
  price: number; // close / current
  prevClose: number;
  avg?: number;
  open?: number;
  high?: number;
  low?: number;
}

export interface AxisTick {
  pos: number; // px along the relevant axis
  price?: number;
  pct?: number;
  label?: string;
}

export interface Geom {
  w: number;
  h: number;
  padL: number;
  padR: number;
  padT: number;
  padB: number;
}

// 弹窗宽 500：价格卡外边距 14×2 + 内边距 16×2 → 图表画布 436。
const GEOM: Geom = { w: 436, h: 156, padL: 8, padR: 48, padT: 8, padB: 18 };

// ── 分时 (intraday, centred on 昨收 like every CN broker app) ────────────────
export interface TimeShareChart extends Geom {
  kind: 'time';
  line: string;
  area: string;
  avg: string;
  prevY: number;
  lastX: number;
  lastY: number;
  points: ChartPoint[];
  yTicks: AxisTick[];
}

// ── 分时 X 轴的交易时段映射（按市场区分，午休等停盘段压缩掉）────────────────
// CN: 09:30–11:30 / 13:00–15:00（240 分钟）
// HK: 09:30–12:00 / 13:00–16:00（330 分钟）
// US: 美东 09:30–16:00（390 分钟；数据层已把时间归一为美东，见 router）
export type SessionKind = 'CN' | 'HK' | 'US';
const SESSIONS: Record<SessionKind, Array<[number, number]>> = {
  CN: [
    [570, 690],
    [780, 900],
  ],
  HK: [
    [570, 720],
    [780, 960],
  ],
  US: [[570, 960]],
};
const sessionTotal = (k: SessionKind) => SESSIONS[k].reduce((a, [s, e]) => a + (e - s), 0);

/** Minutes elapsed within the market session（跨窗口累计，窗口外钳到边界）。 */
function sessionMinute(t: string, kind: SessionKind): number {
  const [hh, mm] = t.split(':').map(Number);
  const x = (hh || 0) * 60 + (mm || 0);
  let acc = 0;
  for (const [s, e] of SESSIONS[kind]) {
    if (x <= e) return acc + Math.min(e - s, Math.max(0, x - s));
    acc += e - s;
  }
  return acc;
}

export function timeShareChart(trends: Trends, geom: Geom = GEOM, kind: SessionKind = 'CN'): TimeShareChart | null {
  const pts = trends.points;
  if (!pts.length) return null;
  const { w, h, padL, padR, padT, padB } = geom;
  const prevClose = trends.prevClose || pts[0].price;
  const prices = pts.map((p) => p.price);
  const rawMax = Math.max(prevClose, ...prices);
  const rawMin = Math.min(prevClose, ...prices);
  // Symmetric band around 昨收 so ↑ and ↓ read proportionally.
  const dev = Math.max(rawMax - prevClose, prevClose - rawMin, prevClose * 0.002);
  const min = prevClose - dev;
  const max = prevClose + dev;
  const spanX = w - padL - padR;
  const spanY = h - padT - padB;
  const X = (t: string) => padL + (sessionMinute(t, kind) / sessionTotal(kind)) * spanX;
  const Y = (v: number) => padT + (1 - (v - min) / (max - min)) * spanY;

  const cps: ChartPoint[] = pts.map((p) => ({
    x: X(p.t),
    y: Y(p.price),
    t: p.t,
    price: p.price,
    prevClose,
    avg: p.avg,
  }));
  const line = cps.map((p, i) => (i ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  const lastX = cps[cps.length - 1].x;
  const area = `${line} L ${lastX.toFixed(1)} ${(h - padB).toFixed(1)} L ${padL} ${(h - padB).toFixed(1)} Z`;
  const avg = pts
    .map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.avg ?? p.price).toFixed(1))
    .join(' ');
  const yTicks: AxisTick[] = [max, prevClose + dev / 2, prevClose, prevClose - dev / 2, min].map((v) => ({
    pos: Y(v),
    price: v,
    pct: ((v - prevClose) / prevClose) * 100,
  }));

  return {
    kind: 'time',
    ...geom,
    line,
    area,
    avg,
    prevY: Y(prevClose),
    lastX,
    lastY: cps[cps.length - 1].y,
    points: cps,
    yTicks,
  };
}

// ── K线 candlesticks with price + date axes ──────────────────────────────────
export interface Candle {
  x: number; // left of body
  cx: number; // centre (wick)
  bw: number; // body width
  wickTop: number;
  wickBot: number;
  bodyTop: number;
  bodyH: number;
  up: boolean;
}
export interface CandleChart extends Geom {
  kind: 'kline';
  candles: Candle[];
  points: ChartPoint[];
  yTicks: AxisTick[];
  xTicks: AxisTick[];
}

export function candleChart(klines: Kline[], geom: Geom = { ...GEOM, h: 168 }): CandleChart | null {
  if (!klines.length) return null;
  const { w, h, padL, padR, padT, padB } = geom;
  const max = Math.max(...klines.map((k) => k.high));
  const min = Math.min(...klines.map((k) => k.low));
  const range = max - min || 1;
  const n = klines.length;
  const spanX = w - padL - padR;
  const spanY = h - padT - padB;
  const slot = spanX / n;
  const bw = Math.max(1.2, slot * 0.62);
  const Y = (v: number) => padT + (1 - (v - min) / range) * spanY;

  const candles: Candle[] = [];
  const points: ChartPoint[] = [];
  klines.forEach((k, i) => {
    const cx = padL + (i + 0.5) * slot;
    const up = k.close >= k.open;
    const bodyTop = Y(Math.max(k.open, k.close));
    const bodyBot = Y(Math.min(k.open, k.close));
    candles.push({
      x: cx - bw / 2,
      cx,
      bw,
      wickTop: Y(k.high),
      wickBot: Y(k.low),
      bodyTop,
      bodyH: Math.max(1, bodyBot - bodyTop),
      up,
    });
    points.push({
      x: cx,
      y: Y(k.close),
      t: k.date,
      price: k.close,
      prevClose: i ? klines[i - 1].close : k.open,
      open: k.open,
      high: k.high,
      low: k.low,
    });
  });

  const yTicks: AxisTick[] = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = min + range * f;
    return { pos: Y(v), price: v };
  });
  const idxs = n <= 1 ? [0] : [0, Math.floor(n / 2), n - 1];
  const xTicks: AxisTick[] = idxs.map((i) => ({
    pos: padL + (i + 0.5) * slot,
    label: (klines[i].date || '').slice(5), // MM-DD
  }));

  return { kind: 'kline', ...geom, candles, points, yTicks, xTicks };
}

/** Nearest data point to a cursor x (for the hover crosshair). */
export function nearestPoint(points: ChartPoint[], x: number): ChartPoint | null {
  if (!points.length) return null;
  let best = points[0];
  let bd = Infinity;
  for (const p of points) {
    const d = Math.abs(p.x - x);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}
