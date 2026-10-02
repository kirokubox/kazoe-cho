import assert from "node:assert/strict";
import test from "node:test";
import { dateKeyFromDate, isDeepNightHour, periodOf } from "../src/dateUtils.js";

// 2026-09-20：日付境界（生活日付）を廃止し、暦日に統一した。isDeepNightHourは
// 深夜タップ確認（A2）の対象時間帯（0:00〜4:59）だけを判定する。5:00は対象外。

test("0:00は深夜タップ確認の対象", () => assert.equal(isDeepNightHour(new Date("2026-09-21T00:00:00")), true));
test("4:59は深夜タップ確認の対象", () => assert.equal(isDeepNightHour(new Date("2026-09-21T04:59:00")), true));
test("5:00は対象外（従来どおり1タップのまま）", () => assert.equal(isDeepNightHour(new Date("2026-09-21T05:00:00")), false));
test("日中は対象外", () => assert.equal(isDeepNightHour(new Date("2026-09-21T12:00:00")), false));

test("dateKeyFromDateは暦日をそのまま返す（丸めない）", () => assert.equal(dateKeyFromDate(new Date("2026-09-21T02:30:00")), "2026-09-21"));

test("週の期間：週開始曜日に従い、offsetで前の週へ", () => {
  // 2026-10-03は土曜。月曜始まりなら 9/28〜10/4、1週前は 9/21〜9/27
  const now = periodOf("week", 0, "2026-10-03", 1);
  assert.equal(now.startKey, "2026-09-28");
  assert.equal(now.endKey, "2026-10-04");
  assert.equal(periodOf("week", 1, "2026-10-03", 1).startKey, "2026-09-21");
  // 日曜始まりなら 9/27〜10/3
  assert.equal(periodOf("week", 0, "2026-10-03", 0).startKey, "2026-09-27");
});

test("月の期間：月初〜月末（2月・年またぎ）", () => {
  const feb = periodOf("month", 0, "2028-02-10", 1);
  assert.equal(feb.startKey, "2028-02-01");
  assert.equal(feb.endKey, "2028-02-29");
  const prev = periodOf("month", 1, "2026-01-15", 1);
  assert.equal(prev.startKey, "2025-12-01");
  assert.equal(prev.endKey, "2025-12-31");
  assert.equal(prev.contains("2025-12-31"), true);
  assert.equal(prev.contains("2026-01-01"), false);
});
