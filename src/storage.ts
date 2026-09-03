import { ACTIVE_VIEW_KEY, BACKUP_NOTICE_KEY, CATEGORY_MIGRATION_MAP, DAY_BOUNDARY_OPTIONS, DEFAULT_CATEGORIES, DEFAULT_DATA, DEFAULT_SETTINGS, FOLD_STATE_KEY, KINDS, STORAGE_KEY } from "./constants";
import { dateKeyFromDate } from "./dateUtils";
import type { AppData, Completion, FoldState, Item, Kind, RepeatType, Settings, StockEntry, Tab, Weekday } from "./types";

// ----------------------------- データ検証・保存 -----------------------------

export function isKind(value: unknown): value is Kind {
  return typeof value === "string" && (KINDS as string[]).includes(value);
}

export function isWeekdayValue(value: unknown): value is Weekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

export function isRepeatType(value: unknown): value is RepeatType {
  return value === "weekly" || value === "monthly" || value === "none" || value === "single";
}

// v1/v2（kindあり）・v3（isStockあり）のどちらの形状でも受け取り、v3のItemへ正規化する。
// remapCategory はv2以前のデータにだけ適用する（v3でユーザーが同名カテゴリを作り直しても書き換えないため）。
// 不変条件：isStock=false ⇔ repeatType="none"。冪等（v3のItemを通しても変わらない）
export function migrateItem(value: unknown, remapCategory: boolean): Item | null {
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
export function migrateCompletion(value: unknown): Completion | null {
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

export function isStockEntry(value: unknown): value is StockEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.itemId === "string" &&
    typeof entry.label === "string" &&
    typeof entry.addedAt === "string"
  );
}

export function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : null;
}

export function normalizeSettings(raw: unknown, legacy: boolean): Settings {
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
export function normalizeAppData(raw: unknown): AppData | null {
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

export function loadData(): AppData {
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

export function loadActiveView(): Tab {
  const stored = localStorage.getItem(ACTIVE_VIEW_KEY);
  return stored === "home" || stored === "last" || stored === "stats" || stored === "settings" ? stored : "home";
}

// キー無し（初回起動）＝開いているものが0件＝すべて閉じた状態、が自然に成り立つ（開集合方式の理由）。
// 削除・改名されたカテゴリ・グループ名が残っていても実害はない（描画側で存在しない名前は使われないだけ）ので掃除しない
export function loadFoldState(): { openCategories: Set<string>; openGroups: Set<string> } {
  try {
    const raw = localStorage.getItem(FOLD_STATE_KEY);
    if (!raw) return { openCategories: new Set(), openGroups: new Set() };
    const parsed = JSON.parse(raw) as Partial<FoldState> | null;
    return {
      openCategories: new Set(stringList(parsed?.openCategories) ?? []),
      openGroups: new Set(stringList(parsed?.openGroups) ?? []),
    };
  } catch {
    return { openCategories: new Set(), openGroups: new Set() };
  }
}
