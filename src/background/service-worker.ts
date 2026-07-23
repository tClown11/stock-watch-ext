import { eastmoney } from '../data/eastmoney';
import * as router from '../data/router';
import { loadStore, saveStore, type Store } from '../core/storage';
import { colorsOf, refreshMs } from '../core/settings';
import { displaySort, marketSessionOpen } from '../core/compute';
import type { Quote } from '../data/types';

const ALARM = 'stockwatch-tick';

// 旧版本曾设置 openPanelOnActionClick=true 且该标记会随配置持久化：若不复位，
// 点击工具栏图标会去开侧边栏而不是弹窗（表现为「点了没反应」）。manifest 必须
// 保留 side_panel 声明，此调用才有效——复位后 default_popup 优先生效。
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: false })
  .catch((e) => console.warn('[sw] reset panel behavior failed:', e));

// 多源报价（腾讯 → 新浪 → 东财，缺口自动补齐）。
function fetchQuotes(secids: string[]): Promise<Quote[]> {
  return router.getQuotes(secids);
}

// Badge cadence follows the user's refresh setting (chrome.alarms floor is ~0.5 min).
async function scheduleAlarm() {
  const store = await loadStore();
  const minutes = Math.max(0.5, refreshMs(store.settings) / 60_000);
  chrome.alarms.create(ALARM, { periodInMinutes: minutes });
}

// MV3 service workers are ephemeral and chrome.alarms is capped at a 30s
// minimum, so the badge / alert cadence here is coarser than the popup's
// in-view 3/5/10s refresh. The popup drives live UI; the worker keeps the
// toolbar badge and price alerts alive while the popup is closed.
chrome.runtime.onInstalled.addListener(async () => {
  const store = await loadStore();
  await saveStore(store); // materialise defaults on first install
  await drawIcon();
  await scheduleAlarm();
  tick();
});

chrome.runtime.onStartup.addListener(async () => {
  await drawIcon();
  await scheduleAlarm();
  tick();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

// React quickly when the user flips badge mode / colours / interval in settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.stockwatch) {
    scheduleAlarm();
    tick();
  }
});

