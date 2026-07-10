import { Fragment, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// かぞえ帳：「いつから？いくつ？」に一瞬で答える行動台帳
// - Googleカレンダー＝原本（時刻つきの事実）、Keep＝詳細、本アプリ＝索引
// - 入れていいのは「やりたいこと」だけ。締切・義務・時間分数は持たない
// ---------------------------------------------------------------------------

// Kind はv2までの分類（4択）。v3で isStock に置き換えたが、既存ログの kindSnapshot 保全のため型だけ残す
type Kind = "楽しみ" | "習慣" | "振り返り" | "作業";
// single＝単発在庫（手で積む）。自動生成しない
type RepeatType = "weekly" | "monthly" | "none" | "single";
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type Item = {
  id: string;
  title: string;
  category: string;
  group: string | null; // カテゴリと項目の間の中分類。null＝カテゴリ直下
  isStock: boolean; // true＝在庫タブ（repeatType weekly/monthly/single）、false＝前回タブ（repeatType none 固定）
  repeatType: RepeatType;
  weekday: Weekday | null;
  monthDay: number | null;
  isActive: boolean;
  inventoryStartDate?: string;
  memo: string;
  createdAt: string;
  updatedAt: string;
};

// 単発在庫に手で積んだ1件（未消化）。消化するとここから消え、Completionになる
type StockEntry = {
  id: string;
  itemId: string;
  label: string; // 積んだ名前（任意。例：国宝）
  addedAt: string;
};

type Completion = {
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

type Settings = {
  dayBoundaryTime: string;
  weekStartDay: Weekday;
  categories: string[];
  groups: string[]; // v3追加。空グループも「受け皿」として選択肢に残すため設定に持つ
};

type AppData = {
  version: 2; // v3改修でデータ形式を2に更新（1＝kind時代。読み込みは1も受理して移行する）
  items: Item[];
  completions: Completion[];
  stockEntries: StockEntry[];
  settings: Settings;
};

type Tab = "home" | "last" | "stats" | "settings";

type ItemDraft = {
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

type ImportCount = {
  label: string;
  loaded: number;
  added: number;
  skipped: number;
};

type ImportPreview = {
  sourceLabel: string;
  incomingItems: Item[];
  incomingCompletions: Completion[];
  incomingStockEntries: StockEntry[];
  incomingCategories: string[]; // 設定由来の空カテゴリ（受け皿）も取り込む
  incomingGroups: string[]; // 設定由来の空グループ（受け皿）も取り込む
  adoptDayBoundary: string | null;
  counts: ImportCount[];
};

type EnrichTarget = {
  completionId: string;
  title: string;
  dateLabel: string;
  // 単発在庫の消化なら、取り消し時に積みへ戻すため元エントリを控える（数量入力も出さない）
  consumedStockEntry?: StockEntry;
};

type DatePickTarget = {
  item: Item;
  slotDate: string | null; // 在庫型は対象日固定。前回日型は null（選んだ日がそのまま対象日）
  stockEntry?: StockEntry; // 単発在庫の消化なら対象エントリ
};

// 在庫タブのグループカード内の1項目分。繰り返し在庫は対象日リスト、単発在庫は積みリストを持つ
type InventoryEntry =
  | { type: "repeat"; item: Item; dates: string[] }
  | { type: "single"; item: Item; entries: StockEntry[] };

type StatRow = {
  title: string;
  count: number;
  quantity: number;
};

// グループ×項目の粒度。グループの合計行は出さない（重みの違う行動を足した数に意味がないため）
type StatGroup = {
  group: string | null; // null＝カテゴリ直下（groupSnapshotが空の旧ログ含む）
  rows: StatRow[];
};

type StatCategory = {
  category: string;
  groups: StatGroup[];
  count: number;
  quantity: number;
};

const STORAGE_KEY = "yuki-kazoe-cho-data";
const ACTIVE_VIEW_KEY = "yuki-kazoe-cho-active-view";
// v2→v3移行の直後に一度だけ「バックアップ推奨」の導線を出すためのフラグ
const BACKUP_NOTICE_KEY = "yuki-kazoe-cho-v3-backup-notice";

const KINDS: Kind[] = ["楽しみ", "習慣", "振り返り", "作業"];
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_BOUNDARY_OPTIONS = ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"];
const DEFAULT_CATEGORIES = ["楽しみ", "おでかけ", "作業", "生活", "お金", "仕事", "その他"];
// v2までの既定カテゴリをv3の既定へ寄せる移行マップ。表に無いカテゴリ（ユーザー追加分）は据え置く
const CATEGORY_MIGRATION_MAP: Record<string, string> = {
  趣味: "楽しみ",
  SNS: "作業",
  発信: "作業",
  開発: "作業",
  "人・連絡": "おでかけ",
  振り返り: "その他",
};
const NEW_CATEGORY_VALUE = "__new__";
const NEW_GROUP_VALUE = "__new__";
const NO_GROUP_VALUE = "__none__";
// 在庫の遡り上限（日）。壊れたデータでの無限ループ防止の安全弁で、通常運用では届かない
const MAX_INVENTORY_LOOKBACK_DAYS = 1600;
const LONG_PRESS_MS = 550;

const DEFAULT_SETTINGS: Settings = {
  dayBoundaryTime: "05:00",
  weekStartDay: 1,
  categories: DEFAULT_CATEGORIES,
  groups: [],
};

const DEFAULT_DATA: AppData = {
  version: 2,
  items: [],
  completions: [],
  stockEntries: [],
  settings: DEFAULT_SETTINGS,
};

// ----------------------------- 日付ユーティリティ -----------------------------

function dateKeyFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(key: string) {
  return new Date(`${key}T00:00:00`);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addDaysKey(key: string, days: number) {
  return dateKeyFromDate(addDays(dateFromKey(key), days));
}

// 「生活上の日付」：日付境界（既定05:00）より前は前日扱いにする
function lifeDateKey(date: Date, dayBoundaryTime: string) {
  const [hoursText, minutesText] = dayBoundaryTime.split(":");
  const boundaryMinutes = Number(hoursText) * 60 + Number(minutesText);
  const currentMinutes = date.getHours() * 60 + date.getMinutes();
  return dateKeyFromDate(currentMinutes < boundaryMinutes ? addDays(date, -1) : date);
}

function nowLocalStamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${dateKeyFromDate(now)}T${hh}:${mm}:${ss}`;
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

function formatShortDate(key: string) {
  const date = dateFromKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function formatDateWithWeekday(key: string) {
  const date = dateFromKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAY_LABELS[date.getDay()]})`;
}

function diffDays(fromKey: string, toKey: string) {
  return Math.round((dateFromKey(toKey).getTime() - dateFromKey(fromKey).getTime()) / 86400000);
}

function weekStartOf(key: string, weekStartDay: Weekday) {
  const date = dateFromKey(key);
  const diff = (date.getDay() - weekStartDay + 7) % 7;
  return dateKeyFromDate(addDays(date, -diff));
}

function monthKeyOf(key: string) {
  return key.slice(0, 7);
}

function shiftMonthKey(monthKey: string, offset: number) {
  const [yearText, monthText] = monthKey.split("-");
  const base = new Date(Number(yearText), Number(monthText) - 1 + offset, 1);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthKey(monthKey: string) {
  const [yearText, monthText] = monthKey.split("-");
  return `${yearText}年${Number(monthText)}月`;
}

function genId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ----------------------------- データ検証・保存 -----------------------------

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as string[]).includes(value);
}

function isWeekdayValue(value: unknown): value is Weekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

function isRepeatType(value: unknown): value is RepeatType {
  return value === "weekly" || value === "monthly" || value === "none" || value === "single";
}

// v1/v2（kindあり）・v3（isStockあり）のどちらの形状でも受け取り、v3のItemへ正規化する。
// remapCategory はv2以前のデータにだけ適用する（v3でユーザーが同名カテゴリを作り直しても書き換えないため）。
// 不変条件：isStock=false ⇔ repeatType="none"。冪等（v3のItemを通しても変わらない）
function migrateItem(value: unknown, remapCategory: boolean): Item | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.title !== "string" ||
    typeof item.category !== "string" ||
    !isRepeatType(item.repeatType) ||
    typeof item.isActive !== "boolean" ||
    typeof item.memo !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  ) {
    return null;
  }

  let isStock: boolean;
  if (typeof item.isStock === "boolean") {
    isStock = item.isStock;
  } else if (isKind(item.kind)) {
    // v2までの在庫判定「楽しみ × 繰り返しあり」をそのまま写す
    isStock = item.kind === "楽しみ" && item.repeatType !== "none";
  } else {
    return null;
  }
  if (item.repeatType === "none") isStock = false;

  const repeatType: RepeatType = isStock ? item.repeatType : "none";
  const inventoryStartDate =
    isStock && typeof item.inventoryStartDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.inventoryStartDate)
      ? item.inventoryStartDate
      : undefined;
  const category = remapCategory ? (CATEGORY_MIGRATION_MAP[item.category] ?? item.category) : item.category;
  const group = typeof item.group === "string" && item.group.trim() !== "" ? item.group : null;

  return {
    id: item.id,
    title: item.title,
    category,
    group,
    isStock,
    repeatType,
    weekday: repeatType === "weekly" && isWeekdayValue(item.weekday) ? item.weekday : null,
    monthDay: repeatType === "monthly" && typeof item.monthDay === "number" ? item.monthDay : null,
    isActive: item.isActive,
    inventoryStartDate,
    memo: item.memo,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// 完了ログの正規化。kindSnapshot・categorySnapshot・titleSnapshot は過去の事実なので書き換えない。
// groupSnapshot はv2以前のログには無いので null 補完（垢別の内訳はv3以降のログからしか出ない：titleSnapshot方式の正しい挙動）
function migrateCompletion(value: unknown): Completion | null {
  if (typeof value !== "object" || value === null) return null;
  const completion = value as Record<string, unknown>;
  if (
    typeof completion.id !== "string" ||
    typeof completion.itemId !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(String(completion.targetDate)) ||
    typeof completion.completedAt !== "string" ||
    typeof completion.titleSnapshot !== "string" ||
    typeof completion.categorySnapshot !== "string" ||
    !(completion.kindSnapshot === undefined || isKind(completion.kindSnapshot)) ||
    typeof completion.note !== "string" ||
    !(completion.count === null || typeof completion.count === "number")
  ) {
    return null;
  }
  return {
    id: completion.id,
    itemId: completion.itemId,
    targetDate: String(completion.targetDate),
    completedAt: completion.completedAt,
    titleSnapshot: completion.titleSnapshot,
    categorySnapshot: completion.categorySnapshot,
    groupSnapshot: typeof completion.groupSnapshot === "string" && completion.groupSnapshot !== "" ? completion.groupSnapshot : null,
    ...(isKind(completion.kindSnapshot) ? { kindSnapshot: completion.kindSnapshot } : {}),
    note: completion.note,
    count: completion.count as number | null,
  };
}

function isStockEntry(value: unknown): value is StockEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.itemId === "string" &&
    typeof entry.label === "string" &&
    typeof entry.addedAt === "string"
  );
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
}

