import { WEEKDAY_LABELS } from "./constants";
import { addDaysKey, formatDateWithWeekday, formatMonthKey, monthKeyOf, weekStartOf } from "./dateUtils";
import { buildStatCategories, doneDateOf, isInventoryItem, isSingleStockItem } from "./itemLogic";
import type { AppData, Completion, StatCategory, StatGroup } from "./types";

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

// 集計タブの「表示中の期間だけ」エクスポート（v3.4）。全件エクスポートと違い、カテゴリごとに
// 小計を出し、末尾に全体合計を出す。カテゴリ・グループの粒度は画面の集計とそろえる
export function buildPeriodStatsMarkdown(periodLabel: string, statCategories: StatCategory[], totalCount: number, totalQuantity: number) {
  const lines: string[] = [];
  lines.push(`# かぞえ帳集計（${periodLabel}）`);
  lines.push("");
  for (const category of statCategories) {
    lines.push(`## ${category.category}（${category.count}件・数量${category.quantity}）`);
    lines.push("");
    lines.push(...statTable(category.groups));
    lines.push("");
  }
  lines.push(`## 全体合計`);
  lines.push("");
  lines.push(`${totalCount}件・数量${totalQuantity}`);
  lines.push("");
  return lines.join("\n");
}
