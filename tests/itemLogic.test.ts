import assert from "node:assert/strict";
import test from "node:test";
import { doneDateOf } from "../src/itemLogic.js";
import type { Completion } from "../src/types.js";

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
