import assert from "node:assert/strict";
import test from "node:test";
import { periodOf } from "../src/dateUtils.js";
import { aiMarkdownFileName, buildAiPeriodMarkdown, escapeCell, recordTimeLabel } from "../src/exporters.js";
import type { Completion } from "../src/types.js";

// AI用Markdown（週・月）。集計表に加えて、完了ログ1件ずつの明細（8列）を出す。

let seq = 0;
function completion(completedAt: string, patch: Partial<Completion> = {}): Completion {
  seq += 1;
  return {
    id: `c${seq}`,
    itemId: "i1",
    targetDate: "2026-09-23",
    completedAt,
    titleSnapshot: "項目",
    categorySnapshot: "楽しみ",
    groupSnapshot: null,
    note: "",
    count: null,
    ...patch,
  };
}

function build(completions: Completion[], kind: "week" | "month" = "week") {
  const period = periodOf(kind, 0, "2026-09-26", 1); // 週：9/21(月)〜9/27(日)、月：2026年9月
  return buildAiPeriodMarkdown({
    period,
    completions,
    exportedAt: "2026-09-26T10:00:00",
    weekStartDayLabel: "月",
    categoriesOrder: ["楽しみ", "作業"],
    groupsOrder: [],
  });
}

const detailRows = (markdown: string) => markdown.split("\n").filter((line) => /^\| \d{4}-\d{2}-\d{2} \|/.test(line));

test("冒頭に対象期間・書き出し日時・全体合計が入る", () => {
  const md = build([completion("2026-09-23T20:00:00", { count: 3 }), completion("2026-09-24T08:00:00")]);
  assert.match(md, /^# かぞえ帳 AI用データ（週：2026-09-21〜2026-09-27）/);
  assert.match(md, /- 対象期間：2026-09-21〜2026-09-27（週（月曜始まり））/);
  assert.match(md, /- 書き出し日時：2026-09-26T10:00:00/);
  assert.match(md, /- 全体合計：2件・数量4/); // count null は1として数える
});

test("明細は8列で、日付順（同日内は記録時刻順）に並ぶ", () => {
  const md = build([
    completion("2026-09-24T21:30:00", { titleSnapshot: "C" }),
    completion("2026-09-23T22:00:00", { titleSnapshot: "B" }),
    completion("2026-09-23T07:05:00", { titleSnapshot: "A" }),
  ]);
  assert.match(md, /\| 日付 \| 記録時刻 \| カテゴリ \| グループ \| 項目 \| 数量 \| 対象日 \| メモ \|/);
  const rows = detailRows(md);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^\| 2026-09-23 \| 07:05 \| 楽しみ \|  \| A \|  \| 2026-09-23 \|  \|$/);
  assert.match(rows[1], /\| 2026-09-23 \| 22:00 \|/);
  assert.match(rows[2], /\| 2026-09-24 \| 21:30 \|/);
});

test("12:00:00ちょうどの記録は「日付指定」、それ以外の正午台は時刻のまま", () => {
  assert.equal(recordTimeLabel("2026-09-23T12:00:00"), "日付指定");
  assert.equal(recordTimeLabel("2026-09-23T12:00:01"), "12:00");
  assert.equal(recordTimeLabel("2026-09-23T12:01:00"), "12:01");
  assert.equal(recordTimeLabel("broken"), "");
  const md = build([completion("2026-09-23T12:00:00")]);
  assert.match(detailRows(md)[0], /\| 2026-09-23 \| 日付指定 \|/);
});

test("期間外の記録は集計にも明細にも含めない（境界日は含む）", () => {
  const md = build([
    completion("2026-09-20T23:59:59", { titleSnapshot: "前の週" }),
    completion("2026-09-21T00:00:00", { titleSnapshot: "月曜0時" }),
    completion("2026-09-27T23:59:59", { titleSnapshot: "日曜末" }),
    completion("2026-09-28T00:00:00", { titleSnapshot: "次の週" }),
  ]);
  assert.equal(detailRows(md).length, 2);
  assert.ok(md.includes("月曜0時") && md.includes("日曜末"));
  assert.ok(!md.includes("前の週") && !md.includes("次の週"));
  assert.match(md, /- 全体合計：2件・数量2/);
});

test("セル内の | と改行はエスケープされ、表が崩れない", () => {
  assert.equal(escapeCell("a|b"), "a\\|b");
  assert.equal(escapeCell("1行目\n2行目\r\n3行目"), "1行目<br>2行目<br>3行目");
  const md = build([completion("2026-09-23T20:00:00", { titleSnapshot: "A|B", note: "メモ|1\nメモ2", groupSnapshot: "G|1" })]);
  const row = detailRows(md)[0];
  assert.ok(row.includes("A\\|B") && row.includes("メモ\\|1<br>メモ2") && row.includes("G\\|1"));
  // エスケープ済みの | を除いた区切りは、先頭・末尾を含めて9本（8列）
  assert.equal(row.replace(/\\\|/g, "").split("|").length - 1, 9);
});

test("数量・グループ・対象日・メモはそのまま出す（nullは空欄、対象日は加工しない）", () => {
  const md = build([completion("2026-09-25T19:00:00", { count: 2, groupSnapshot: "アニメ", targetDate: "2026-09-22", note: "第3話まで" })]);
  assert.match(detailRows(md)[0], /^\| 2026-09-25 \| 19:00 \| 楽しみ \| アニメ \| 項目 \| 2 \| 2026-09-22 \| 第3話まで \|$/);
});

test("記録が無い期間でも冒頭と注記は出る", () => {
  const md = build([]);
  assert.match(md, /- 全体合計：0件・数量0/);
  assert.match(md, /この期間の記録はありません。/);
  assert.equal(detailRows(md).length, 0);
});

test("カテゴリ別集計はグループの合計行を出さない", () => {
  const md = build([
    completion("2026-09-23T20:00:00", { groupSnapshot: "アニメ", titleSnapshot: "X" }),
    completion("2026-09-23T21:00:00", { groupSnapshot: "アニメ", titleSnapshot: "Y" }),
  ]);
  assert.match(md, /### 楽しみ（2件・数量2）/);
  assert.match(md, /\| アニメ \| X \| 1 \| 1 \|/);
  const statsPart = md.split("## 明細")[0];
  assert.equal(statsPart.split("\n").filter((line) => line.startsWith("|") && line.includes("合計")).length, 0);
});

test("ファイル名は週・月と対象期間が分かる形", () => {
  assert.equal(aiMarkdownFileName(periodOf("week", 0, "2026-09-26", 1)), "kazoe-cho-week-2026-09-21_2026-09-27.md");
  assert.equal(aiMarkdownFileName(periodOf("month", 0, "2026-09-26", 1)), "kazoe-cho-month-2026-09.md");
});

test("月の出力でも期間内だけを対象にする", () => {
  const md = build([completion("2026-09-01T09:00:00"), completion("2026-08-31T23:00:00")], "month");
  assert.match(md, /^# かぞえ帳 AI用データ（月：2026-09-01〜2026-09-30）/);
  assert.equal(detailRows(md).length, 1);
});