function normalizeSettings(raw: unknown, legacy: boolean): Settings {
  const settings = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const dayBoundaryTime = DAY_BOUNDARY_OPTIONS.includes(String(settings.dayBoundaryTime))
    ? String(settings.dayBoundaryTime)
    : DEFAULT_SETTINGS.dayBoundaryTime;
  const weekStartDay = isWeekdayValue(settings.weekStartDay) ? settings.weekStartDay : DEFAULT_SETTINGS.weekStartDay;
  const rawCategories = stringList(settings.categories);
  let categories = rawCategories && rawCategories.length > 0 ? rawCategories : DEFAULT_SETTINGS.categories;
  if (legacy) {
    // v2以前のカテゴリ一覧をv3の既定7種に差し替え、マップ対象外（ユーザー追加分）だけ後ろへ残す
    categories = [
      ...DEFAULT_CATEGORIES,
      ...categories.filter((category) => !DEFAULT_CATEGORIES.includes(category) && !(category in CATEGORY_MIGRATION_MAP)),
    ];
  }
  const groups = stringList(settings.groups) ?? [];
  // 後段で項目由来のカテゴリ・グループを追加（push）するため、既定配列への参照を渡さずコピーする
  return { dayBoundaryTime, weekStartDay, categories: [...categories], groups: [...groups] };
}

// v1/v2/v3のどの形式でも受け取り、v3形式に正規化する移行関数。
// localStorage読み込みとJSONインポートの両方がここを通る（v1/v2バックアップJSONの追加インポートが今後も通る）。冪等
function normalizeAppData(raw: unknown): AppData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  // v2以前は version:1（または欠損）。カテゴリのリマップはそのデータにだけ適用する
  const legacy = data.version !== 2;
  if (!Array.isArray(data.items) || !Array.isArray(data.completions)) return null;
  const items: Item[] = [];
  for (const value of data.items) {
    const item = migrateItem(value, legacy);
    if (!item) return null;
    items.push(item);
  }
  const completions: Completion[] = [];
  for (const value of data.completions) {
    const completion = migrateCompletion(value);
    if (!completion) return null;
    completions.push(completion);
  }
  // stockEntries はv2追加。無い/不正なら空として扱い、v1データをそのまま通す
  const stockEntries = Array.isArray(data.stockEntries) && data.stockEntries.every(isStockEntry) ? data.stockEntries : [];
  const settings = normalizeSettings(data.settings, legacy);
  // 項目が参照するカテゴリ・グループは、選択肢に必ず載せる（「箱がないから記録されない」を防ぐ）
  for (const item of items) {
    if (!settings.categories.includes(item.category)) settings.categories.push(item.category);
    if (item.group && !settings.groups.includes(item.group)) settings.groups.push(item.group);
  }
  return { version: 2, items, completions, stockEntries, settings };
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DATA;
    const parsedRaw = JSON.parse(raw) as Record<string, unknown> | null;
    const parsed = normalizeAppData(parsedRaw);
    if (!parsed) return DEFAULT_DATA;
    if (typeof parsedRaw === "object" && parsedRaw !== null && parsedRaw.version !== 2) {
      // v3移行の直前に、v2までの生データを丸ごと別キーへ退避する（破壊的変更への保険）
      const backupKey = `yuki-kazoe-cho-data-backup-v2-${dateKeyFromDate(new Date()).replace(/-/g, "")}`;
      if (!localStorage.getItem(backupKey)) localStorage.setItem(backupKey, raw);
      localStorage.setItem(BACKUP_NOTICE_KEY, "pending");
    }
    return parsed;
  } catch {
    return DEFAULT_DATA;
  }
}

function loadActiveView(): Tab {
  const stored = localStorage.getItem(ACTIVE_VIEW_KEY);
  return stored === "home" || stored === "last" || stored === "stats" || stored === "settings" ? stored : "home";
}

// ----------------------------- 旧ゆるたすくからの変換 -----------------------------

// 旧 task-manager-backup 形式の recurringTasks / recurringCompletions を新形式へ変換する。
// tasks・routineItems・activityGroups・分数系（durationMinutes 等）は意図的に移行しない。
function convertOldKind(kind: string): Kind {
  if (kind === "確認") return "習慣";
  return isKind(kind) ? kind : "習慣";
}

function convertOldBackup(raw: Record<string, unknown>): { items: Item[]; completions: Completion[]; dayBoundaryTime: string | null } | null {
  if (!Array.isArray(raw.recurringTasks) && !Array.isArray(raw.recurringCompletions)) return null;
  const oldTasks = Array.isArray(raw.recurringTasks) ? raw.recurringTasks : [];
  const oldCompletions = Array.isArray(raw.recurringCompletions) ? raw.recurringCompletions : [];

  const items: Item[] = [];
  for (const value of oldTasks) {
    if (typeof value !== "object" || value === null) return null;
    const task = value as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof task.title !== "string") return null;
    // 旧kind「楽しみ」（繰り返しあり）だけが在庫型。それ以外（確認→習慣 含む）は前回日型として取り込む
    const oldKind = convertOldKind(String(task.kind));
    const isStock = oldKind === "楽しみ";
    const repeatType: RepeatType = isStock ? (task.repeatType === "monthly" ? "monthly" : "weekly") : "none";
    const oldCategory = typeof task.category === "string" ? task.category : "その他";
    items.push({
      id: task.id,
      title: task.title,
      category: CATEGORY_MIGRATION_MAP[oldCategory] ?? oldCategory,
      group: null,
      isStock,
      repeatType,
      weekday: repeatType === "weekly" && isWeekdayValue(task.weekday) ? task.weekday : null,
      monthDay: repeatType === "monthly" && typeof task.monthDay === "number" ? task.monthDay : null,
      isActive: task.isActive !== false,
      inventoryStartDate: isStock && typeof task.inventoryStartDate === "string" ? task.inventoryStartDate : undefined,
      memo: typeof task.memo === "string" ? task.memo : "",
      createdAt: typeof task.createdAt === "string" ? task.createdAt : nowLocalStamp(),
      updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : nowLocalStamp(),
    });
  }

  const completions: Completion[] = [];
  for (const value of oldCompletions) {
    if (typeof value !== "object" || value === null) return null;
    const completion = value as Record<string, unknown>;
    if (typeof completion.id !== "string" || typeof completion.recurringTaskId !== "string") return null;
    completions.push({
      id: completion.id,
      itemId: completion.recurringTaskId,
      targetDate: String(completion.targetDate ?? ""),
      completedAt: typeof completion.completedAt === "string" ? completion.completedAt : nowLocalStamp(),
      titleSnapshot: typeof completion.titleSnapshot === "string" ? completion.titleSnapshot : "",
      categorySnapshot: typeof completion.categorySnapshot === "string" ? completion.categorySnapshot : "その他",
      groupSnapshot: null,
      // 過去ログの控えとして凍結フィールドに変換して残す（「確認」→「習慣」）
      kindSnapshot: convertOldKind(String(completion.kindSnapshot)),
      note: "",
      count: null,
    });
  }

  const oldSettings = (typeof raw.settings === "object" && raw.settings !== null ? raw.settings : {}) as Record<string, unknown>;
  const dayBoundaryTime = DAY_BOUNDARY_OPTIONS.includes(String(oldSettings.dayBoundaryTime)) ? String(oldSettings.dayBoundaryTime) : null;
  return { items, completions, dayBoundaryTime };
}

// ----------------------------- 表示ロジック -----------------------------

// 在庫型かどうかは「在庫にする」スイッチだけで決まる（v3でkindを廃止）
function isInventoryItem(item: Item) {
  return item.isStock;
}

// 単発在庫：対象日を自動生成せず、手で積む
function isSingleStockItem(item: Item) {
  return item.isStock && item.repeatType === "single";
}

// 繰り返し在庫（毎週・毎月）。対象日が固有名（7/6号）と単位（1対象日＝1回）を兼ねるため、
// 記録直後のダイアログ（メモ・数量）を出さずワンタップで確定する（v3.2）
function isRepeatStockItem(item: Item) {
  return item.isStock && (item.repeatType === "weekly" || item.repeatType === "monthly");
}

function matchesRepeatRule(item: Item, date: Date) {
  if (item.repeatType === "weekly") return item.weekday !== null && date.getDay() === item.weekday;
  if (item.repeatType === "monthly") {
    if (item.monthDay === null) return false;
    const day = Math.min(item.monthDay, daysInMonth(date.getFullYear(), date.getMonth()));
    return date.getDate() === day;
  }
  return false;
}

