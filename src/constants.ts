import type { AppData, Kind, Settings } from "./types.js";

export const STORAGE_KEY = "yuki-kazoe-cho-data";
export const ACTIVE_VIEW_KEY = "yuki-kazoe-cho-active-view";
// v2→v3移行の直後に一度だけ「バックアップ推奨」の導線を出すためのフラグ
export const BACKUP_NOTICE_KEY = "yuki-kazoe-cho-v3-backup-notice";
// 前回タブのカテゴリ・グループ折りたたみの開閉状態（v3.4）。UI状態でありデータではないため、
// JSONエクスポート／インポートの対象には含めない
export const FOLD_STATE_KEY = "yuki-kazoe-cho-fold-state";

export const KINDS: Kind[] = ["楽しみ", "習慣", "振り返り", "作業"];
export const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
export const DAY_BOUNDARY_OPTIONS = ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"];
export const DEFAULT_CATEGORIES = ["楽しみ", "おでかけ", "作業", "生活", "お金", "仕事", "その他"];
// v2までの既定カテゴリをv3の既定へ寄せる移行マップ。表に無いカテゴリ（ユーザー追加分）は据え置く
export const CATEGORY_MIGRATION_MAP: Record<string, string> = {
  趣味: "楽しみ",
  SNS: "作業",
  発信: "作業",
  開発: "作業",
  "人・連絡": "おでかけ",
  振り返り: "その他",
};
export const NEW_CATEGORY_VALUE = "__new__";
export const NEW_GROUP_VALUE = "__new__";
export const NO_GROUP_VALUE = "__none__";
// 在庫の遡り上限（日）。壊れたデータでの無限ループ防止の安全弁で、通常運用では届かない
export const MAX_INVENTORY_LOOKBACK_DAYS = 1600;
export const LONG_PRESS_MS = 550;

export const DEFAULT_SETTINGS: Settings = {
  dayBoundaryTime: "05:00",
  weekStartDay: 1,
  categories: DEFAULT_CATEGORIES,
  groups: [],
};

export const DEFAULT_DATA: AppData = {
  version: 2,
  items: [],
  completions: [],
  stockEntries: [],
  settings: DEFAULT_SETTINGS,
};
