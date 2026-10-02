import { CATEGORY_MIGRATION_MAP, DAY_BOUNDARY_OPTIONS } from "./constants";
import { nowLocalStamp } from "./dateUtils";
import { isKind, isWeekdayValue } from "./storage";
import type { Completion, Item, Kind, RepeatType } from "./types";

// ----------------------------- 旧ゆるたすくからの変換 -----------------------------

// 旧 task-manager-backup 形式の recurringTasks / recurringCompletions を新形式へ変換する。
// tasks・routineItems・activityGroups・分数系（durationMinutes 等）は意図的に移行しない。
export function convertOldKind(kind: string): Kind {
  if (kind === "確認") return "習慣";
  return isKind(kind) ? kind : "習慣";
}

export function convertOldBackup(raw: Record<string, unknown>): { items: Item[]; completions: Completion[]; dayBoundaryTime: string | null } | null {
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
    const isActive = task.isActive !== false;
    const updatedAt = typeof task.updatedAt === "string" ? task.updatedAt : nowLocalStamp();
    items.push({
      id: task.id,
      title: task.title,
      category: CATEGORY_MIGRATION_MAP[oldCategory] ?? oldCategory,
      group: null,
      isStock,
      repeatType,
      weekday: repeatType === "weekly" && isWeekdayValue(task.weekday) ? task.weekday : null,
      monthDay: repeatType === "monthly" && typeof task.monthDay === "number" ? task.monthDay : null,
      isActive,
      stoppedAt: isActive ? null : updatedAt,
      deletedAt: null,
      inventoryStartDate: isStock && typeof task.inventoryStartDate === "string" ? task.inventoryStartDate : undefined,
      memo: typeof task.memo === "string" ? task.memo : "",
      createdAt: typeof task.createdAt === "string" ? task.createdAt : nowLocalStamp(),
      updatedAt,
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
