import assert from "node:assert/strict";
import test from "node:test";
import { doneDateOf, inventoryDates, isLiveItem, itemStatusLabel } from "../src/itemLogic.js";
import type { Completion, Item } from "../src/types.js";

// 2026-09-20：doneDateOfは日付境界（生活日付）で丸めるのをやめ、completedAtの暦日をそのまま返す。
// 深夜0時台にタップした記録も、以前のように前日へは繰り上がらない（本人判断・実装計画§3-3）。

function completion(completedAt: string, patch: Partial<Completion> = {}): Completion {
  return {
    id: "c1",
    itemId: "i1",
    targetDate: "2026-09-20",
    completedAt,
    titleSnapshot: "タイトル",
    categorySnapshot: "その他",
    groupSnapshot: null,
    note: "",
    count: null,
    ...patch,
  };
}

test("深夜0時台の記録も暦日どおり（前日へ丸めない）", () =>
  assert.equal(doneDateOf(completion("2026-09-21T00:30:00")), "2026-09-21"));

test("深夜4時台の記録も暦日どおり", () =>
  assert.equal(doneDateOf(completion("2026-09-21T04:59:00")), "2026-09-21"));

test("日中の記録は従来どおりその日", () =>
  assert.equal(doneDateOf(completion("2026-09-21T20:00:00")), "2026-09-21"));

test("過去日記録（正午固定）はそのまま選んだ日", () =>
  assert.equal(doneDateOf(completion("2026-09-19T12:00:00")), "2026-09-19"));

test("completedAtが壊れている場合はtargetDateへ後退する", () =>
  assert.equal(doneDateOf(completion("invalid", { targetDate: "2026-09-01" })), "2026-09-01"));

// ----------------------------- 停止・削除後の残件（2026-10-03） -----------------------------
// 停止・削除は「新しい対象を増やさない」だけで、すでにある残件は完了まで在庫に出す。

function weeklyItem(patch: Partial<Item> = {}): Item {
  return {
    id: "w1",
    title: "毎週月曜の番組",
    category: "楽しみ",
    group: null,
    isStock: true,
    repeatType: "weekly",
    weekday: 1, // 月曜
    monthDay: null,
    isActive: true,
    stoppedAt: null,
    deletedAt: null,
    inventoryStartDate: "2026-09-07",
    memo: "",
    createdAt: "2026-09-01T10:00:00",
    updatedAt: "2026-09-01T10:00:00",
    ...patch,
  };
}

const TODAY = "2026-10-05"; // 月曜。有効なら 9/7, 9/14, 9/21, 9/28, 10/5 が残件

test("有効な繰り返し在庫は今日までの対象日が出る（従来どおり）", () =>
  assert.deepEqual(inventoryDates(weeklyItem(), new Set(), TODAY), ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]));

test("停止日で対象日の生成が打ち切られる（停止日を含む）", () =>
  assert.deepEqual(
    inventoryDates(weeklyItem({ isActive: false, stoppedAt: "2026-09-21T09:00:00" }), new Set(), TODAY),
    ["2026-09-07", "2026-09-14", "2026-09-21"],
  ));

test("削除日で対象日の生成が打ち切られる", () =>
  assert.deepEqual(
    inventoryDates(weeklyItem({ deletedAt: "2026-09-15T09:00:00" }), new Set(), TODAY),
    ["2026-09-07", "2026-09-14"],
  ));

test("停止中で stoppedAt が無い既存データは updatedAt を停止日とみなす", () =>
  assert.deepEqual(
    inventoryDates(weeklyItem({ isActive: false, stoppedAt: null, updatedAt: "2026-09-14T20:00:00" }), new Set(), TODAY),
    ["2026-09-07", "2026-09-14"],
  ));

test("停止日が今日より未来でも今日を超えない", () =>
  assert.deepEqual(
    inventoryDates(weeklyItem({ isActive: false, stoppedAt: "2026-12-01T00:00:00" }), new Set(), "2026-09-14"),
    ["2026-09-07", "2026-09-14"],
  ));

test("停止後に残件を完了すると、その対象日は消える（残件0になれば空）", () => {
  const item = weeklyItem({ isActive: false, stoppedAt: "2026-09-14T09:00:00" });
  assert.deepEqual(inventoryDates(item, new Set(["w1:2026-09-07"]), TODAY), ["2026-09-14"]);
  assert.deepEqual(inventoryDates(item, new Set(["w1:2026-09-07", "w1:2026-09-14"]), TODAY), []);
});

test("再開（有効に戻して stoppedAt を消す）すると従来どおり今日まで出る", () =>
  assert.equal(inventoryDates(weeklyItem({ isActive: true, stoppedAt: null }), new Set(), TODAY).length, 5));

test("状態ラベル：削除済みを優先、停止中、通常はnull", () => {
  assert.equal(itemStatusLabel(weeklyItem()), null);
  assert.equal(itemStatusLabel(weeklyItem({ isActive: false, stoppedAt: "2026-09-14T00:00:00" })), "停止中");
  assert.equal(itemStatusLabel(weeklyItem({ isActive: false, deletedAt: "2026-09-15T00:00:00" })), "削除済み");
  assert.equal(isLiveItem(weeklyItem({ deletedAt: "2026-09-15T00:00:00" })), false);
});