// ── data proxy ───────────────────────────────────────────────────────────────
// MV3 extension *pages* (the popup) are subject to CORS, but the service worker
// is not — it fetches cross-origin via host_permissions. Eastmoney's search API
// sends no CORS header, so the popup can't call it directly; it routes search
// through here instead. Quotes/trends/kline use CORS-open hosts and stay direct.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 弹窗每次拉到新行情就推过来一份：角标/提醒立即跟着最新数据走，
  // 不再干等下一次 alarm（最短也要 30s，通常是几分钟）才更新。
  if (msg?.type === 'quotes-refreshed' && Array.isArray(msg.quotes)) {
    (async () => {
      try {
        const store = await loadStore();
        await applyQuotes(store, msg.quotes as Quote[]);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }
  if (!msg || msg.type !== 'data') return undefined;
  (async () => {
    try {
      const { method, args } = msg as { method: string; args: unknown[] };
      let result: unknown;
      if (method === 'search') result = await eastmoney.search(args[0] as string);
      else if (method === 'getQuotes') result = await fetchQuotes(args[0] as string[]);
      else if (method === 'getTrends') result = await router.getTrends(args[0] as string);
      else if (method === 'getKline') result = await router.getKline(args[0] as string, args[1] as 101 | 102 | 103);
      else throw new Error(`unknown data method: ${method}`);
      sendResponse({ ok: true, result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async sendResponse
});

async function tick() {
  try {
    const store = await loadStore();
    const secids = store.watchlist.map((w) => w.secid);
    if (!secids.length) {
      await applyQuotes(store, []);
      return;
    }
    const quotes = await fetchQuotes(secids);
    await applyQuotes(store, quotes);
  } catch (e) {
    console.error('[sw] tick failed', e);
  }
}

/** 用一批最新报价重算角标与到价提醒（报价可多于自选，如弹窗附带的指数，忽略即可）。 */
async function applyQuotes(store: Store, quotes: Quote[]) {
  if (!store.watchlist.length) {
    await chrome.action.setBadgeText({ text: '' });
    await drawIcon();
    await chrome.action.setTitle({ title: '盯盘助手' });
    return;
  }
  const bySecid = new Map(quotes.map((q) => [q.secid, q]));
  const { up, down } = colorsOf(store.settings);

  // ── 工具栏图标（v6 设计：浅色 logo 瓦片 + 彩色角标胶囊）─────────────────────
  // 图标始终是白色圆角瓦片上的红绿蜡烛 logo；数字放角标胶囊里，
  // 底色 = 涨跌色，白色粗体文字（Chrome 角标最多 ~4 字符）。
  const mode = store.settings.badgeMode;
  await drawIcon();
  if (mode === 'off') {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: '盯盘助手' });
  } else if (mode === 'all') {
    let sum = 0;
    for (const w of store.watchlist) {
      const q = bySecid.get(w.secid);
      if (q && w.hold) sum += (q.price - w.hold.cost) * w.hold.shares;
    }
    await setBadge(compactAmount(sum), sum >= 0 ? up : down);
    await chrome.action.setTitle({ title: `持仓总盈亏 ${sum >= 0 ? '+' : '-'}${compactAmount(Math.abs(sum))}` });
  } else {
    // 目标：显式指定的 badgeSecid；否则取「列表显示顺序」的第一只有报价的
    //（与弹窗同一套排序：收藏/置顶优先——用户置顶了谁，角标就盯谁）。
    const target =
      (store.settings.badgeSecid && bySecid.get(store.settings.badgeSecid)) ||
      displaySort(store.watchlist, marketSessionOpen)
        .map((w) => bySecid.get(w.secid))
        .find((q): q is Quote => !!q);
    if (target) {
      const p = target.changePct;
      await setBadge(compactPct(p), p >= 0 ? up : down);
      await chrome.action.setTitle({ title: `${target.name} ${p >= 0 ? '+' : ''}${p.toFixed(2)}%` });
    }
  }

  // ── price alerts (到价提醒) ───────────────────────────────────────────────
  if (store.alerts.length) {
    let changed = false;
    for (const alert of store.alerts) {
      if (alert.fired) continue;
      const q = bySecid.get(alert.secid);
      if (!q) continue;
      const hit = alert.dir === 'above' ? q.price >= alert.value : q.price <= alert.value;
      if (hit) {
        chrome.notifications.create(`${alert.secid}-${alert.value}-${Date.now()}`, {
          type: 'basic',
          iconUrl: iconDataUrl(),
          title: `${alert.name} 到价提醒`,
          message: `现价 ${q.price}，已${alert.dir === 'above' ? '涨到' : '跌到'} ${alert.value}`,
          priority: 2,
        });
        if (alert.once) {
          alert.fired = true;
          changed = true;
        }
      }
    }
    if (changed) {
      // 不能整体回写 store：本次 tick 的快照可能已过时（期间弹窗/其它上下文
      // 改过自选），整体覆盖会吞掉并发写入。重读最新 store，只合并 fired 标记。
      const fresh = await loadStore();
      const fired = new Set(store.alerts.filter((a) => a.fired).map((a) => `${a.secid}|${a.dir}|${a.value}`));
      fresh.alerts = fresh.alerts.map((a) => (fired.has(`${a.secid}|${a.dir}|${a.value}`) ? { ...a, fired: true } : a));
      await saveStore(fresh);
    }
  }
}

/** 角标胶囊：文字 + 涨跌色底 + 白字。 */
async function setBadge(text: string, color: string) {
  await chrome.action.setBadgeBackgroundColor({ color });
  try {
    await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  } catch { /* 旧版本无此 API */ }
  await chrome.action.setBadgeText({ text });
}

/** 涨跌幅 → 角标文本（≤4 字符，放不下就去掉符号，方向仍由颜色表达）。 */
function compactPct(p: number): string {
  const core = Math.abs(p) >= 10 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1);
  const signed = (p >= 0 ? '+' : '-') + core;
  return signed.length <= 4 ? signed : core;
}

/** 金额 → 角标文本（988 / +3千? 不引入生僻单位：万、亿）。 */
function compactAmount(v: number): string {
  const abs = Math.abs(v);
  let core: string;
  if (abs >= 1e8) core = (abs / 1e8 >= 10 ? Math.round(abs / 1e8).toString() : (abs / 1e8).toFixed(1)) + '亿';
  else if (abs >= 1e4) core = (abs / 1e4 >= 10 ? Math.round(abs / 1e4).toString() : (abs / 1e4).toFixed(1)) + '万';
  else core = String(Math.round(abs));
  const signed = (v >= 0 ? '+' : '-') + core;
  return signed.length <= 4 ? signed : core;
}

// ── runtime-drawn toolbar icon（v6 设计：浅色圆角瓦片 + 红绿蜡烛，无 PNG 资源）──
function paint(size: number): ImageData {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext('2d')!;
  // 浅色瓦片底（对应设计 logo：linear-gradient(160deg,#fff,#eef2fa)），深浅色工具栏都清晰
  const g = ctx.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#e9eef8');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120,130,150,0.35)';
  ctx.lineWidth = Math.max(1, size / 32);
  ctx.beginPath();
  ctx.roundRect(ctx.lineWidth / 2, ctx.lineWidth / 2, size - ctx.lineWidth, size - ctx.lineWidth, size * 0.28);
  ctx.stroke();
  // 蜡烛（三根，取设计 mockup 的 17×17 视图，留 15% 内边距）
  const pad = size * 0.15;
  const s = (size - pad * 2) / 17;
  const bar = (x: number, y: number, w: number, hgt: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(pad + x * s, pad + y * s, w * s, hgt * s, 1.2 * s);
    ctx.fill();
  };
  bar(1.4, 3.4, 0.9, 11.4, '#ff5b52');
  bar(2, 6, 2.4, 7, '#ff5b52');
  bar(6.7, 2.2, 0.9, 12.6, '#ff5b52');
  bar(7.3, 4, 2.4, 9, '#ff5b52');
  bar(12, 4.2, 0.9, 10.6, '#2fc46a');
  bar(12.6, 7, 2.4, 6, '#2fc46a');
  return ctx.getImageData(0, 0, size, size);
}

async function drawIcon() {
  try {
    await chrome.action.setIcon({ imageData: { 16: paint(16), 32: paint(32) } });
  } catch (e) {
    console.warn('[sw] setIcon failed', e);
  }
}

// A small static data URL for notification icons.
function iconDataUrl(): string {
  const c = new OffscreenCanvas(48, 48);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 48, 48);
  const s = 48 / 17;
  const bar = (x: number, y: number, w: number, hgt: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(x * s, y * s, w * s, hgt * s);
  };
  bar(2, 6, 2.4, 7, '#ff5b52');
  bar(12.6, 7, 2.4, 6, '#2fc46a');
  // OffscreenCanvas has no toDataURL; notifications accept a relative/URL only,
  // so fall back to a bundled-less 1px transparent when conversion is unavailable.
  return 'data:image/svg+xml;base64,' +
    btoa(
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#fff"/><rect x="6" y="17" width="7" height="20" rx="3" fill="#ff5b52"/><rect x="35" y="20" width="7" height="17" rx="3" fill="#2fc46a"/></svg>`
    );
}