// 在庫の対象日：起点日から今日（生活日付）まで全部を数え、完了済みを除く。
// 「何号から溜まっているか」を一望するのが価値なので、直近N件への省略はしない。
function inventoryDates(item: Item, completedKeys: Set<string>, todayLife: string) {
  const startKey = item.inventoryStartDate ?? item.createdAt.slice(0, 10);
  const floorKey = addDaysKey(todayLife, -MAX_INVENTORY_LOOKBACK_DAYS);
  let cursor = startKey < floorKey ? floorKey : startKey;
  const dates: string[] = [];
  while (cursor <= todayLife) {
    if (matchesRepeatRule(item, dateFromKey(cursor)) && !completedKeys.has(`${item.id}:${cursor}`)) {
      dates.push(cursor);
    }
    cursor = addDaysKey(cursor, 1);
  }
  return dates;
}

// 前回タブの「直近3回」用。新しい順に返す（latestCompletionOfと同じ優先順位：対象日→記録時刻）
function recentCompletionsOf(completions: Completion[], itemId: string, limit: number) {
  return completions
    .filter((completion) => completion.itemId === itemId)
    .sort((a, b) => b.targetDate.localeCompare(a.targetDate) || b.completedAt.localeCompare(a.completedAt))
    .slice(0, limit);
}

// 在庫タブのグループカードに出す「前回」1行用：グループ配下の全項目の完了ログから最新1件
function latestCompletionAmong(completions: Completion[], itemIds: Set<string>) {
  let latest: Completion | null = null;
  for (const completion of completions) {
    if (!itemIds.has(completion.itemId)) continue;
    if (!latest || completion.targetDate > latest.targetDate || (completion.targetDate === latest.targetDate && completion.completedAt > latest.completedAt)) {
      latest = completion;
    }
  }
  return latest;
}

// 集計に使う「行動した日」：記録時刻を日付境界で丸めた生活日付
function doneDateOf(completion: Completion, dayBoundaryTime: string) {
  const parsed = new Date(completion.completedAt);
  if (Number.isNaN(parsed.getTime())) return completion.targetDate;
  return lifeDateKey(parsed, dayBoundaryTime);
}

function quantityOf(completion: Completion) {
  // count 未入力は 1 として扱う（回数＝数量のケースが大半のため）
  return completion.count ?? 1;
}

// カテゴリ＞グループ＞項目の粒度で集計する。行キーは（グループ, タイトル）：
// 開発垢の「記事執筆」と記録垢の「記事執筆」は別の行として数える。
// グループの合計行は作らない（壁打ち12回と記事執筆3回を足した数に意味がなく、合計を出した瞬間に採点が始まるため）
function buildStatCategories(completions: Completion[], categoriesOrder: string[], groupsOrder: string[]): StatCategory[] {
  const byCategory = new Map<string, Map<string, Map<string, StatRow>>>();
  for (const completion of completions) {
    const category = completion.categorySnapshot || "その他";
    // groupSnapshotが空（v2以前のログ）はカテゴリ直下（キー""）に並べる
    const groupKey = completion.groupSnapshot ?? "";
    const groups = byCategory.get(category) ?? new Map<string, Map<string, StatRow>>();
    const rows = groups.get(groupKey) ?? new Map<string, StatRow>();
    const row = rows.get(completion.titleSnapshot) ?? { title: completion.titleSnapshot, count: 0, quantity: 0 };
    row.count += 1;
    row.quantity += quantityOf(completion);
    rows.set(completion.titleSnapshot, row);
    groups.set(groupKey, rows);
    byCategory.set(category, groups);
  }
  const listIndex = (list: string[], value: string) => {
    const index = list.indexOf(value);
    return index === -1 ? list.length : index;
  };
  return Array.from(byCategory.entries())
    .map(([category, groups]) => {
      const groupList: StatGroup[] = Array.from(groups.entries())
        .map(([groupKey, rows]) => ({
          group: groupKey === "" ? null : groupKey,
          rows: Array.from(rows.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "ja")),
        }))
        // カテゴリ直下（group=null）を先頭、続いて設定のグループ順→名前順
        .sort((a, b) => {
          if (a.group === null) return b.group === null ? 0 : -1;
          if (b.group === null) return 1;
          return listIndex(groupsOrder, a.group) - listIndex(groupsOrder, b.group) || a.group.localeCompare(b.group, "ja");
        });
      const allRows = groupList.flatMap((group) => group.rows);
      return {
        category,
        groups: groupList,
        count: allRows.reduce((sum, row) => sum + row.count, 0),
        quantity: allRows.reduce((sum, row) => sum + row.quantity, 0),
      };
    })
    .sort((a, b) => listIndex(categoriesOrder, a.category) - listIndex(categoriesOrder, b.category) || a.category.localeCompare(b.category, "ja"));
}

// ----------------------------- エクスポート -----------------------------

