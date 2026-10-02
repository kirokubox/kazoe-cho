import assert from "node:assert/strict";
import test from "node:test";
import { migrateItem, normalizeAppData } from "../src/storage.js";

// 停止・削除の追加フィールド（stoppedAt / deletedAt）の互換。旧データ（v1〜v3）は null 扱いで通り、冪等であること

const baseItem = {
  id: "i1",
  title: "項目",
  category: "楽しみ",
  isStock: true,
  repeatType: "weekly",
  weekday: 1,
  isActive: true,
  memo: "",
  createdAt: "2026-09-01T10:00:00",
  updatedAt: "2026-09-10T10:00:00",
};

test("旧データ（stoppedAt/deletedAtなし・有効）は両方 null", () => {
  const item = migrateItem(baseItem, false)!;
  assert.equal(item.stoppedAt, null);
  assert.equal(item.deletedAt, null);
});

test("旧データの停止中は updatedAt を停止日として補完する", () => {
  assert.equal(migrateItem({ ...baseItem, isActive: false }, false)!.stoppedAt, "2026-09-10T10:00:00");
});

test("migrateItem は冪等（通しても変わらず、のちに updatedAt が動いても停止日は動かない）", () => {
  const once = migrateItem({ ...baseItem, isActive: false }, false)!;
  const twice = migrateItem({ ...once, updatedAt: "2026-10-01T00:00:00" }, false)!;
  assert.equal(twice.stoppedAt, "2026-09-10T10:00:00");
  assert.deepEqual(migrateItem(once, false), once);
});

test("有効な項目に残った stoppedAt は null に直す。deletedAt は保持する", () => {
  assert.equal(migrateItem({ ...baseItem, stoppedAt: "2026-09-12T00:00:00" }, false)!.stoppedAt, null);
  assert.equal(migrateItem({ ...baseItem, deletedAt: "2026-09-20T08:00:00" }, false)!.deletedAt, "2026-09-20T08:00:00");
});

test("v1形式（kindあり・stoppedAtなし）のJSONも通り、削除済み項目のカテゴリは選択肢へ戻さない", () => {
  const legacyItem = { ...baseItem, kind: "楽しみ", isStock: undefined };
  const deleted = { ...baseItem, id: "i2", category: "削除済みカテゴリ", deletedAt: "2026-09-20T08:00:00" };
  const data = normalizeAppData({ version: 1, items: [legacyItem, deleted], completions: [] })!;
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].deletedAt, null);
  assert.equal(data.settings.categories.includes("削除済みカテゴリ"), false);
});
