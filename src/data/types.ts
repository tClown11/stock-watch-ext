// ── Shared domain types ────────────────────────────────────────────────────

/** Market bucket used for the coloured 沪/深/港/美 tag and grouping. */
export type Market = 'SH' | 'SZ' | 'HK' | 'US';

/** A user holding, used for 持仓盈亏. */
export interface Holding {
  shares: number; // 股数
  cost: number; // 成本价
}

/**
 * One persisted watch-list entry. `secid` is Eastmoney's canonical
 * `市场.代码` id (e.g. `1.600519`, `105.AAPL`); we always store it so we never
 * have to guess the US 105/106/107 exchange prefix.
 */
export interface WatchItem {
  secid: string;
  code: string;
  market: Market;
  name: string;
  hold?: Holding;
  star?: boolean; // 特别关注 / 收藏
  pinned?: boolean; // 置顶
  pinnedBottom?: boolean; // 置底（与 pinned 互斥）
  groups?: string[]; // 所属自定义分组（多对多）
  etf?: boolean;
}

/** A live snapshot for one instrument, normalised from the data source. */
export interface Quote {
  secid: string;
  code: string;
  market: Market;
  name: string;
  price: number;
  prevClose: number;
  changeAmt: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number; // 手
  amount?: number; // 元
  amplitude?: number; // %
  turnover?: number; // %
  pe?: number;
  pb?: number;
  mcap?: number; // 元
  high52?: number;
  low52?: number;
  /** 场外基金：无实时行情，price = 最新单位净值（或盘中估值） */
  otc?: boolean;
  /** 场外基金净值/估值对应日期（YYYY-MM-DD） */
  navDate?: string;
  /** 场外基金累计净值 */
  accNav?: number;
}

export interface TrendPoint {
  t: string; // "HH:MM"
  price: number;
  avg?: number;
  vol: number;
}

export interface Trends {
  secid: string;
  prevClose: number;
  points: TrendPoint[];
}

export interface Kline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number;
  amount: number;
}

export interface SearchHit {
  secid: string;
  code: string;
  market: Market;
  name: string;
  pinyin?: string;
  etf?: boolean;
}

/** The data-source contract — swap Eastmoney for another provider here. */
export interface DataSource {
  getQuotes(secids: string[]): Promise<Quote[]>;
  getTrends(secid: string): Promise<Trends>;
  getKline(secid: string, klt: 101 | 102 | 103): Promise<Kline[]>;
  search(input: string): Promise<SearchHit[]>;
}