function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function buildMarkdownExport(data: AppData, todayLife: string) {
  const lines: string[] = [];
  lines.push(`# かぞえ帳エクスポート（${todayLife}）`);
  lines.push("");
  lines.push("## 項目一覧");
  lines.push("");
  for (const item of data.items) {
    const shape = isSingleStockItem(item) ? "単発在庫" : isInventoryItem(item) ? "在庫型" : "前回日型";
    const repeat =
      item.repeatType === "weekly" && item.weekday !== null
        ? `毎週${WEEKDAY_LABELS[item.weekday]}曜`
        : item.repeatType === "monthly" && item.monthDay !== null
          ? `毎月${item.monthDay}日`
          : item.repeatType === "single"
            ? "手で積む"
            : "随時";
    const active = item.isActive ? "" : "（停止中）";
    const placement = item.group ? `${item.category}＞${item.group}` : item.category;
    lines.push(`- [${shape}] ${item.title}（${placement}／${repeat}）${active}`);
    if (isSingleStockItem(item)) {
      const entries = data.stockEntries
        .filter((entry) => entry.itemId === item.id)
        .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
      for (const entry of entries) {
        lines.push(`  - 積み：${entry.label || "（名前なし）"}`);
      }
    }
  }
  lines.push("");

  const statTable = (completions: Completion[]) => {
    const rows: string[] = ["| グループ | 項目 | 件数 | 数量 |", "| --- | --- | ---: | ---: |"];
    for (const category of buildStatCategories(completions, data.settings.categories, data.settings.groups)) {
      for (const group of category.groups) {
        for (const row of group.rows) {
          rows.push(`| ${group.group ?? ""} | ${row.title} | ${row.count} | ${row.quantity} |`);
        }
      }
    }
    return rows;
  };

  const byWeek = new Map<string, Completion[]>();
  const byMonth = new Map<string, Completion[]>();
  for (const completion of data.completions) {
    const doneDate = doneDateOf(completion, data.settings.dayBoundaryTime);
    const weekKey = weekStartOf(doneDate, data.settings.weekStartDay);
    byWeek.set(weekKey, [...(byWeek.get(weekKey) ?? []), completion]);
    const monthKey = monthKeyOf(doneDate);
    byMonth.set(monthKey, [...(byMonth.get(monthKey) ?? []), completion]);
  }

  lines.push("## 週次集計");
  lines.push("");
  for (const weekKey of Array.from(byWeek.keys()).sort().reverse()) {
    lines.push(`### ${formatDateWithWeekday(weekKey)}〜${formatDateWithWeekday(addDaysKey(weekKey, 6))}`);
    lines.push("");
    lines.push(...statTable(byWeek.get(weekKey)!));
    lines.push("");
  }

  lines.push("## 月次集計");
  lines.push("");
  for (const monthKey of Array.from(byMonth.keys()).sort().reverse()) {
    lines.push(`### ${formatMonthKey(monthKey)}`);
    lines.push("");
    lines.push(...statTable(byMonth.get(monthKey)!));
    lines.push("");
  }

  lines.push("## 完了ログ");
  lines.push("");
  const sorted = [...data.completions].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  for (const completion of sorted) {
    const doneDate = doneDateOf(completion, data.settings.dayBoundaryTime);
    const note = completion.note ? `（${completion.note}）` : "";
    const count = completion.count !== null ? ` ×${completion.count}` : "";
    lines.push(`- ${doneDate} ${completion.titleSnapshot}${note}${count}｜対象日 ${completion.targetDate}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ----------------------------- 長押し対応ボタン -----------------------------

function RecordButton({ label, className, onTap, onLongPress }: { label: string; className: string; onTap: () => void; onLongPress: () => void }) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return (
    <button
      type="button"
      className={className}
      onPointerDown={() => {
        firedRef.current = false;
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          firedRef.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (firedRef.current) {
          firedRef.current = false;
          return;
        }
        onTap();
      }}
    >
      {label}
    </button>
  );
}

// ----------------------------- 本体 -----------------------------

export default function App() {
  const [data, setData] = useState<AppData>(loadData);
  const [activeTab, setActiveTab] = useState<Tab>(loadActiveView);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // 記録直後の「メモ・数量を足せる」ダイアログ
  const [enrichTarget, setEnrichTarget] = useState<EnrichTarget | null>(null);
  const [enrichNote, setEnrichNote] = useState("");
  const [enrichCount, setEnrichCount] = useState("");

  // 長押し→過去日選択ダイアログ
  const [datePickTarget, setDatePickTarget] = useState<DatePickTarget | null>(null);
  const [pickedDate, setPickedDate] = useState("");

  // 単発在庫：箱ごとの「積む」入力欄
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});

  // 在庫タブ：グループカードごとの「在庫なし N件」の開閉（キー＝グループ名。null群は空文字）
  const [openZeroGroups, setOpenZeroGroups] = useState<Set<string>>(new Set());

  // 記録の取り消し（誤タップの救済）。在庫タブの前回1行・前回タブの直近3回から開く
  const [undoTargetId, setUndoTargetId] = useState<string | null>(null);
  // 積んだもの（StockEntry）の取り下げ（＝記録を作らず積みから消す）
  const [withdrawTarget, setWithdrawTarget] = useState<{ entryId: string; label: string } | null>(null);

  // 前回タブ：折りたたんだグループ（キー＝`カテゴリ|グループ`）
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // v2→v3移行の直後に一度だけ出すバックアップ推奨バナー
  const [backupNoticeVisible, setBackupNoticeVisible] = useState(() => localStorage.getItem(BACKUP_NOTICE_KEY) === "pending");

  // 設定タブ：項目フォーム
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // 設定タブ：グループ管理
  const [newGroupName, setNewGroupName] = useState("");
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<string | null>(null);

  // インポート
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // 集計ビュー
  const [statsMode, setStatsMode] = useState<"weekly" | "monthly">("weekly");
  const [statsOffset, setStatsOffset] = useState(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_VIEW_KEY, activeTab);
  }, [activeTab]);

  const boundary = data.settings.dayBoundaryTime;
  const todayLife = lifeDateKey(new Date(), boundary);

  const completedKeys = useMemo(
    () => new Set(data.completions.map((completion) => `${completion.itemId}:${completion.targetDate}`)),
    [data.completions],
  );

  // 在庫タブ：グループ1つ＝カード1枚（v3.1）。繰り返し在庫と単発在庫を同じグループにまとめる。
  // 在庫がある項目を上、在庫0の項目はグループカードの中の「在庫なし」に畳む（並べ替え機能は付けない）
  const inventoryGroups = useMemo(() => {
    const stockItems = data.items.filter((item) => item.isActive && isInventoryItem(item));
    const byGroup = new Map<string, InventoryEntry[]>();
    for (const item of stockItems) {
      const entry: InventoryEntry = isSingleStockItem(item)
        ? {
            type: "single",
            item,
            entries: data.stockEntries.filter((stock) => stock.itemId === item.id).sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
          }
        : { type: "repeat", item, dates: inventoryDates(item, completedKeys, todayLife) };
      const key = item.group ?? "";
      const list = byGroup.get(key) ?? [];
      list.push(entry);
      byGroup.set(key, list);
    }
    const listIndex = (list: string[], value: string) => {
      const index = list.indexOf(value);
      return index === -1 ? list.length : index;
    };
    const hasStock = (entry: InventoryEntry) => (entry.type === "repeat" ? entry.dates.length > 0 : entry.entries.length > 0);
    const groups = Array.from(byGroup.entries()).map(([key, entries]) => {
      // v2踏襲：繰り返し在庫→単発在庫、各群内はタイトル順
      entries.sort((a, b) => (a.type === b.type ? a.item.title.localeCompare(b.item.title, "ja") : a.type === "repeat" ? -1 : 1));
      const stocked = entries.filter(hasStock);
      const zero = entries.filter((entry) => !hasStock(entry));
      const totalDates = entries.reduce((sum, entry) => sum + (entry.type === "repeat" ? entry.dates.length : 0), 0);
      const totalItems = entries.reduce((sum, entry) => sum + (entry.type === "single" ? entry.entries.length : 0), 0);
      const itemIds = new Set(entries.map((entry) => entry.item.id));
      return {
        key,
        group: key === "" ? null : key,
        stocked,
        zero,
        totalDates,
        totalItems,
        hasRepeat: entries.some((entry) => entry.type === "repeat"),
        hasSingle: entries.some((entry) => entry.type === "single"),
        latest: latestCompletionAmong(data.completions, itemIds),
        hasAnyStock: stocked.length > 0,
      };
    });
    // 在庫があるグループを上、空のグループを下。各区画内は設定のグループ順→名前順。（グループなし）は末尾
    groups.sort((a, b) => {
      if (a.hasAnyStock !== b.hasAnyStock) return a.hasAnyStock ? -1 : 1;
      if ((a.group === null) !== (b.group === null)) return a.group === null ? 1 : -1;
      if (a.group === null || b.group === null) return 0;
      return listIndex(data.settings.groups, a.group) - listIndex(data.settings.groups, b.group) || a.group.localeCompare(b.group, "ja");
    });
    return groups;
  }, [data.items, data.stockEntries, data.completions, completedKeys, todayLife, data.settings.groups]);

  const inventoryTotal = inventoryGroups.reduce((sum, group) => sum + group.totalDates + group.totalItems, 0);

  const lastItems = useMemo(
    () =>
      data.items
        .filter((item) => item.isActive && !isInventoryItem(item))
        .map((item) => ({ item, recent: recentCompletionsOf(data.completions, item.id, 3) })),
    [data.items, data.completions],
  );

  // 前回タブ：カテゴリ＞グループ＞項目 の3階層。グループ未設定（null）の項目はカテゴリ直下に並ぶ。
  // 空グループ・空カテゴリは項目由来で組み立てるため自然に表示されない
  const lastCategories = useMemo(() => {
    const byCategory = new Map<string, Map<string, typeof lastItems>>();
    for (const entry of lastItems) {
      const groups = byCategory.get(entry.item.category) ?? new Map<string, typeof lastItems>();
      const groupKey = entry.item.group ?? "";
      const list = groups.get(groupKey) ?? [];
      list.push(entry);
      groups.set(groupKey, list);
      byCategory.set(entry.item.category, groups);
    }
    const listIndex = (list: string[], value: string) => {
      const index = list.indexOf(value);
      return index === -1 ? list.length : index;
    };
    return Array.from(byCategory.entries())
      .map(([category, groups]) => ({
        category,
        groups: Array.from(groups.entries())
          .map(([groupKey, entries]) => ({
            group: groupKey === "" ? null : groupKey,
            entries: entries.sort((a, b) => a.item.title.localeCompare(b.item.title, "ja")),
          }))
          .sort((a, b) => {
            if (a.group === null) return b.group === null ? 0 : -1;
            if (b.group === null) return 1;
            return listIndex(data.settings.groups, a.group) - listIndex(data.settings.groups, b.group) || a.group.localeCompare(b.group, "ja");
          }),
      }))
      .sort(
        (a, b) =>
          listIndex(data.settings.categories, a.category) - listIndex(data.settings.categories, b.category) ||
          a.category.localeCompare(b.category, "ja"),
      );
  }, [lastItems, data.settings.categories, data.settings.groups]);

  // ----------------------------- 記録 -----------------------------

  function recordCompletion(item: Item, targetDate: string, doneDate: string | null) {
    const completion: Completion = {
      id: genId(),
      itemId: item.id,
      targetDate,
      // 過去日記録は正午扱いにして、日付境界をまたいでも選んだ日に集計されるようにする
      completedAt: doneDate ? `${doneDate}T12:00:00` : nowLocalStamp(),
      titleSnapshot: item.title,
      categorySnapshot: item.category,
      groupSnapshot: item.group,
      note: "",
      count: null,
    };
    setData((current) => ({ ...current, completions: [completion, ...current.completions] }));
    setMessage(null);
    // 繰り返し在庫はワンタップ完了（長押し→日付選択でも同じ）。対象日が固有名と単位を兼ねるため、
    // 記録直後ダイアログを開かない。取り消しは在庫タブの前回行に一本化する（v3.2）
    if (isRepeatStockItem(item)) return;
    // ここに到達するのは前回日型のみ（単発在庫は consumeStockEntry を通る）
    setEnrichTarget({ completionId: completion.id, title: item.title, dateLabel: formatDateWithWeekday(doneDate ?? targetDate) });
    setEnrichNote("");
    setEnrichCount("");
  }

  // 単発在庫に1件積む。名前は任意（空でも積める）
  function addStockEntry(item: Item) {
    const label = (stockDrafts[item.id] ?? "").trim();
    const entry: StockEntry = { id: genId(), itemId: item.id, label, addedAt: nowLocalStamp() };
    setData((current) => ({ ...current, stockEntries: [...current.stockEntries, entry] }));
    setStockDrafts((current) => ({ ...current, [item.id]: "" }));
    setMessage(null);
  }

  // 単発在庫の消化：積みから外して完了ログへ。titleSnapshotは積んだ名前（空なら箱の名前）
  function consumeStockEntry(item: Item, entry: StockEntry, doneDate: string | null) {
    const completion: Completion = {
      id: genId(),
      itemId: item.id,
      targetDate: doneDate ?? todayLife,
      completedAt: doneDate ? `${doneDate}T12:00:00` : nowLocalStamp(),
      titleSnapshot: entry.label || item.title,
      categorySnapshot: item.category,
      groupSnapshot: item.group,
      note: "",
      count: null,
    };
    setData((current) => ({
      ...current,
      completions: [completion, ...current.completions],
      stockEntries: current.stockEntries.filter((stock) => stock.id !== entry.id),
    }));
    setEnrichTarget({
      completionId: completion.id,
      title: completion.titleSnapshot,
      dateLabel: formatDateWithWeekday(doneDate ?? todayLife),
      consumedStockEntry: entry,
    });
    setEnrichNote("");
    setEnrichCount("");
    setMessage(null);
  }

  function saveEnrichment() {
    if (!enrichTarget) return;
    const trimmedNote = enrichNote.trim();
    const parsedCount = enrichCount.trim() === "" ? null : Number(enrichCount);
    if (parsedCount !== null && (!Number.isFinite(parsedCount) || parsedCount <= 0)) {
      setMessage({ type: "error", text: "数量は1以上の数字で入れてください" });
      return;
    }
    setData((current) => ({
      ...current,
      completions: current.completions.map((completion) =>
        completion.id === enrichTarget.completionId ? { ...completion, note: trimmedNote, count: parsedCount } : completion,
      ),
    }));
    setEnrichTarget(null);
  }

  function undoEnrichTarget() {
    if (!enrichTarget) return;
    const restoredEntry = enrichTarget.consumedStockEntry;
    setData((current) => ({
      ...current,
      completions: current.completions.filter((completion) => completion.id !== enrichTarget.completionId),
      // 単発在庫の消化を取り消したら、積みに戻す（表示はaddedAt順なので元の位置に戻る）
      stockEntries: restoredEntry ? [...current.stockEntries, restoredEntry] : current.stockEntries,
    }));
    setEnrichTarget(null);
    setMessage({ type: "success", text: "記録を取り消しました" });
  }

  // 記録の取り消し（誤タップの救済）。画面に出ている記録だけが対象。
  // 繰り返し在庫→対象日が在庫に戻る（ログを消せば自動で戻る）。単発在庫→積みに戻す。前回日型→前回が縮む
  function undoCompletion(completionId: string) {
    setData((current) => {
      const completion = current.completions.find((entry) => entry.id === completionId);
      if (!completion) return current;
      const item = current.items.find((entry) => entry.id === completion.itemId);
      const completions = current.completions.filter((entry) => entry.id !== completionId);
      let stockEntries = current.stockEntries;
      if (item && isSingleStockItem(item)) {
        // 消化した積みを戻す（元エントリのid/addedAtは失われるので、消化時刻を積み時刻として復元）
        const label = completion.titleSnapshot === item.title ? "" : completion.titleSnapshot;
        stockEntries = [...current.stockEntries, { id: genId(), itemId: item.id, label, addedAt: completion.completedAt }];
      }
      return { ...current, completions, stockEntries };
    });
    setUndoTargetId(null);
    setMessage({ type: "success", text: "記録を取り消しました" });
  }

  // 積んだもの（StockEntry）の取り下げ。完了ログは作らず、積みから消えるだけ（「楽しんだ」とは別操作）
  function withdrawEntry(entryId: string) {
    setData((current) => ({ ...current, stockEntries: current.stockEntries.filter((entry) => entry.id !== entryId) }));
    setWithdrawTarget(null);
    setMessage({ type: "success", text: "積みから取り下げました" });
  }

  // 在庫タブ：グループカードごとの「在庫なし」開閉
  function toggleZeroGroup(key: string) {
    setOpenZeroGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function openDatePick(item: Item, slotDate: string | null, stockEntry?: StockEntry) {
    setDatePickTarget({ item, slotDate, stockEntry });
    setPickedDate(addDaysKey(todayLife, -1));
  }

  function confirmDatePick() {
    if (!datePickTarget || !pickedDate) return;
    const { item, slotDate, stockEntry } = datePickTarget;
    setDatePickTarget(null);
    if (stockEntry) {
      consumeStockEntry(item, stockEntry, pickedDate);
      return;
    }
    recordCompletion(item, slotDate ?? pickedDate, pickedDate);
  }

  // ----------------------------- 項目フォーム -----------------------------

  function emptyDraft(): ItemDraft {
    return {
      title: "",
      category: data.settings.categories[0] ?? "その他",
      newCategory: "",
      group: NO_GROUP_VALUE,
      newGroup: "",
      isStock: false,
      repeatType: "weekly",
      weekday: "1",
      monthDay: "1",
      inventoryStartDate: "",
      memo: "",
      isActive: true,
    };
  }

  function draftFromItem(item: Item): ItemDraft {
    return {
      title: item.title,
      category: item.category,
      newCategory: "",
      group: item.group ?? NO_GROUP_VALUE,
      newGroup: "",
      isStock: item.isStock,
      // 在庫にしない項目を編集中にONへ切り替えたとき、繰り返しの初期値が毎週になるようにしておく
      repeatType: item.repeatType === "none" ? "weekly" : item.repeatType,
      weekday: item.weekday === null ? "1" : String(item.weekday),
      monthDay: item.monthDay === null ? "1" : String(item.monthDay),
      inventoryStartDate: item.inventoryStartDate ?? "",
      memo: item.memo,
      isActive: item.isActive,
    };
  }

  function saveDraft() {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) {
      setMessage({ type: "error", text: "タイトルを入れてください" });
      return;
    }
    const category = draft.category === NEW_CATEGORY_VALUE ? draft.newCategory.trim() : draft.category;
    if (!category) {
      setMessage({ type: "error", text: "カテゴリ名を入れてください" });
      return;
    }
    if (draft.group === NEW_GROUP_VALUE && !draft.newGroup.trim()) {
      setMessage({ type: "error", text: "グループ名を入れてください" });
      return;
    }
    const group = draft.group === NEW_GROUP_VALUE ? draft.newGroup.trim() : draft.group === NO_GROUP_VALUE ? null : draft.group;
    // 在庫にしない項目は repeatType=none 固定（曜日・日にち・起点日は持たない）
    const isStock = draft.isStock;
    const repeatType: RepeatType = isStock ? draft.repeatType : "none";
    const weekday = repeatType === "weekly" ? (Number(draft.weekday) as Weekday) : null;
    const monthDayNumber = Number(draft.monthDay);
    const monthDay = repeatType === "monthly" ? Math.min(Math.max(Math.round(monthDayNumber) || 1, 1), 31) : null;
    const inventoryStartDate =
      (repeatType === "weekly" || repeatType === "monthly") && /^\d{4}-\d{2}-\d{2}$/.test(draft.inventoryStartDate)
        ? draft.inventoryStartDate
        : undefined;
    const stamp = nowLocalStamp();

    setData((current) => {
      const categories = current.settings.categories.includes(category)
        ? current.settings.categories
        : [...current.settings.categories, category];
      const groups = group && !current.settings.groups.includes(group) ? [...current.settings.groups, group] : current.settings.groups;
      if (editingItemId) {
        return {
          ...current,
          settings: { ...current.settings, categories, groups },
          items: current.items.map((item) =>
            item.id === editingItemId
              ? { ...item, title, category, group, isStock, repeatType, weekday, monthDay, inventoryStartDate, memo: draft.memo.trim(), isActive: draft.isActive, updatedAt: stamp }
              : item,
          ),
        };
      }
      const item: Item = {
        id: genId(),
        title,
        category,
        group,
        isStock,
        repeatType,
        weekday,
        monthDay,
        isActive: draft.isActive,
        inventoryStartDate,
        memo: draft.memo.trim(),
        createdAt: stamp,
        updatedAt: stamp,
      };
      return { ...current, settings: { ...current.settings, categories, groups }, items: [...current.items, item] };
    });
    setDraft(null);
    setEditingItemId(null);
    setMessage({ type: "success", text: editingItemId ? "項目を更新しました" : "項目を追加しました" });
  }

  // 設定タブ：グループの追加（空でも「受け皿」として選択肢に残る）
  function addGroup() {
    const name = newGroupName.trim();
    if (!name) {
      setMessage({ type: "error", text: "グループ名を入れてください" });
      return;
    }
    if (data.settings.groups.includes(name)) {
      setMessage({ type: "error", text: "同じ名前のグループがあります" });
      return;
    }
    setData((current) => ({ ...current, settings: { ...current.settings, groups: [...current.settings.groups, name] } }));
    setNewGroupName("");
    setMessage({ type: "success", text: `グループ「${name}」を追加しました` });
  }

  // グループ削除：項目が1件でも入っているグループは削除しない（UIで無効化済み）。空グループを選択肢から外すだけ
  function deleteGroup(name: string) {
    if (data.items.some((item) => item.group === name)) return;
    setData((current) => ({
      ...current,
      settings: { ...current.settings, groups: current.settings.groups.filter((group) => group !== name) },
    }));
    setDeleteGroupTarget(null);
    setMessage({ type: "success", text: `グループ「${name}」を削除しました` });
  }

  function dismissBackupNotice() {
    localStorage.removeItem(BACKUP_NOTICE_KEY);
    setBackupNoticeVisible(false);
  }

  // 前回タブ：グループ見出しの折りたたみ切り替え
  function toggleGroupCollapse(key: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function deleteItem(itemId: string) {
    // titleSnapshot 方式なので、項目を消しても完了ログと集計は残る。未消化の積みは箱と一緒に消す
    setData((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== itemId),
      stockEntries: current.stockEntries.filter((entry) => entry.itemId !== itemId),
    }));
    setDeleteTargetId(null);
    setMessage({ type: "success", text: "項目を削除しました（記録は残ります）" });
  }

  // ----------------------------- 入出力 -----------------------------

  function exportJson() {
    const payload = { app: "kazoe-cho", exportedAt: nowLocalStamp(), ...data };
    downloadTextFile(`kazoe-cho-backup-${todayLife}.json`, JSON.stringify(payload, null, 2), "application/json");
    setMessage({ type: "success", text: "JSONをエクスポートしました" });
  }

  function exportMarkdown() {
    downloadTextFile(`kazoe-cho-export-${todayLife}.md`, buildMarkdownExport(data, todayLife), "text/markdown");
    setMessage({ type: "success", text: "Markdownをエクスポートしました" });
  }

  function handleImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as Record<string, unknown>;
        let incomingItems: Item[] = [];
        let incomingCompletions: Completion[] = [];
        let incomingStockEntries: StockEntry[] = [];
        let incomingCategories: string[] = [];
        let incomingGroups: string[] = [];
        let adoptDayBoundary: string | null = null;
        let sourceLabel = "";

        const asNew = normalizeAppData(raw);
        if (asNew) {
          incomingItems = asNew.items;
          incomingCompletions = asNew.completions;
          incomingStockEntries = asNew.stockEntries;
          // 空のカテゴリ・グループも「受け皿」なので設定ごと取り込む（シードJSON対応）
          incomingCategories = asNew.settings.categories;
          incomingGroups = asNew.settings.groups;
          sourceLabel = "かぞえ帳バックアップ";
        } else {
          const asOld = convertOldBackup(raw);
          if (!asOld) {
            setMessage({ type: "error", text: "対応していない形式のファイルです" });
            return;
          }
          incomingItems = asOld.items;
          incomingCompletions = asOld.completions;
          incomingCategories = asOld.items.map((item) => item.category);
          adoptDayBoundary = asOld.dayBoundaryTime;
          sourceLabel = "旧ゆるたすくバックアップ（変換して取り込み）";
        }

        const existingItemIds = new Set(data.items.map((item) => item.id));
        const existingCompletionIds = new Set(data.completions.map((completion) => completion.id));
        const existingStockEntryIds = new Set(data.stockEntries.map((entry) => entry.id));
        const addedItems = incomingItems.filter((item) => !existingItemIds.has(item.id));
        const addedCompletions = incomingCompletions.filter((completion) => !existingCompletionIds.has(completion.id));
        const addedStockEntries = incomingStockEntries.filter((entry) => !existingStockEntryIds.has(entry.id));

        setImportPreview({
          sourceLabel,
          incomingItems: addedItems,
          incomingCompletions: addedCompletions,
          incomingStockEntries: addedStockEntries,
          incomingCategories,
          incomingGroups,
          adoptDayBoundary,
          counts: [
            { label: "項目", loaded: incomingItems.length, added: addedItems.length, skipped: incomingItems.length - addedItems.length },
            { label: "完了ログ", loaded: incomingCompletions.length, added: addedCompletions.length, skipped: incomingCompletions.length - addedCompletions.length },
            { label: "積んだもの（未消化）", loaded: incomingStockEntries.length, added: addedStockEntries.length, skipped: incomingStockEntries.length - addedStockEntries.length },
          ],
        });
      } catch {
        setMessage({ type: "error", text: "JSONの読み込みに失敗しました" });
      }
    };
    reader.readAsText(file);
  }

  function applyImport() {
    if (!importPreview) return;
    setData((current) => {
      const categories = [...current.settings.categories];
      for (const category of [...importPreview.incomingCategories, ...importPreview.incomingItems.map((item) => item.category)]) {
        if (!categories.includes(category)) categories.push(category);
      }
      const groups = [...current.settings.groups];
      for (const group of [...importPreview.incomingGroups, ...importPreview.incomingItems.map((item) => item.group)]) {
        if (group && !groups.includes(group)) groups.push(group);
      }
      return {
        ...current,
        items: [...current.items, ...importPreview.incomingItems],
        completions: [...importPreview.incomingCompletions, ...current.completions],
        stockEntries: [...current.stockEntries, ...importPreview.incomingStockEntries],
        settings: {
          ...current.settings,
          categories,
          groups,
          dayBoundaryTime: importPreview.adoptDayBoundary ?? current.settings.dayBoundaryTime,
        },
      };
    });
    setImportPreview(null);
    setMessage({ type: "success", text: "追加インポートが完了しました" });
  }

  // ----------------------------- 集計 -----------------------------

  const statsPeriod = useMemo(() => {
    if (statsMode === "weekly") {
      const currentStart = weekStartOf(todayLife, data.settings.weekStartDay);
      const start = addDaysKey(currentStart, -7 * statsOffset);
      const end = addDaysKey(start, 6);
      return {
        label: `${formatDateWithWeekday(start)}〜${formatDateWithWeekday(end)}`,
        contains: (doneDate: string) => doneDate >= start && doneDate <= end,
      };
    }
    const monthKey = shiftMonthKey(monthKeyOf(todayLife), -statsOffset);
    return {
      label: formatMonthKey(monthKey),
      contains: (doneDate: string) => monthKeyOf(doneDate) === monthKey,
    };
  }, [statsMode, statsOffset, todayLife, data.settings.weekStartDay]);

  const statsCompletions = useMemo(
    () => data.completions.filter((completion) => statsPeriod.contains(doneDateOf(completion, boundary))),
    [data.completions, statsPeriod, boundary],
  );

  const statCategories = useMemo(
    () => buildStatCategories(statsCompletions, data.settings.categories, data.settings.groups),
    [statsCompletions, data.settings.categories, data.settings.groups],
  );

  const statsTotalCount = statCategories.reduce((sum, category) => sum + category.count, 0);
  const statsTotalQuantity = statCategories.reduce((sum, category) => sum + category.quantity, 0);

  // ----------------------------- 描画 -----------------------------

  const tabLabels: { key: Tab; label: string }[] = [
    { key: "home", label: "在庫" },
    { key: "last", label: "前回" },
    { key: "stats", label: "集計" },
    { key: "settings", label: "設定" },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">いつから？いくつ？の行動台帳</p>
          <h1>かぞえ帳</h1>
        </div>
      </header>

      {message && (
        <div className={`message ${message.type}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)}>閉じる</button>
        </div>
      )}

      {backupNoticeVisible && (
        <div className="notice-banner">
          <p>データをv3形式に更新しました。念のためJSONエクスポートで控えを取っておくのがおすすめです（更新前のデータはこの端末内に退避済み）</p>
          <div className="button-row">
            <button type="button" className="primary-button" onClick={() => { exportJson(); dismissBackupNotice(); }}>JSONエクスポート</button>
            <button type="button" onClick={dismissBackupNotice}>あとで</button>
          </div>
        </div>
      )}

      <main className="view-stack">
        {activeTab === "home" && (
          <>
            <section className="section inventory-lead">
              <h2>楽しみの在庫</h2>
              <p className="small-note">
                {inventoryTotal > 0 ? `いま ${inventoryTotal} 回ぶん たまっています。どれ楽しむ？` : "在庫はぜんぶ楽しみ済み。次が積まれるのを待つだけ"}
              </p>
            </section>
            {inventoryGroups.length === 0 && (
              <section className="section">
                <p className="empty-text">在庫型の項目がまだありません。設定タブで「在庫にする」項目（毎週・毎月・単発在庫）をつくると、ここに在庫が積まれていきます。</p>
              </section>
            )}
            {/* グループ1つ＝カード1枚（v3.1）。在庫がある項目を上、在庫0はカード内の「在庫なし」に畳む */}
            {inventoryGroups.map((group) => {
              // 在庫がある分だけ数える。0の側は「在庫なし」の畳みが伝えるのでチップに出さない
              const countParts: string[] = [];
              if (group.totalDates > 0) countParts.push(`${group.totalDates}回ぶん`);
              if (group.totalItems > 0) countParts.push(`${group.totalItems}件`);
              const groupLabel = group.group ?? "（グループなし）";
              const zeroOpen = openZeroGroups.has(group.key);
              return (
                <section key={group.key} className="section inventory-card">
                  <div className="inventory-card-head">
                    <h3>{groupLabel}</h3>
                    {countParts.length > 0 && <span className="count-chip">{countParts.join("・")}</span>}
                  </div>
                  {/* グループ配下の最新1件。タップで取り消せる（誤タップの救済） */}
                  {group.latest && (
                    <button type="button" className="single-latest undo-latest" onClick={() => setUndoTargetId(group.latest!.id)}>
                      前回：{formatShortDate(doneDateOf(group.latest, boundary))}（{group.latest.titleSnapshot}）
                    </button>
                  )}
                  {group.stocked.length > 0 && <div className="card-divider" />}
                  {group.stocked.map((entry) => {
                    const showSub = entry.item.title !== (group.group ?? "");
                    return (
                      <div key={entry.item.id} className="inv-item-block">
                        {showSub && <p className="inv-item-title">{entry.item.title}</p>}
                        {entry.type === "repeat" ? (
                          <div className="inventory-date-list">
                            {entry.dates.map((date) => (
                              <div key={date} className="inventory-date-row">
                                <span>{formatDateWithWeekday(date)}ぶん</span>
                                <RecordButton
                                  label="楽しんだ"
                                  className="enjoy-button"
                                  onTap={() => recordCompletion(entry.item, date, null)}
                                  onLongPress={() => openDatePick(entry.item, date)}
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <>
                            <div className="inventory-date-list">
                              {entry.entries.map((stock) => (
                                <div key={stock.id} className="inventory-date-row single-entry-row">
                                  <span>{stock.label || "（名前なし）"}</span>
                                  <div className="entry-actions">
                                    <button
                                      type="button"
                                      className="withdraw-button"
                                      onClick={() => setWithdrawTarget({ entryId: stock.id, label: stock.label || "（名前なし）" })}
                                    >
                                      取り下げる
                                    </button>
                                    <RecordButton
                                      label="楽しんだ"
                                      className="enjoy-button"
                                      onTap={() => consumeStockEntry(entry.item, stock, null)}
                                      onLongPress={() => openDatePick(entry.item, null, stock)}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="stock-add-row">
                              <input
                                value={stockDrafts[entry.item.id] ?? ""}
                                onChange={(event) => setStockDrafts((current) => ({ ...current, [entry.item.id]: event.target.value }))}
                                placeholder="例：国宝（積むものの名前）"
                              />
                              <button type="button" className="primary-button" onClick={() => addStockEntry(entry.item)}>積む</button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {/* 在庫0の項目はこのカードの中に畳む（展開時も1件1行の軽い表示） */}
                  {group.zero.length > 0 && (
                    <div className="zero-stock-section">
                      <button type="button" className="zero-stock-chip" onClick={() => toggleZeroGroup(group.key)}>
                        <span>在庫なし {group.zero.length}件</span>
                        <span className="chip-caret">{zeroOpen ? "たたむ ▲" : "ひらく ▼"}</span>
                      </button>
                      {zeroOpen && (
                        <div className="zero-stock-list">
                          {group.zero.map((entry) =>
                            entry.type === "repeat" ? (
                              <div key={entry.item.id} className="zero-stock-row">
                                <span className="zero-stock-title">{entry.item.title}</span>
                                <span className="zero-stock-note">ぜんぶ楽しみ済み 🎉</span>
                              </div>
                            ) : (
                              <div key={entry.item.id} className="zero-stock-row">
                                <span className="zero-stock-title">{entry.item.title}</span>
                                <div className="zero-stock-add">
                                  <input
                                    value={stockDrafts[entry.item.id] ?? ""}
                                    onChange={(event) => setStockDrafts((current) => ({ ...current, [entry.item.id]: event.target.value }))}
                                    placeholder="積むものの名前"
                                  />
                                  <button type="button" onClick={() => addStockEntry(entry.item)}>積む</button>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}

        {activeTab === "last" && (
          <>
            <section className="section">
              <h2>前回いつ？</h2>
              <p className="small-note">事実だけを並べる棚。目標も達成率もありません。「やった」長押しで過去の日付でも記録できます</p>
            </section>
            {lastCategories.length === 0 && (
              <section className="section">
                <p className="empty-text">前回日型の項目がまだありません。設定タブで「在庫にしない」項目（洗濯・サウナ・記事執筆など）をつくると、ここに並びます。</p>
              </section>
            )}
            {/* カテゴリ＞グループ＞項目 の3階層。グループは見出しだけで「やった」ボタンは付けない（確定仕様） */}
            {lastCategories.map((categoryBlock) => (
              <section key={categoryBlock.category} className="section">
                <h3 className="group-title">{categoryBlock.category}</h3>
                <div className="last-category-body">
                  {categoryBlock.groups.map((groupBlock) => {
                    const collapseKey = `${categoryBlock.category}|${groupBlock.group ?? ""}`;
                    const collapsed = groupBlock.group !== null && collapsedGroups.has(collapseKey);
                    return (
                      <div key={collapseKey} className="last-group-block">
                        {groupBlock.group !== null && (
                          <button type="button" className="last-group-head" onClick={() => toggleGroupCollapse(collapseKey)}>
                            <span>{groupBlock.group}</span>
                            <span className="chip-caret">{collapsed ? "▼" : "▲"}</span>
                          </button>
                        )}
                        {!collapsed && (
                          <div className={`last-list${groupBlock.group !== null ? " grouped" : ""}`}>
                            {groupBlock.entries.map(({ item, recent }) => {
                              const latest = recent[0] ?? null;
                              const latestDoneDate = latest ? doneDateOf(latest, boundary) : null;
                              return (
                                <div key={item.id} className="last-row">
                                  <div className="last-info">
                                    <span className="last-title">{item.title}</span>
                                    <span className="last-meta">
                                      {latest && latestDoneDate ? (
                                        <>
                                          前回：
                                          {/* 直近3回の各日付はタップで取り消せる（画面に出ている記録だけが対象・誤タップの救済） */}
                                          <button type="button" className="undo-date-chip" onClick={() => setUndoTargetId(latest.id)}>
                                            {formatShortDate(latestDoneDate)}
                                            {latest.note ? `（${latest.note}）` : ""}・
                                            {diffDays(latestDoneDate, todayLife) === 0 ? "今日" : `${diffDays(latestDoneDate, todayLife)}日前`}
                                          </button>
                                          {/* 2回前・3回前は補助情報として淡く小さく。主役は前回日と経過日数（確定仕様） */}
                                          {recent.length > 1 && (
                                            <span className="last-history">
                                              {" ／ "}
                                              {recent.slice(1).map((completion, index) => (
                                                <Fragment key={completion.id}>
                                                  {index > 0 && "・"}
                                                  <button type="button" className="undo-date-chip subtle" onClick={() => setUndoTargetId(completion.id)}>
                                                    {formatShortDate(doneDateOf(completion, boundary))}
                                                  </button>
                                                </Fragment>
                                              ))}
                                            </span>
                                          )}
                                        </>
                                      ) : (
                                        "記録はこれから"
                                      )}
                                    </span>
                                  </div>
                                  <RecordButton
                                    label="やった"
                                    className="did-button"
                                    onTap={() => recordCompletion(item, todayLife, null)}
                                    onLongPress={() => openDatePick(item, null)}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        )}

        {activeTab === "stats" && (
          <>
            <section className="section">
              <h2>集計</h2>
              <p className="small-note">充実してる度の見える化。採点ではありません（週は{WEEKDAY_LABELS[data.settings.weekStartDay]}曜{boundary}始まり）</p>
              <div className="stats-controls">
                <div className="segmented">
                  <button type="button" className={statsMode === "weekly" ? "active" : ""} onClick={() => { setStatsMode("weekly"); setStatsOffset(0); }}>週次</button>
                  <button type="button" className={statsMode === "monthly" ? "active" : ""} onClick={() => { setStatsMode("monthly"); setStatsOffset(0); }}>月次</button>
                </div>
                <div className="period-nav">
                  <button type="button" onClick={() => setStatsOffset((value) => value + 1)}>◀ 前</button>
                  <span className="period-label">{statsPeriod.label}</span>
                  <button type="button" disabled={statsOffset === 0} onClick={() => setStatsOffset((value) => Math.max(0, value - 1))}>次 ▶</button>
                </div>
              </div>
              <p className="stats-total">合計 {statsTotalCount} 件・数量 {statsTotalQuantity}</p>
            </section>
            {statCategories.length === 0 && (
              <section className="section">
                <p className="empty-text">この期間の記録はまだありません。</p>
              </section>
            )}
            {statCategories.map((category) => (
              <section key={category.category} className="section">
                <div className="stat-category-head">
                  <h3 className="group-title">{category.category}</h3>
                  <span className="stat-subtotal">{category.count}件・数量{category.quantity}</span>
                </div>
                <table className="stat-table">
                  <thead>
                    <tr><th>項目</th><th>件数</th><th>数量</th></tr>
                  </thead>
                  <tbody>
                    {/* グループは見出し行だけ。合計行は出さない（重みの違う行動を足した数に意味がないため） */}
                    {category.groups.map((group) => (
                      <Fragment key={group.group ?? "__direct__"}>
                        {group.group !== null && (
                          <tr className="stat-group-row">
                            <td colSpan={3}>{group.group}</td>
                          </tr>
                        )}
                        {group.rows.map((row) => (
                          <tr key={`${group.group ?? ""}|${row.title}`} className={group.group !== null ? "stat-grouped-row" : undefined}>
                            <td>{row.title}</td>
                            <td className="num">{row.count}</td>
                            <td className="num">{row.quantity}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
          </>
        )}

        {activeTab === "settings" && (
          <>
            <section className="section">
              <h2>項目</h2>
              <button type="button" className="primary-button add-item-button" onClick={() => { setDraft(emptyDraft()); setEditingItemId(null); }}>
                ＋ 項目をつくる
              </button>
              <div className="item-list">
                {data.items.map((item) => {
                  const repeatLabel =
                    item.repeatType === "weekly" && item.weekday !== null
                      ? `毎週${WEEKDAY_LABELS[item.weekday]}`
                      : item.repeatType === "monthly" && item.monthDay !== null
                        ? `毎月${item.monthDay}日`
                        : item.repeatType === "single"
                          ? "手で積む"
                          : "随時";
                  return (
                    <div key={item.id} className={`item-row ${item.isActive ? "" : "inactive"}`}>
                      <div className="item-row-info">
                        <span className="item-row-title">{item.title}</span>
                        <span className="item-row-meta">
                          {isSingleStockItem(item) ? "単発在庫" : isInventoryItem(item) ? "在庫型" : "前回日型"}・{item.category}{item.group ? `＞${item.group}` : ""}・{repeatLabel}
                          {item.isActive ? "" : "・停止中"}
                        </span>
                      </div>
                      <div className="item-row-actions">
                        <button type="button" onClick={() => { setDraft(draftFromItem(item)); setEditingItemId(item.id); }}>編集</button>
                        <button type="button" className="subtle-button" onClick={() => setDeleteTargetId(item.id)}>削除</button>
                      </div>
                    </div>
                  );
                })}
                {data.items.length === 0 && <p className="empty-text">項目はまだありません。</p>}
              </div>
            </section>

            <section className="section">
              <h2>グループ</h2>
              <p className="small-note">カテゴリと項目の間の中分類（アニメ、開発垢、家事…）。項目が0件のグループは在庫・前回タブに出ませんが、選択肢としてはここに残ります。項目が入っているグループは削除できません（先に項目を移すか削除してください）</p>
              <div className="group-add-row">
                <input
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  placeholder="例：アニメ、開発垢、家事"
                />
                <button type="button" className="primary-button" onClick={addGroup}>追加</button>
              </div>
              <div className="item-list">
                {data.settings.groups.map((group) => {
                  const hasMembers = data.items.some((item) => item.group === group);
                  return (
                    <div key={group} className="item-row">
                      <div className="item-row-info">
                        <span className="item-row-title">{group}</span>
                        {hasMembers && <span className="item-row-meta">項目が入っています</span>}
                      </div>
                      <div className="item-row-actions">
                        <button type="button" className="subtle-button" disabled={hasMembers} onClick={() => setDeleteGroupTarget(group)}>削除</button>
                      </div>
                    </div>
                  );
                })}
                {data.settings.groups.length === 0 && <p className="empty-text">グループはまだありません。項目フォームからも追加できます。</p>}
              </div>
            </section>

            <section className="section">
              <h2>データ</h2>
              <div className="data-actions">
                <div className="data-action-block">
                  <button type="button" onClick={exportJson}>JSONエクスポート</button>
                  <p className="small-note">バックアップと端末間のデータ移動に使います</p>
                </div>
                <div className="data-action-block">
                  <button type="button" onClick={() => importInputRef.current?.click()}>JSON追加インポート</button>
                  <p className="small-note">かぞえ帳のバックアップと、旧ゆるたすくのバックアップ（自動変換）に対応。取り込む前に件数を確認できます</p>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) handleImportFile(file);
                      event.target.value = "";
                    }}
                  />
                </div>
                <div className="data-action-block">
                  <button type="button" onClick={exportMarkdown}>Markdownエクスポート</button>
                  <p className="small-note">週次・月次の件数入り。AIに読ませる分析用</p>
                </div>
              </div>
            </section>

            <section className="section">
              <h2>時間の区切り</h2>
              <div className="form-grid-2">
                <label>
                  日付の境界
                  <select
                    value={boundary}
                    onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, dayBoundaryTime: event.target.value } }))}
                  >
                    {DAY_BOUNDARY_OPTIONS.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                  <span className="field-help">この時刻より前の記録は前日ぶんとして数えます</span>
                </label>
                <label>
                  週の開始曜日
                  <select
                    value={data.settings.weekStartDay}
                    onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, weekStartDay: Number(event.target.value) as Weekday } }))}
                  >
                    {WEEKDAY_LABELS.map((label, index) => (
                      <option key={label} value={index}>{label}曜日</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          </>
        )}
      </main>

      <nav className="bottom-nav">
        {tabLabels.map((tab) => (
          <button key={tab.key} type="button" className={activeTab === tab.key ? "active" : ""} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </button>
        ))}
      </nav>

      {/* 項目の新規・編集モーダル（v3.1で常設フォームから移行。閉じても設定リストのスクロール位置が保たれる） */}
      {draft && (
        <div className="dialog-backdrop">
          <div className="dialog item-form-dialog">
            <h3>{editingItemId ? "項目を編集" : "新しい項目"}</h3>
            <label>
              タイトル（必須）
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例：週刊少年ジャンプ、サウナ、記事執筆" />
            </label>
            <div className="form-grid-2">
              <label>
                カテゴリ
                <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
                  {data.settings.categories.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                  <option value={NEW_CATEGORY_VALUE}>＋新しいカテゴリ</option>
                </select>
              </label>
              <label>
                グループ（任意）
                <select value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })}>
                  <option value={NO_GROUP_VALUE}>（なし）</option>
                  {data.settings.groups.map((group) => (
                    <option key={group} value={group}>{group}</option>
                  ))}
                  <option value={NEW_GROUP_VALUE}>＋新しいグループ</option>
                </select>
              </label>
            </div>
            {draft.category === NEW_CATEGORY_VALUE && (
              <label>
                新しいカテゴリ名
                <input value={draft.newCategory} onChange={(event) => setDraft({ ...draft, newCategory: event.target.value })} />
              </label>
            )}
            {draft.group === NEW_GROUP_VALUE && (
              <label>
                新しいグループ名
                <input value={draft.newGroup} onChange={(event) => setDraft({ ...draft, newGroup: event.target.value })} placeholder="例：アニメ、開発垢、家事" />
              </label>
            )}
            <div className="form-grid-2">
              <label>
                在庫にする
                <select
                  value={draft.isStock ? "yes" : "no"}
                  onChange={(event) => setDraft({ ...draft, isStock: event.target.value === "yes" })}
                >
                  <option value="no">在庫にしない</option>
                  <option value="yes">在庫にする</option>
                </select>
                <span className="field-help">オンにすると、やっていない分が在庫としてたまります</span>
              </label>
              {draft.isStock && (
                <label>
                  繰り返し
                  <select value={draft.repeatType} onChange={(event) => setDraft({ ...draft, repeatType: event.target.value as RepeatType })}>
                    <option value="weekly">毎週</option>
                    <option value="monthly">毎月</option>
                    <option value="single">単発在庫（手で積む）</option>
                  </select>
                </label>
              )}
            </div>
            {/* 在庫にしない項目には繰り返し・曜日・起点日を出さない（死んだUIを置かない） */}
            {draft.isStock && (draft.repeatType === "weekly" || draft.repeatType === "monthly") && (
              <div className="form-grid-2">
                {draft.repeatType === "weekly" ? (
                  <label>
                    曜日
                    <select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: event.target.value })}>
                      {WEEKDAY_LABELS.map((label, index) => (
                        <option key={label} value={index}>{label}曜日</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    日にち
                    <input type="number" min={1} max={31} value={draft.monthDay} onChange={(event) => setDraft({ ...draft, monthDay: event.target.value })} />
                  </label>
                )}
                <label>
                  この日から数え始める（任意）
                  <input type="date" value={draft.inventoryStartDate} onChange={(event) => setDraft({ ...draft, inventoryStartDate: event.target.value })} />
                  <span className="field-help">この日以降の対象日だけを在庫として数えます。未入力なら作成日から</span>
                </label>
              </div>
            )}
            <label className="check-label">
              <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
              有効にする
            </label>
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={saveDraft}>保存する</button>
              <button type="button" onClick={() => { setDraft(null); setEditingItemId(null); }}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {enrichTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>記録しました</h3>
            <p>
              {enrichTarget.title}（{enrichTarget.dateLabel}）
            </p>
            <p className="small-note">{enrichTarget.consumedStockEntry ? "よければメモを足せます。空のままで大丈夫" : "よければメモや数量を足せます。どちらも空のままで大丈夫"}</p>
            <label>
              メモ1行（作品名・場所・具体）
              <input value={enrichNote} onChange={(event) => setEnrichNote(event.target.value)} placeholder="例：国宝、〇〇温泉" />
            </label>
            {/* 単発在庫は1件1タイトル前提なので数量は出さない（確定仕様） */}
            {!enrichTarget.consumedStockEntry && (
              <label>
                数量（未入力なら1）
                <input type="number" min={1} inputMode="numeric" value={enrichCount} onChange={(event) => setEnrichCount(event.target.value)} placeholder="例：4" />
              </label>
            )}
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={saveEnrichment}>とじる</button>
              <button type="button" className="subtle-button" onClick={undoEnrichTarget}>記録を取り消す</button>
            </div>
          </div>
        </div>
      )}

      {datePickTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>過去の日付で記録</h3>
            <p>
              {datePickTarget.item.title}
              {datePickTarget.slotDate ? `（${formatDateWithWeekday(datePickTarget.slotDate)}ぶん）` : ""}
              {datePickTarget.stockEntry?.label ? `（${datePickTarget.stockEntry.label}）` : ""}
            </p>
            <label>
              やった日
              <input type="date" value={pickedDate} max={todayLife} onChange={(event) => setPickedDate(event.target.value)} />
            </label>
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={confirmDatePick}>記録する</button>
              <button type="button" onClick={() => setDatePickTarget(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {/* 記録の取り消し（誤タップの救済）。編集機能ではないのでラベルは「取り消す」で統一 */}
      {undoTargetId && (() => {
        const completion = data.completions.find((entry) => entry.id === undoTargetId);
        if (!completion) return null;
        const item = data.items.find((entry) => entry.id === completion.itemId);
        const backNote =
          item && isSingleStockItem(item)
            ? "取り消すと、積みに戻ります。"
            : item && isInventoryItem(item)
              ? "取り消すと、対象日が在庫に戻ります。"
              : "取り消すと、前回の記録が消えます。";
        return (
          <div className="dialog-backdrop">
            <div className="dialog">
              <h3>この記録を取り消しますか？</h3>
              <p>
                {completion.titleSnapshot}（{formatShortDate(doneDateOf(completion, boundary))}）
              </p>
              <p className="small-note">{backNote}記録を整える機能ではなく、押し間違いを戻すためのものです。</p>
              <div className="button-row dialog-actions">
                <button type="button" className="danger-button" onClick={() => undoCompletion(undoTargetId)}>取り消す</button>
                <button type="button" onClick={() => setUndoTargetId(null)}>やめる</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 積んだものの取り下げ（記録を作らずに積みから消す） */}
      {withdrawTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>積みから取り下げますか？</h3>
            <p>「{withdrawTarget.label}」を積みから外します。</p>
            <p className="small-note">「楽しんだ」とは違い、完了ログは作られません。読まずにやめたものを、記録を汚さずに消せます。</p>
            <div className="button-row dialog-actions">
              <button type="button" className="danger-button" onClick={() => withdrawEntry(withdrawTarget.entryId)}>取り下げる</button>
              <button type="button" onClick={() => setWithdrawTarget(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {deleteTargetId && (() => {
        const item = data.items.find((entry) => entry.id === deleteTargetId);
        const stockCount = data.stockEntries.filter((entry) => entry.itemId === deleteTargetId).length;
        const logCount = data.completions.filter((entry) => entry.itemId === deleteTargetId).length;
        return (
          <div className="dialog-backdrop">
            <div className="dialog">
              <h3>「{item?.title ?? "この項目"}」を削除します</h3>
              {stockCount > 0 && <p>積んだもの {stockCount}件 も一緒に消えます。</p>}
              <p>完了ログ {logCount}件 は残ります（集計にも出ます）。</p>
              <div className="button-row dialog-actions">
                <button type="button" className="danger-button" onClick={() => deleteItem(deleteTargetId)}>削除する</button>
                <button type="button" onClick={() => setDeleteTargetId(null)}>やめる</button>
              </div>
            </div>
          </div>
        );
      })()}

      {deleteGroupTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>グループ「{deleteGroupTarget}」を削除しますか？</h3>
            <p>このグループには項目が入っていません。選択肢から取り除くだけで、これまでの記録（完了ログ・集計）には影響しません。</p>
            <div className="button-row dialog-actions">
              <button type="button" className="danger-button" onClick={() => deleteGroup(deleteGroupTarget)}>削除する</button>
              <button type="button" onClick={() => setDeleteGroupTarget(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {importPreview && (
        <div className="dialog-backdrop">
          <div className="dialog append-import-dialog">
            <h3>追加インポートのプレビュー</h3>
            <p>{importPreview.sourceLabel}</p>
            <div className="import-preview-list">
              {importPreview.counts.map((count) => (
                <div key={count.label} className="import-preview-item">
                  <h3>{count.label}</h3>
                  <dl>
                    <div><dt>読み込み</dt><dd>{count.loaded}</dd></div>
                    <div><dt>追加</dt><dd>{count.added}</dd></div>
                    <div><dt>スキップ（重複）</dt><dd>{count.skipped}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
            {importPreview.adoptDayBoundary && (
              <p className="small-note">日付境界 {importPreview.adoptDayBoundary} も引き継ぎます</p>
            )}
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={applyImport}>追加する</button>
              <button type="button" onClick={() => setImportPreview(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
