import { WEEKDAY_LABELS } from "./constants.js";
import type { Weekday } from "./types.js";

// ----------------------------- 日付ユーティリティ -----------------------------

export function dateKeyFromDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(key: string) {
  return new Date(`${key}T00:00:00`);
}

export function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function addDaysKey(key: string, days: number) {
  return dateKeyFromDate(addDays(dateFromKey(key), days));
}

// 深夜タップ確認（A2）の対象時間帯かどうか：0:00〜4:59はtrue、5:00以降はfalse。
// 旧・日付境界（既定05:00）と同じ範囲を「深夜」として扱う
export function isDeepNightHour(date: Date) {
  return date.getHours() * 60 + date.getMinutes() < 5 * 60;
}

export function nowLocalStamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${dateKeyFromDate(now)}T${hh}:${mm}:${ss}`;
}

export function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}

export function formatShortDate(key: string) {
  const date = dateFromKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function formatDateWithWeekday(key: string) {
  const date = dateFromKey(key);
  return `${date.getMonth() + 1}/${date.getDate()}(${WEEKDAY_LABELS[date.getDay()]})`;
}

export function diffDays(fromKey: string, toKey: string) {
  return Math.round((dateFromKey(toKey).getTime() - dateFromKey(fromKey).getTime()) / 86400000);
}

export function weekStartOf(key: string, weekStartDay: Weekday) {
  const date = dateFromKey(key);
  const diff = (date.getDay() - weekStartDay + 7) % 7;
  return dateKeyFromDate(addDays(date, -diff));
}

export function monthKeyOf(key: string) {
  return key.slice(0, 7);
}

export function shiftMonthKey(monthKey: string, offset: number) {
  const [yearText, monthText] = monthKey.split("-");
  const base = new Date(Number(yearText), Number(monthText) - 1 + offset, 1);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}`;
}

export function formatMonthKey(monthKey: string) {
  const [yearText, monthText] = monthKey.split("-");
  return `${yearText}年${Number(monthText)}月`;
}

export function genId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
