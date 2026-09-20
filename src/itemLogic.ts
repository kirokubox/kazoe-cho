import { MAX_INVENTORY_LOOKBACK_DAYS } from "./constants.js";
import { addDaysKey, dateFromKey, dateKeyFromDate, daysInMonth } from "./dateUtils.js";
import type { Completion, Item, StatCategory, StatGroup, StatRow } from "./types.js";

// ----------------------------- 表示ロジック -----------------------------

// 在庫型かどうかは「在庫にする」スイッチだけで決まる（v3でkindを廃止）
export function isInventoryItem(item: Item) {
  return item.isStock;
}

// 単発在庫：対象日を自動生成せず、手で積む
export function isSingleStockItem(item: Item) {
  return item.isStock && item.repeatType === "single";
}

// 繰り返し在庫（毎週・毎月）。対象日が固有名（7/6号）と単位（1対象日＝1回）を兼ねるため、
// 記録直後のダイアログ（メモ・数量）を出さずワンタップで確定する（v3.2）
export function isRepeatStockItem(item: Item) {
  return item.isStock && (item.repeatType === "weekly" || item.repeatType === "monthly");
}

export function matchesRepeatRule(item: Item, date: Date) {
  if (item.repeatType === "weekly") return item.weekday !== null && date.getDay() === item.weekday;
  if (item.repeatType === "monthly") {
    if (item.monthDay === null) return false;
    const day = Math.min(item.monthDay, daysInMonth(date.getFullYear(), date.getMonth()));
    return date.getDate() === day;
  }
  return false;
}

// 在庫の対象日：起点日から今日（暦日）まで全部を数え、完了済みを除く。
// 「何号から溜まっているか」を一望するのが価値なので、直近N件への省略はしない。
export function inventoryDates(item: Item, completedKeys: Set<string>, todayLife: string) {
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
export function recentCompletionsOf(completions: Completion[], itemId: string, limit: number) {
  return completions
    .filter((completion) => completion.itemId === itemId)
    .sort((a, b) => b.targetDate.localeCompare(a.targetDate) || b.completedAt.localeCompare(a.completedAt))
    .slice(0, limit);
}

// 在庫タブのグループカードに出す「前回」1行用：グループ配下の全項目の完了ログから最新1件
export function latestCompletionAmong(completions: Completion[], itemIds: Set<string>) {
  let latest: Completion | null = null;
  for (const completion of completions) {
    if (!itemIds.has(completion.itemId)) continue;
    if (!latest || completion.targetDate > latest.targetDate || (completion.targetDate === latest.targetDate && completion.completedAt > latest.completedAt)) {
      latest = completion;
    }
  }
  return latest;
}

// 集計に使う「行動した日」：記録時刻の暦日（2026-09-20に日付境界の丸めを廃止し、0時〜24時で区切る暦日へ統一）
export function doneDateOf(completion: Completion) {
  const parsed = new Date(completion.completedAt);
  if (Number.isNaN(parsed.getTime())) return completion.targetDate;
  return dateKeyFromDate(parsed);
}

export function quantityOf(completion: Completion) {
  // count 未入力は 1 として扱う（回数＝数量のケースが大半のため）
  return completion.count ?? 1;
}

// カテゴリ＞グループ＞項目の粒度で集計する。行キーは（グループ, タイトル）：
// 開発垢の「記事執筆」と記録垢の「記事執筆」は別の行として数える。
// グループの合計行は作らない（壁打ち12回と記事執筆3回を足した数に意味がなく、合計を出した瞬間に採点が始まるため）
export function buildStatCategories(completions: Completion[], categoriesOrder: string[], groupsOrder: string[]): StatCategory[] {
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
