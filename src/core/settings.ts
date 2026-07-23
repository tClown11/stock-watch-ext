export type Theme = 'light' | 'dark' | 'auto';
export type ColorMode = 'rg' | 'gr'; // 红涨绿跌 / 绿涨红跌
export type FontSize = 'std' | 'lg'; // 字号：标准 / 大号（设计稿 listZoom 1 / 1.1）
export type BadgeMode = 'off' | 'single' | 'all';

export interface Settings {
  theme: Theme;
  colorMode: ColorMode;
  fontSize: FontSize;
  badgeMode: BadgeMode;
  refresh: number; // preset interval in minutes (3 / 5 / 10)
  refreshCustom?: number; // custom interval in minutes; overrides the preset
  toggles: { pnl: boolean; chg: boolean; today: boolean; holiday: boolean };
  riseColor: string;
  fallColor: string;
  /** which watch item drives the single-stock badge (secid); default = first */
  badgeSecid?: string;
}

/** Effective refresh interval in milliseconds (custom minutes override the preset). */
export function refreshMs(s: Settings): number {
  const min = s.refreshCustom && s.refreshCustom > 0 ? s.refreshCustom : s.refresh;
  return Math.max(1, min) * 60_000;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  colorMode: 'rg',
  fontSize: 'std',
  badgeMode: 'single',
  refresh: 3, // minutes
  toggles: { pnl: true, chg: true, today: true, holiday: true },
  riseColor: '#fa4750',
  fallColor: '#0fbd7c',
};

/** Resolve the up/down colours given the swap toggle. */
export function colorsOf(s: Settings): { up: string; down: string } {
  return s.colorMode === 'gr'
    ? { up: s.fallColor, down: s.riseColor }
    : { up: s.riseColor, down: s.fallColor };
}
