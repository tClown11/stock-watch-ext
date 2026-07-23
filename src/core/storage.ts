import type { WatchItem } from '../data/types';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import { DEFAULT_WATCHLIST, DEFAULT_GROUPS } from '../data/mock';

// Price alert (到价提醒): fire a notification when price crosses `value`.
export interface Alert {
  secid: string;
  name: string;
  dir: 'above' | 'below';
  value: number;
  once: boolean;
  fired?: boolean;
}

export interface Store {
  watchlist: WatchItem[];
  settings: Settings;
  alerts: Alert[];
  groups: string[]; // 用户自定义分组名（顺序即标签顺序）
}

const KEY = 'stockwatch';
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local;

// Preview / test fallback when the extension storage API is absent.
const memFallback: Record<string, unknown> = {};
function localGet(key: string): unknown {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    }
  } catch { /* ignore */ }
  return memFallback[key];
}
function localSet(key: string, val: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(val));
  } catch { /* ignore */ }
  memFallback[key] = val;
}

function withDefaults(partial: Partial<Store> | undefined): Store {
  const legacy = (partial?.settings ?? {}) as Partial<Settings> & { uiScale?: string };
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...legacy,
    toggles: { ...DEFAULT_SETTINGS.toggles, ...(legacy.toggles ?? {}) },
  };
  // 旧版「界面缩放」迁移为设计稿的「字号」。
  if (!legacy.fontSize && legacy.uiScale) settings.fontSize = legacy.uiScale === 'loose' ? 'lg' : 'std';
  return {
    watchlist: partial?.watchlist ?? DEFAULT_WATCHLIST,
    settings,
    alerts: partial?.alerts ?? [],
    groups: partial?.groups ?? DEFAULT_GROUPS,
  };
}

// chrome.storage.sync 单条上限 8192 字节；超限（自选极多）时静默跳过镜像，
// 此时以本地存储 + 手动导出为准。
const SYNC_LIMIT = 7500;

async function syncBackup(): Promise<Partial<Store> | undefined> {
  if (!chrome.storage?.sync) return undefined;
  try {
    const got = await chrome.storage.sync.get(KEY);
    return got?.[KEY] as Partial<Store> | undefined;
  } catch {
    return undefined;
  }
}

export async function loadStore(): Promise<Store> {
  if (hasChrome) {
    const got = await chrome.storage.local.get(KEY);
    if (got?.[KEY]) return withDefaults(got[KEY] as Partial<Store>);
    // 本地为空（首装或扩展被移除后重装）→ 尝试从 sync 备份自动恢复。
    // Chrome 登录并开启同步时备份存在账号云端，卸载重装、换电脑都能找回。
    const backup = await syncBackup();
    if (backup) {
      const restored = withDefaults(backup);
      await chrome.storage.local.set({ [KEY]: restored });
      return restored;
    }
    return withDefaults(undefined);
  }
  return withDefaults(localGet(KEY) as Partial<Store> | undefined);
}

export async function saveStore(store: Store): Promise<void> {
  if (hasChrome) {
    await chrome.storage.local.set({ [KEY]: store });
    // 每次保存顺手镜像到 sync（异步、容错）：作为卸载/换机的自动备份。
    try {
      if (chrome.storage.sync && JSON.stringify(store).length < SYNC_LIMIT) {
        void chrome.storage.sync.set({ [KEY]: store }).catch(() => {});
      }
    } catch {
      /* sync 不可用或限流：本地存储不受影响 */
    }
  } else {
    localSet(KEY, store);
  }
}

/** Subscribe to cross-context store changes (popup ↔ service worker). */
export function onStoreChanged(cb: (store: Store) => void): void {
  if (!hasChrome || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]?.newValue) cb(withDefaults(changes[KEY].newValue));
  });
}
