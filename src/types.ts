// Kind はv2までの分類（4択）。v3で isStock に置き換えたが、既存ログの kindSnapshot 保全のため型だけ残す
export type Kind = "楽しみ" | "習慣" | "振り返り" | "作業";
// single＝単発在庫（手で積む）。自動生成しない
export type RepeatType = "weekly" | "monthly" | "none" | "single";
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Item = {
  id: string;
  title: string;
  category: string;
  group: string | null; // カテゴリと項目の間の中分類。null＝カテゴリ直下
  isStock: boolean; // true＝在庫タブ（repeatType weekly/monthly/single）、false＝前回タブ（repeatType none 固定）
  repeatType: RepeatType;
  weekday: Weekday | null;
  monthDay: number | null;
  isActive: boolean;
  // 停止した日時（isActive を false にして保存した時刻。true に戻すと null）。停止後は新しい対象日・積みを増やさず、
  // 停止時点までの残件だけ在庫に残して完了できる。旧データ（停止中なのにこの値が無い）は読み込み時に updatedAt を入れる
  stoppedAt: string | null;
  // 削除した日時（ソフト削除。null＝削除していない）。削除後は新しい対象日を増やさず、未消化の残件は完了まで在庫に出る。
  // 設定の項目一覧・前回タブ・項目編集の対象には出さない。完了ログは保持
  deletedAt: string | null;
  inventoryStartDate?: string;
  memo: string;
  createdAt: string;
  updatedAt: string;
};

// 単発在庫に手で積んだ1件（未消化）。消化するとここから消え、Completionになる
export type StockEntry = {
  id: string;
  itemId: string;
  label: string; // 積んだ名前（任意。例：国宝）
  addedAt: string;
};

export type Completion = {
  id: string;
  itemId: string;
  targetDate: string;
  completedAt: string;
  titleSnapshot: string;
  categorySnapshot: string;
  groupSnapshot: string | null; // v3追加。グループを削除してもログの帰属先が残る。v2以前のログはnull
  kindSnapshot?: Kind; // v2までの凍結フィールド。既存ログ保全のため残すが、新規ログには書き込まない
  note: string;
  count: number | null;
};

export type Settings = {
  dayBoundaryTime: string;
  weekStartDay: Weekday;
  categories: string[];
  groups: string[]; // v3追加。空グループも「受け皿」として選択肢に残すため設定に持つ
};

export type AppData = {
  version: 2; // v3改修でデータ形式を2に更新（1＝kind時代。読み込みは1も受理して移行する）
  items: Item[];
  completions: Completion[];
  stockEntries: StockEntry[];
  settings: Settings;
};

export type Tab = "home" | "last" | "stats" | "settings";
export type SettingsStockFilter = "all" | "repeat" | "single" | "none";

// 前回タブの折りたたみ開閉状態の永続化形。持つのは「開いているもの」の集合（詳細はFOLD_STATE_KEYの説明を参照）
export type FoldState = {
  openCategories: string[];
  openGroups: string[]; // キーは既存の collapsedGroups と同じ `カテゴリ|グループ` 形式
};

export type ItemDraft = {
  title: string;
  category: string;
  newCategory: string;
  group: string; // NO_GROUP_VALUE＝なし、NEW_GROUP_VALUE＝新規追加
  newGroup: string;
  isStock: boolean;
  repeatType: RepeatType;
  weekday: string;
  monthDay: string;
  inventoryStartDate: string;
  memo: string;
  isActive: boolean;
};

export type ImportCount = {
  label: string;
  loaded: number;
  added: number;
  skipped: number;
};

export type ImportPreview = {
  sourceLabel: string;
  incomingItems: Item[];
  incomingCompletions: Completion[];
  incomingStockEntries: StockEntry[];
  incomingCategories: string[]; // 設定由来の空カテゴリ（受け皿）も取り込む
  incomingGroups: string[]; // 設定由来の空グループ（受け皿）も取り込む
  adoptDayBoundary: string | null;
  counts: ImportCount[];
};

export type EnrichTarget = {
  completionId: string;
  title: string;
  dateLabel: string;
  // 単発在庫の消化なら、取り消し時に積みへ戻すため元エントリを控える（数量入力も出さない）
  consumedStockEntry?: StockEntry;
};

export type DatePickTarget = {
  item: Item;
  slotDate: string | null; // 在庫型は対象日固定。前回日型は null（選んだ日がそのまま対象日）
  stockEntry?: StockEntry; // 単発在庫の消化なら対象エントリ
};

// 深夜（0:00〜5:00）のワンタップ記録を「昨日／今日」どちらとして数えるか確認するための対象（2026-09-20追加）。
// 長押しの日付選択（DatePickTarget）とは別導線。確認後は同じ記録関数へ選んだ日を渡す
export type NightConfirmTarget =
  | { kind: "repeat"; item: Item; date: string } // 繰り返し在庫：対象日（date）は固定のまま、行動した日だけ選ぶ
  | { kind: "single"; item: Item; stockEntry: StockEntry } // 単発在庫の消化
  | { kind: "last"; item: Item }; // 前回日型：選んだ日がそのまま対象日

// 在庫タブのグループカード内の1項目分。繰り返し在庫は対象日リスト、単発在庫は積みリストを持つ
export type InventoryEntry =
  | { type: "repeat"; item: Item; dates: string[] }
  | { type: "single"; item: Item; entries: StockEntry[] };

export type StatRow = {
  title: string;
  count: number;
  quantity: number;
};

// グループ×項目の粒度。グループの合計行は出さない（重みの違う行動を足した数に意味がないため）
export type StatGroup = {
  group: string | null; // null＝カテゴリ直下（groupSnapshotが空の旧ログ含む）
  rows: StatRow[];
};

export type StatCategory = {
  category: string;
  groups: StatGroup[];
  count: number;
  quantity: number;
};
