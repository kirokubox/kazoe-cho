import assert from "node:assert/strict";
import test from "node:test";
import { dateKeyFromDate, isDeepNightHour } from "../src/dateUtils.js";

// 2026-09-20：日付境界（生活日付）を廃止し、暦日に統一した。isDeepNightHourは
// 深夜タップ確認（A2）の対象時間帯（0:00〜4:59）だけを判定する。5:00は対象外。

test("0:00は深夜タップ確認の対象", () => assert.equal(isDeepNightHour(new Date("2026-09-21T00:00:00")), true));
test("4:59は深夜タップ確認の対象", () => assert.equal(isDeepNightHour(new Date("2026-09-21T04:59:00")), true));
test("5:00は対象外（従来どおり1タップのまま）", () => assert.equal(isDeepNightHour(new Date("2026-09-21T05:00:00")), false));
test("日中は対象外", () => assert.equal(isDeepNightHour(new Date("2026-09-21T12:00:00")), false));

test("dateKeyFromDateは暦日をそのまま返す（丸めない）", () => assert.equal(dateKeyFromDate(new Date("2026-09-21T02:30:00")), "2026-09-21"));
