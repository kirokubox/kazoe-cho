import { useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// かぞえ帳：「いつから？いくつ？」に一瞬で答える行動台帳
// - Googleカレンダー＝原本（時刻つきの事実）、Keep＝詳細、本アプリ＝索引
// - 入れていいのは「やりたいこと」だけ。締切・義務・時間分数は持たない
// ---------------------------------------------------------------------------

type Kind = "楽しみ" | "習慣" | "振り返り" | "作業";
// single＝単発在庫（楽しみ専用）。自動生成せず、在庫タブで手で積む
type RepeatType = "weekly" | "monthly" | "none" | "single";
type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type Item = {
  id: string;
  title: string;
  category: string;
  kind: Kind;
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
  kindSnapshot: Kind;
  note: string;
  count: number | null;
};

type Settings = {
  dayBoundaryTime: string;
  weekStartDay: Weekday;
  categories: string[];
};

type AppData = {
  version: 1;
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
  kind: Kind;
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

type StatRow = {
  title: string;
  count: number;
  quantity: number;
};

type StatCategory = {
  category: string;
  rows: StatRow[];
  count: number;
  quantity: number;
};

const STORAGE_KEY = "yuki-kazoe-cho-data";
const ACTIVE_VIEW_KEY = "yuki-kazoe-cho-active-view";

const KINDS: Kind[] = ["楽しみ", "習慣", "振り返り", "作業"];
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];
const DAY_BOUNDARY_OPTIONS = ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"];
const DEFAULT_CATEGORIES = ["楽しみ", "生活", "仕事", "お金", "人・連絡", "趣味", "開発", "SNS", "発信", "振り返り", "その他"];
const NEW_CATEGORY_VALUE = "__new__";
// 在庫の遡り上限（日）。壊れたデータでの無限ループ防止の安全弁で、通常運用では届かない
const MAX_INVENTORY_LOOKBACK_DAYS = 1600;
const LONG_PRESS_MS = 550;

const DEFAULT_SETTINGS: Settings = {
  dayBoundaryTime: "05:00",
  weekStartDay: 1,
  categories: DEFAULT_CATEGORIES,
};

const DEFAULT_DATA: AppData = {
  version: 1,
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

function isItem(value: unknown): value is Item {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.category === "string" &&
    isKind(item.kind) &&
    (item.repeatType === "weekly" || item.repeatType === "monthly" || item.repeatType === "none" || item.repeatType === "single") &&
    (item.weekday === null || isWeekdayValue(item.weekday)) &&
    (item.monthDay === null || typeof item.monthDay === "number") &&
    typeof item.isActive === "boolean" &&
    (item.inventoryStartDate === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(item.inventoryStartDate))) &&
    typeof item.memo === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

function isCompletion(value: unknown): value is Completion {
  if (typeof value !== "object" || value === null) return false;
  const completion = value as Record<string, unknown>;
  return (
    typeof completion.id === "string" &&
    typeof completion.itemId === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(completion.targetDate)) &&
    typeof completion.completedAt === "string" &&
    typeof completion.titleSnapshot === "string" &&
    typeof completion.categorySnapshot === "string" &&
    isKind(completion.kindSnapshot) &&
    typeof completion.note === "string" &&
    (completion.count === null || typeof completion.count === "number")
  );
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

function normalizeSettings(raw: unknown): Settings {
  const settings = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const dayBoundaryTime = DAY_BOUNDARY_OPTIONS.includes(String(settings.dayBoundaryTime))
    ? String(settings.dayBoundaryTime)
    : DEFAULT_SETTINGS.dayBoundaryTime;
  const weekStartDay = isWeekdayValue(settings.weekStartDay) ? settings.weekStartDay : DEFAULT_SETTINGS.weekStartDay;
  const categories = Array.isArray(settings.categories) && settings.categories.every((c) => typeof c === "string") && settings.categories.length > 0
    ? (settings.categories as string[])
    : DEFAULT_SETTINGS.categories;
  return { dayBoundaryTime, weekStartDay, categories };
}

function normalizeAppData(raw: unknown): AppData | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.items) || !data.items.every(isItem)) return null;
  if (!Array.isArray(data.completions) || !data.completions.every(isCompletion)) return null;
  // stockEntries はv2追加。無い/不正なら空として扱い、v1データをそのまま通す
  const stockEntries = Array.isArray(data.stockEntries) && data.stockEntries.every(isStockEntry) ? data.stockEntries : [];
  return {
    version: 1,
    items: data.items,
    completions: data.completions,
    stockEntries,
    settings: normalizeSettings(data.settings),
  };
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DATA;
    const parsed = normalizeAppData(JSON.parse(raw));
    return parsed ?? DEFAULT_DATA;
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
    items.push({
      id: task.id,
      title: task.title,
      category: typeof task.category === "string" ? task.category : "その他",
      kind: convertOldKind(String(task.kind)),
      repeatType: task.repeatType === "monthly" ? "monthly" : "weekly",
      weekday: isWeekdayValue(task.weekday) ? task.weekday : null,
      monthDay: typeof task.monthDay === "number" ? task.monthDay : null,
      isActive: task.isActive !== false,
      inventoryStartDate: typeof task.inventoryStartDate === "string" ? task.inventoryStartDate : undefined,
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

// 在庫型：楽しみ × 繰り返しあり or 単発在庫。それ以外（習慣・振り返り・作業・随時もの）は前回日型
function isInventoryItem(item: Item) {
  return item.kind === "楽しみ" && item.repeatType !== "none";
}

// 単発在庫：楽しみ専用。対象日を自動生成せず、手で積む
function isSingleStockItem(item: Item) {
  return item.kind === "楽しみ" && item.repeatType === "single";
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

function latestCompletionOf(completions: Completion[], itemId: string) {
  let latest: Completion | null = null;
  for (const completion of completions) {
    if (completion.itemId !== itemId) continue;
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

function buildStatCategories(completions: Completion[], categoriesOrder: string[]): StatCategory[] {
  const byCategory = new Map<string, Map<string, StatRow>>();
  for (const completion of completions) {
    const category = completion.categorySnapshot || "その他";
    const rows = byCategory.get(category) ?? new Map<string, StatRow>();
    const row = rows.get(completion.titleSnapshot) ?? { title: completion.titleSnapshot, count: 0, quantity: 0 };
    row.count += 1;
    row.quantity += quantityOf(completion);
    rows.set(completion.titleSnapshot, row);
    byCategory.set(category, rows);
  }
  const orderIndex = (category: string) => {
    const index = categoriesOrder.indexOf(category);
    return index === -1 ? categoriesOrder.length : index;
  };
  return Array.from(byCategory.entries())
    .map(([category, rows]) => {
      const rowList = Array.from(rows.values()).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "ja"));
      return {
        category,
        rows: rowList,
        count: rowList.reduce((sum, row) => sum + row.count, 0),
        quantity: rowList.reduce((sum, row) => sum + row.quantity, 0),
      };
    })
    .sort((a, b) => orderIndex(a.category) - orderIndex(b.category) || a.category.localeCompare(b.category, "ja"));
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
    lines.push(`- [${shape}] ${item.title}（${item.kind}／${item.category}／${repeat}）${active}`);
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
    const rows: string[] = ["| 項目 | 件数 | 数量 |", "| --- | ---: | ---: |"];
    for (const category of buildStatCategories(completions, data.settings.categories)) {
      for (const row of category.rows) {
        rows.push(`| ${row.title} | ${row.count} | ${row.quantity} |`);
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

  // 設定タブ：項目フォーム
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

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

  const inventoryItems = useMemo(
    () =>
      data.items
        .filter((item) => item.isActive && isInventoryItem(item) && !isSingleStockItem(item))
        .map((item) => ({ item, dates: inventoryDates(item, completedKeys, todayLife) }))
        .sort((a, b) => a.item.title.localeCompare(b.item.title, "ja")),
    [data.items, completedKeys, todayLife],
  );

  // 単発在庫の箱。積んだものは追加順（addedAt順）で表示する
  const singleStockItems = useMemo(
    () =>
      data.items
        .filter((item) => item.isActive && isSingleStockItem(item))
        .map((item) => ({
          item,
          entries: data.stockEntries
            .filter((entry) => entry.itemId === item.id)
            .sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
        }))
        .sort((a, b) => a.item.title.localeCompare(b.item.title, "ja")),
    [data.items, data.stockEntries],
  );

  const inventoryTotal =
    inventoryItems.reduce((sum, entry) => sum + entry.dates.length, 0) +
    singleStockItems.reduce((sum, entry) => sum + entry.entries.length, 0);

  const lastItems = useMemo(
    () =>
      data.items
        .filter((item) => item.isActive && !isInventoryItem(item))
        .map((item) => ({ item, latest: latestCompletionOf(data.completions, item.id) })),
    [data.items, data.completions],
  );

  const lastGroups = useMemo(() => {
    const groups = new Map<string, typeof lastItems>();
    for (const entry of lastItems) {
      const list = groups.get(entry.item.category) ?? [];
      list.push(entry);
      groups.set(entry.item.category, list);
    }
    const orderIndex = (category: string) => {
      const index = data.settings.categories.indexOf(category);
      return index === -1 ? data.settings.categories.length : index;
    };
    return Array.from(groups.entries())
      .map(([category, entries]) => ({
        category,
        entries: entries.sort((a, b) => a.item.title.localeCompare(b.item.title, "ja")),
      }))
      .sort((a, b) => orderIndex(a.category) - orderIndex(b.category) || a.category.localeCompare(b.category, "ja"));
  }, [lastItems, data.settings.categories]);

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
      kindSnapshot: item.kind,
      note: "",
      count: null,
    };
    setData((current) => ({ ...current, completions: [completion, ...current.completions] }));
    const dateLabel = isInventoryItem(item) ? `${formatDateWithWeekday(targetDate)}ぶん` : formatDateWithWeekday(doneDate ?? targetDate);
    setEnrichTarget({ completionId: completion.id, title: item.title, dateLabel });
    setEnrichNote("");
    setEnrichCount("");
    setMessage(null);
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
      kindSnapshot: item.kind,
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
      kind: "楽しみ",
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
      kind: item.kind,
      repeatType: item.repeatType,
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
    // 単発在庫は楽しみ専用。万一それ以外の種類のまま残っていたら随時に落とす
    const repeatType: RepeatType = draft.repeatType === "single" && draft.kind !== "楽しみ" ? "none" : draft.repeatType;
    const weekday = repeatType === "weekly" ? (Number(draft.weekday) as Weekday) : null;
    const monthDayNumber = Number(draft.monthDay);
    const monthDay = repeatType === "monthly" ? Math.min(Math.max(Math.round(monthDayNumber) || 1, 1), 31) : null;
    const inventoryStartDate = /^\d{4}-\d{2}-\d{2}$/.test(draft.inventoryStartDate) ? draft.inventoryStartDate : undefined;
    const stamp = nowLocalStamp();

    setData((current) => {
      const categories = current.settings.categories.includes(category)
        ? current.settings.categories
        : [...current.settings.categories, category];
      if (editingItemId) {
        return {
          ...current,
          settings: { ...current.settings, categories },
          items: current.items.map((item) =>
            item.id === editingItemId
              ? { ...item, title, category, kind: draft.kind, repeatType, weekday, monthDay, inventoryStartDate, memo: draft.memo.trim(), isActive: draft.isActive, updatedAt: stamp }
              : item,
          ),
        };
      }
      const item: Item = {
        id: genId(),
        title,
        category,
        kind: draft.kind,
        repeatType,
        weekday,
        monthDay,
        isActive: draft.isActive,
        inventoryStartDate,
        memo: draft.memo.trim(),
        createdAt: stamp,
        updatedAt: stamp,
      };
      return { ...current, settings: { ...current.settings, categories }, items: [...current.items, item] };
    });
    setDraft(null);
    setEditingItemId(null);
    setMessage({ type: "success", text: editingItemId ? "項目を更新しました" : "項目を追加しました" });
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
        let adoptDayBoundary: string | null = null;
        let sourceLabel = "";

        const asNew = normalizeAppData(raw);
        if (asNew) {
          incomingItems = asNew.items;
          incomingCompletions = asNew.completions;
          incomingStockEntries = asNew.stockEntries;
          sourceLabel = "かぞえ帳バックアップ";
        } else {
          const asOld = convertOldBackup(raw);
          if (!asOld) {
            setMessage({ type: "error", text: "対応していない形式のファイルです" });
            return;
          }
          incomingItems = asOld.items;
          incomingCompletions = asOld.completions;
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
      for (const item of importPreview.incomingItems) {
        if (!categories.includes(item.category)) categories.push(item.category);
      }
      return {
        ...current,
        items: [...current.items, ...importPreview.incomingItems],
        completions: [...importPreview.incomingCompletions, ...current.completions],
        stockEntries: [...current.stockEntries, ...importPreview.incomingStockEntries],
        settings: {
          ...current.settings,
          categories,
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
    () => buildStatCategories(statsCompletions, data.settings.categories),
    [statsCompletions, data.settings.categories],
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

      <main className="view-stack">
        {activeTab === "home" && (
          <>
            <section className="section inventory-lead">
              <h2>楽しみの在庫</h2>
              <p className="small-note">
                {inventoryTotal > 0 ? `いま ${inventoryTotal} 回ぶん たまっています。どれ楽しむ？` : "在庫はぜんぶ楽しみ済み。次が積まれるのを待つだけ"}
              </p>
            </section>
            {inventoryItems.length === 0 && singleStockItems.length === 0 && (
              <section className="section">
                <p className="empty-text">在庫型の項目がまだありません。設定タブで「楽しみ × 毎週/毎月」の項目や「単発在庫（手で積む）」の箱をつくると、ここに在庫が積まれていきます。</p>
              </section>
            )}
            {inventoryItems.map(({ item, dates }) => (
              <section key={item.id} className="section inventory-card">
                <div className="inventory-card-head">
                  <h3>{item.title}</h3>
                  <span className="count-chip">{dates.length > 0 ? `${dates.length}回ぶん` : "在庫なし"}</span>
                </div>
                {item.memo && <p className="item-memo">{item.memo}</p>}
                {dates.length === 0 && <p className="small-note">たまっている在庫はありません 🎉</p>}
                <div className="inventory-date-list">
                  {dates.map((date) => (
                    <div key={date} className="inventory-date-row">
                      <span>{formatDateWithWeekday(date)}ぶん</span>
                      <RecordButton
                        label="楽しんだ"
                        className="enjoy-button"
                        onTap={() => recordCompletion(item, date, null)}
                        onLongPress={() => openDatePick(item, date)}
                      />
                    </div>
                  ))}
                </div>
              </section>
            ))}
            {/* 単発在庫の箱は繰り返し在庫の下に並べる（確定仕様） */}
            {singleStockItems.map(({ item, entries }) => (
              <section key={item.id} className="section inventory-card">
                <div className="inventory-card-head">
                  <h3>{item.title}</h3>
                  <span className="count-chip">{entries.length > 0 ? `${entries.length}件` : "在庫なし"}</span>
                </div>
                {item.memo && <p className="item-memo">{item.memo}</p>}
                {entries.length === 0 && <p className="small-note">積まれているものはありません。下の欄から積めます</p>}
                <div className="inventory-date-list">
                  {entries.map((entry) => (
                    <div key={entry.id} className="inventory-date-row">
                      <span>{entry.label || "（名前なし）"}</span>
                      <RecordButton
                        label="楽しんだ"
                        className="enjoy-button"
                        onTap={() => consumeStockEntry(item, entry, null)}
                        onLongPress={() => openDatePick(item, null, entry)}
                      />
                    </div>
                  ))}
                </div>
                <div className="stock-add-row">
                  <input
                    value={stockDrafts[item.id] ?? ""}
                    onChange={(event) => setStockDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                    placeholder="例：国宝（積むものの名前）"
                  />
                  <button type="button" className="primary-button" onClick={() => addStockEntry(item)}>積む</button>
                </div>
              </section>
            ))}
          </>
        )}

        {activeTab === "last" && (
          <>
            <section className="section">
              <h2>前回いつ？</h2>
              <p className="small-note">事実だけを並べる棚。目標も達成率もありません。「やった」長押しで過去の日付でも記録できます</p>
            </section>
            {lastGroups.length === 0 && (
              <section className="section">
                <p className="empty-text">前回日型の項目がまだありません。設定タブで習慣・振り返り・作業・随時の楽しみをつくると、ここに並びます。</p>
              </section>
            )}
            {lastGroups.map((group) => (
              <section key={group.category} className="section">
                <h3 className="group-title">{group.category}</h3>
                <div className="last-list">
                  {group.entries.map(({ item, latest }) => {
                    const latestDoneDate = latest ? doneDateOf(latest, boundary) : null;
                    return (
                      <div key={item.id} className="last-row">
                        <div className="last-info">
                          <span className="last-title">{item.title}</span>
                          <span className="last-meta">
                            {latest && latestDoneDate
                              ? `前回：${formatShortDate(latestDoneDate)}${latest.note ? `（${latest.note}）` : ""}・${diffDays(latestDoneDate, todayLife) === 0 ? "今日" : `${diffDays(latestDoneDate, todayLife)}日前`}`
                              : "記録はこれから"}
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
                    {category.rows.map((row) => (
                      <tr key={row.title}>
                        <td>{row.title}</td>
                        <td className="num">{row.count}</td>
                        <td className="num">{row.quantity}</td>
                      </tr>
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
              <p className="small-note">種類が「楽しみ × 毎週/毎月/単発在庫」なら在庫タブに、それ以外は前回タブに並びます</p>
              {!draft && (
                <button type="button" className="primary-button add-item-button" onClick={() => { setDraft(emptyDraft()); setEditingItemId(null); }}>
                  ＋ 項目をつくる
                </button>
              )}
              {draft && (
                <div className="item-form">
                  <h3>{editingItemId ? "項目を編集" : "新しい項目"}</h3>
                  <label>
                    タイトル（必須）
                    <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例：週刊少年ジャンプ、サウナ、note記事/開発垢" />
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
                      種類
                      <select
                        value={draft.kind}
                        onChange={(event) => {
                          const kind = event.target.value as Kind;
                          // 単発在庫は楽しみ専用なので、種類を変えたら繰り返しを戻す
                          setDraft({ ...draft, kind, repeatType: kind !== "楽しみ" && draft.repeatType === "single" ? "weekly" : draft.repeatType });
                        }}
                      >
                        {KINDS.map((kind) => (
                          <option key={kind} value={kind}>{kind}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {draft.category === NEW_CATEGORY_VALUE && (
                    <label>
                      新しいカテゴリ名
                      <input value={draft.newCategory} onChange={(event) => setDraft({ ...draft, newCategory: event.target.value })} />
                    </label>
                  )}
                  <div className="form-grid-2">
                    <label>
                      繰り返し
                      <select value={draft.repeatType} onChange={(event) => setDraft({ ...draft, repeatType: event.target.value as RepeatType })}>
                        <option value="weekly">毎週</option>
                        <option value="monthly">毎月</option>
                        <option value="none">随時（ルールなし）</option>
                        {draft.kind === "楽しみ" && <option value="single">単発在庫（手で積む）</option>}
                      </select>
                    </label>
                    {draft.repeatType === "weekly" && (
                      <label>
                        曜日
                        <select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: event.target.value })}>
                          {WEEKDAY_LABELS.map((label, index) => (
                            <option key={label} value={index}>{label}曜日</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {draft.repeatType === "monthly" && (
                      <label>
                        日にち
                        <input type="number" min={1} max={31} value={draft.monthDay} onChange={(event) => setDraft({ ...draft, monthDay: event.target.value })} />
                      </label>
                    )}
                  </div>
                  {draft.kind === "楽しみ" && (draft.repeatType === "weekly" || draft.repeatType === "monthly") && (
                    <label>
                      在庫の起点日（任意）
                      <input type="date" value={draft.inventoryStartDate} onChange={(event) => setDraft({ ...draft, inventoryStartDate: event.target.value })} />
                      <span className="field-help">この日以降の対象日だけを在庫として数えます。未入力なら作成日から</span>
                    </label>
                  )}
                  <label>
                    メモ（任意・1行）
                    <input value={draft.memo} onChange={(event) => setDraft({ ...draft, memo: event.target.value })} />
                  </label>
                  <label className="check-label">
                    <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
                    有効にする
                  </label>
                  <div className="button-row">
                    <button type="button" className="primary-button" onClick={saveDraft}>保存する</button>
                    <button type="button" onClick={() => { setDraft(null); setEditingItemId(null); }}>やめる</button>
                  </div>
                </div>
              )}
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
                          {isSingleStockItem(item) ? "単発在庫" : isInventoryItem(item) ? "在庫型" : "前回日型"}・{item.kind}・{item.category}・{repeatLabel}
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

      {deleteTargetId && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>項目を削除しますか？</h3>
            <p>これまでの記録（完了ログ・集計）はタイトルの控えで残ります。在庫・前回の表示からは消え、単発在庫に積んだまま消化していないものも一緒に消えます。</p>
            <div className="button-row dialog-actions">
              <button type="button" className="danger-button" onClick={() => deleteItem(deleteTargetId)}>削除する</button>
              <button type="button" onClick={() => setDeleteTargetId(null)}>やめる</button>
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
