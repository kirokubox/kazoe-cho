import { WEEKDAY_LABELS } from "./constants.js";
import { addDaysKey, formatDateWithWeekday, formatMonthKey, monthKeyOf, weekStartOf, type Period } from "./dateUtils.js";
import { buildStatCategories, doneDateOf, isDeletedItem, isInventoryItem, isSingleStockItem } from "./itemLogic.js";
import type { AppData, Completion, StatGroup } from "./types.js";

// ----------------------------- エクスポート -----------------------------

export function downloadTextFile(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

// グループ×項目の粒度のMarkdown表。グループの合計行は出さない（buildStatCategoriesと同じ理由）。
// 全件エクスポート（週次・月次）と期間エクスポートの両方から使う共通部品
export function statTable(groups: StatGroup[]): string[] {
  const rows: string[] = ["| グループ | 項目 | 件数 | 数量 |", "| --- | --- | ---: | ---: |"];
  for (const group of groups) {
    for (const row of group.rows) {
      rows.push(`| ${group.group ?? ""} | ${row.title} | ${row.count} | ${row.quantity} |`);
    }
  }
  return rows;
}

export function buildMarkdownExport(data: AppData, todayLife: string) {
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
    const active = isDeletedItem(item) ? "（削除済み）" : item.isActive ? "" : "（停止中）";
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

  // 全件エクスポートの週次・月次表はカテゴリを跨いだ1枚の表（既存挙動を維持。カテゴリ別の内訳は出さない）
  const statTableAcrossCategories = (completions: Completion[]) =>
    statTable(buildStatCategories(completions, data.settings.categories, data.settings.groups).flatMap((category) => category.groups));

  const byWeek = new Map<string, Completion[]>();
  const byMonth = new Map<string, Completion[]>();
  for (const completion of data.completions) {
    const doneDate = doneDateOf(completion);
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
    lines.push(...statTableAcrossCategories(byWeek.get(weekKey)!));
    lines.push("");
  }

  lines.push("## 月次集計");
  lines.push("");
  for (const monthKey of Array.from(byMonth.keys()).sort().reverse()) {
    lines.push(`### ${formatMonthKey(monthKey)}`);
    lines.push("");
    lines.push(...statTableAcrossCategories(byMonth.get(monthKey)!));
    lines.push("");
  }

  lines.push("## 完了ログ");
  lines.push("");
  const sorted = [...data.completions].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  for (const completion of sorted) {
    const doneDate = doneDateOf(completion);
    const note = completion.note ? `（${completion.note}）` : "";
    const count = completion.count !== null ? ` ×${completion.count}` : "";
    lines.push(`- ${doneDate} ${completion.titleSnapshot}${note}${count}｜対象日 ${completion.targetDate}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ----------------------------- AI用Markdown（週・月） -----------------------------

// 表のセル用エスケープ：`|` は列区切りと混ざるので `\|`、改行は `<br>` にする（表が崩れないように）
export function escapeCell(text: string) {
  return text.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

// 記録時刻の表示。時刻部分がちょうど 12:00:00 の記録は「日付指定」（長押しで日付だけ選んだ記録は `${日付}T12:00:00` で保存されるため）
export function recordTimeLabel(completedAt: string) {
  const parsed = new Date(completedAt);
  if (Number.isNaN(parsed.getTime())) return "";
  const hh = parsed.getHours();
  const mm = parsed.getMinutes();
  const ss = parsed.getSeconds();
  if (hh === 12 && mm === 0 && ss === 0) return "日付指定";
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function timeOfDaySortKey(completedAt: string) {
  const parsed = new Date(completedAt);
  if (Number.isNaN(parsed.getTime())) return "";
  return [parsed.getHours(), parsed.getMinutes(), parsed.getSeconds()].map((value) => String(value).padStart(2, "0")).join(":");
}

export function aiMarkdownFileName(period: Period) {
  return period.kind === "week"
    ? `kazoe-cho-week-${period.startKey}_${period.endKey}.md`
    : `kazoe-cho-month-${period.startKey.slice(0, 7)}.md`;
}

// 設定画面から出す「AI用Markdown（週・月）」。件数・数量の集計に加え、完了ログ1件ずつの明細を付ける。
// 集計と同じ期間の絞り込み（行動した日＝doneDateOf）で、期間内の完了ログだけを使う
export function buildAiPeriodMarkdown(args: {
  period: Period;
  completions: Completion[];
  exportedAt: string;
  weekStartDayLabel: string; // 例：月（週の開始曜日の表示用）
  categoriesOrder: string[];
  groupsOrder: string[];
}) {
  const { period, exportedAt } = args;
  const inPeriod = args.completions.filter((completion) => period.contains(doneDateOf(completion)));
  const statCategories = buildStatCategories(inPeriod, args.categoriesOrder, args.groupsOrder);
  const totalCount = statCategories.reduce((sum, category) => sum + category.count, 0);
  const totalQuantity = statCategories.reduce((sum, category) => sum + category.quantity, 0);
  const kindLabel = period.kind === "week" ? `週（${args.weekStartDayLabel}曜始まり）` : "月";
  const rangeLabel = `${period.startKey}〜${period.endKey}`;

  const lines: string[] = [];
  lines.push(`# かぞえ帳 AI用データ（${period.kind === "week" ? "週" : "月"}：${rangeLabel}）`);
  lines.push("");
  lines.push(`- 対象期間：${rangeLabel}（${kindLabel}）`);
  lines.push(`- 書き出し日時：${exportedAt}`);
  lines.push(`- 全体合計：${totalCount}件・数量${totalQuantity}`);
  lines.push("");

  lines.push("## カテゴリ別集計");
  lines.push("");
  if (statCategories.length === 0) {
    lines.push("この期間の記録はありません。");
    lines.push("");
  }
  for (const category of statCategories) {
    lines.push(`### ${category.category}（${category.count}件・数量${category.quantity}）`);
    lines.push("");
    lines.push(...statTable(category.groups));
    lines.push("");
  }

  lines.push(`## 明細（${inPeriod.length}件）`);
  lines.push("");
  lines.push("- 日付：集計と同じ「行動した日」（記録時刻の暦日）。記録時刻は記録ボタンを押した時刻で、実際に行動した時刻ではない（後からまとめて押すことがある）。「日付指定」は長押しで日付だけ選んだ記録で、時刻の情報はない");
  lines.push("- 対象日：保存されている値をそのまま出している。繰り返し在庫（毎週・毎月）ではその回の対象日（何回目・何号ぶんかを日付で表したもの）、単発在庫と前回日型では記録した日（日付指定ならその日）");
  lines.push("- 数量：未入力は空欄（集計では1として数えている）。メモ：本人が書いた分だけで、空欄は未入力");
  lines.push("");
  if (inPeriod.length === 0) {
    lines.push("この期間の記録はありません。");
    lines.push("");
    return lines.join("\n");
  }
  const sorted = inPeriod
    .map((completion, index) => ({ completion, index, date: doneDateOf(completion), time: timeOfDaySortKey(completion.completedAt) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.index - b.index);
  lines.push("| 日付 | 記録時刻 | カテゴリ | グループ | 項目 | 数量 | 対象日 | メモ |");
  lines.push("| --- | --- | --- | --- | --- | ---: | --- | --- |");
  for (const { completion, date } of sorted) {
    const cells = [
      date,
      recordTimeLabel(completion.completedAt),
      escapeCell(completion.categorySnapshot),
      escapeCell(completion.groupSnapshot ?? ""),
      escapeCell(completion.titleSnapshot),
      completion.count === null ? "" : String(completion.count),
      escapeCell(completion.targetDate),
      escapeCell(completion.note),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}
