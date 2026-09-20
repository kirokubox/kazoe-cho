import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ACTIVE_VIEW_KEY, BACKUP_NOTICE_KEY, FOLD_STATE_KEY, NEW_CATEGORY_VALUE, NEW_GROUP_VALUE, NO_GROUP_VALUE, STORAGE_KEY, WEEKDAY_LABELS } from "./constants";
import { addDaysKey, dateKeyFromDate, diffDays, formatDateWithWeekday, formatMonthKey, formatShortDate, genId, isDeepNightHour, monthKeyOf, nowLocalStamp, shiftMonthKey, weekStartOf } from "./dateUtils";
import { buildMarkdownExport, buildPeriodStatsMarkdown, downloadTextFile } from "./exporters";
import { buildStatCategories, doneDateOf, inventoryDates, isInventoryItem, isRepeatStockItem, isSingleStockItem, latestCompletionAmong, recentCompletionsOf } from "./itemLogic";
import { convertOldBackup } from "./legacyImport";
import { RecordButton } from "./RecordButton";
import { loadActiveView, loadData, loadFoldState, normalizeAppData } from "./storage";
import type { AppData, Completion, DatePickTarget, EnrichTarget, FoldState, ImportPreview, InventoryEntry, Item, ItemDraft, NightConfirmTarget, RepeatType, SettingsStockFilter, StockEntry, Tab, Weekday } from "./types";

// ---------------------------------------------------------------------------
// かぞえ帳：「いつから？いくつ？」に一瞬で答える行動台帳
// - Googleカレンダー＝原本（時刻つきの事実）、Keep＝詳細、本アプリ＝索引
// - 入れていいのは「やりたいこと」だけ。締切・義務・時間分数は持たない
// ---------------------------------------------------------------------------


// ----------------------------- 本体 -----------------------------

export default function App() {
  const [data, setData] = useState<AppData>(loadData);
  const [activeTab, setActiveTab] = useState<Tab>(loadActiveView);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // 記録直後の「メモ・数量を足せる」ダイアログ
  const [enrichTarget, setEnrichTarget] = useState<EnrichTarget | null>(null);
  const [enrichNote, setEnrichNote] = useState("");
  const [enrichCount, setEnrichCount] = useState("");

  // 長押し→過去日選択ダイアログ
  const [datePickTarget, setDatePickTarget] = useState<DatePickTarget | null>(null);
  const [pickedDate, setPickedDate] = useState("");

  // 深夜（0:00〜5:00）のワンタップ記録だけ「昨日／今日」を確認する（2026-09-20・暦日統一とセットで追加）
  const [nightConfirmTarget, setNightConfirmTarget] = useState<NightConfirmTarget | null>(null);

  // 単発在庫：箱ごとの「積む」入力欄
  const [stockDrafts, setStockDrafts] = useState<Record<string, string>>({});

  // 在庫タブ：グループカードごとの「在庫なし N件」の開閉（キー＝グループ名。null群は空文字）
  const [openZeroGroups, setOpenZeroGroups] = useState<Set<string>>(new Set());

  // 記録の取り消し（誤タップの救済）。在庫タブの前回1行・前回タブの直近3回から開く
  const [undoTargetId, setUndoTargetId] = useState<string | null>(null);
  // 積んだもの（StockEntry）の取り下げ（＝記録を作らず積みから消す）
  const [withdrawTarget, setWithdrawTarget] = useState<{ entryId: string; label: string } | null>(null);

  // 前回タブ：開いているカテゴリ・グループ（キー無し＝初回起動＝すべて閉じた状態。開閉はfold-stateへ保存する）
  const [openCategories, setOpenCategories] = useState<Set<string>>(() => loadFoldState().openCategories);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => loadFoldState().openGroups);

  // v2→v3移行の直後に一度だけ出すバックアップ推奨バナー
  const [backupNoticeVisible, setBackupNoticeVisible] = useState(() => localStorage.getItem(BACKUP_NOTICE_KEY) === "pending");

  // 設定タブ：項目フォーム
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ItemDraft | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [itemCategoryFilter, setItemCategoryFilter] = useState("");
  const [itemGroupFilter, setItemGroupFilter] = useState("");
  const [itemStockFilter, setItemStockFilter] = useState<SettingsStockFilter>("all");

  // 設定タブ：グループ管理
  const [newGroupName, setNewGroupName] = useState("");
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<string | null>(null);

  // 設定タブ：「項目」「グループ」欄の開閉。前回タブと違い永続化しない（毎回閉じた状態で開く）
  const [itemsSectionOpen, setItemsSectionOpen] = useState(false);
  const [groupsSectionOpen, setGroupsSectionOpen] = useState(false);

  // インポート
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // 集計ビュー
  const [statsMode, setStatsMode] = useState<"weekly" | "monthly">("weekly");
  const [statsOffset, setStatsOffset] = useState(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [data]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_VIEW_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    const payload: FoldState = { openCategories: Array.from(openCategories), openGroups: Array.from(openGroups) };
    localStorage.setItem(FOLD_STATE_KEY, JSON.stringify(payload));
  }, [openCategories, openGroups]);

  // 2026-09-20：日付境界（生活日付）の丸めを廃止し、暦日（0時〜24時で区切る実際のカレンダー日）にそろえた
  const todayLife = dateKeyFromDate(new Date());

  const completedKeys = useMemo(
    () => new Set(data.completions.map((completion) => `${completion.itemId}:${completion.targetDate}`)),
    [data.completions],
  );

  // 在庫タブ：グループ1つ＝カード1枚（v3.1）。繰り返し在庫と単発在庫を同じグループにまとめる。
  // 在庫がある項目を上、在庫0の項目はグループカードの中の「在庫なし」に畳む（並べ替え機能は付けない）
  const inventoryGroups = useMemo(() => {
    const stockItems = data.items.filter((item) => item.isActive && isInventoryItem(item));
    const byGroup = new Map<string, InventoryEntry[]>();
    for (const item of stockItems) {
      const entry: InventoryEntry = isSingleStockItem(item)
        ? {
            type: "single",
            item,
            entries: data.stockEntries.filter((stock) => stock.itemId === item.id).sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
          }
        : { type: "repeat", item, dates: inventoryDates(item, completedKeys, todayLife) };
      const key = item.group ?? "";
      const list = byGroup.get(key) ?? [];
      list.push(entry);
      byGroup.set(key, list);
    }
    const listIndex = (list: string[], value: string) => {
      const index = list.indexOf(value);
      return index === -1 ? list.length : index;
    };
    const hasStock = (entry: InventoryEntry) => (entry.type === "repeat" ? entry.dates.length > 0 : entry.entries.length > 0);
    const groups = Array.from(byGroup.entries()).map(([key, entries]) => {
      // v2踏襲：繰り返し在庫→単発在庫、各群内はタイトル順
      entries.sort((a, b) => (a.type === b.type ? a.item.title.localeCompare(b.item.title, "ja") : a.type === "repeat" ? -1 : 1));
      const stocked = entries.filter(hasStock);
      const zero = entries.filter((entry) => !hasStock(entry));
      const totalDates = entries.reduce((sum, entry) => sum + (entry.type === "repeat" ? entry.dates.length : 0), 0);
      const totalItems = entries.reduce((sum, entry) => sum + (entry.type === "single" ? entry.entries.length : 0), 0);
      const itemIds = new Set(entries.map((entry) => entry.item.id));
      return {
        key,
        group: key === "" ? null : key,
        stocked,
        zero,
        totalDates,
        totalItems,
        hasRepeat: entries.some((entry) => entry.type === "repeat"),
        hasSingle: entries.some((entry) => entry.type === "single"),
        latest: latestCompletionAmong(data.completions, itemIds),
        hasAnyStock: stocked.length > 0,
      };
    });
    // 在庫があるグループを上、空のグループを下。各区画内は設定のグループ順→名前順。（グループなし）は末尾
    groups.sort((a, b) => {
      if (a.hasAnyStock !== b.hasAnyStock) return a.hasAnyStock ? -1 : 1;
      if ((a.group === null) !== (b.group === null)) return a.group === null ? 1 : -1;
      if (a.group === null || b.group === null) return 0;
      return listIndex(data.settings.groups, a.group) - listIndex(data.settings.groups, b.group) || a.group.localeCompare(b.group, "ja");
    });
    return groups;
  }, [data.items, data.stockEntries, data.completions, completedKeys, todayLife, data.settings.groups]);

  const inventoryTotal = inventoryGroups.reduce((sum, group) => sum + group.totalDates + group.totalItems, 0);
  const recurringInventoryTotal = inventoryGroups.reduce((sum, group) => sum + group.totalDates, 0);
  const scheduledSingleItemIds = useMemo(
    () => new Set(data.items.filter((item) => item.isActive && isSingleStockItem(item) && (item.group === "予定" || item.group === "音楽")).map((item) => item.id)),
    [data.items],
  );
  const scheduledInventoryTotal = data.stockEntries.filter((entry) => scheduledSingleItemIds.has(entry.itemId)).length;

  const filteredSettingsItems = useMemo(() => {
    const query = itemSearch.trim().toLocaleLowerCase("ja");
    return data.items.filter((item) => {
      const matchesQuery =
        query === "" ||
        item.title.toLocaleLowerCase("ja").includes(query) ||
        item.category.toLocaleLowerCase("ja").includes(query) ||
        (item.group ?? "").toLocaleLowerCase("ja").includes(query);
      const matchesCategory = itemCategoryFilter === "" || item.category === itemCategoryFilter;
      const matchesGroup =
        itemGroupFilter === "" ||
        (itemGroupFilter === NO_GROUP_VALUE ? item.group === null : item.group === itemGroupFilter);
      const matchesStock =
        itemStockFilter === "all" ||
        (itemStockFilter === "repeat" && (item.repeatType === "weekly" || item.repeatType === "monthly")) ||
        (itemStockFilter === "single" && item.repeatType === "single") ||
        (itemStockFilter === "none" && !item.isStock);
      return matchesQuery && matchesCategory && matchesGroup && matchesStock;
    });
  }, [data.items, itemSearch, itemCategoryFilter, itemGroupFilter, itemStockFilter]);

  const lastItems = useMemo(
    () =>
      data.items
        .filter((item) => item.isActive && !isInventoryItem(item))
        .map((item) => ({ item, recent: recentCompletionsOf(data.completions, item.id, 3) })),
    [data.items, data.completions],
  );

  // 前回タブ：カテゴリ＞グループ＞項目 の3階層。グループ未設定（null）の項目はカテゴリ直下に並ぶ。
  // 空グループ・空カテゴリは項目由来で組み立てるため自然に表示されない
  const lastCategories = useMemo(() => {
    const byCategory = new Map<string, Map<string, typeof lastItems>>();
    for (const entry of lastItems) {
      const groups = byCategory.get(entry.item.category) ?? new Map<string, typeof lastItems>();
      const groupKey = entry.item.group ?? "";
      const list = groups.get(groupKey) ?? [];
      list.push(entry);
      groups.set(groupKey, list);
      byCategory.set(entry.item.category, groups);
    }
    const listIndex = (list: string[], value: string) => {
      const index = list.indexOf(value);
      return index === -1 ? list.length : index;
    };
    return Array.from(byCategory.entries())
      .map(([category, groups]) => ({
        category,
        groups: Array.from(groups.entries())
          .map(([groupKey, entries]) => ({
            group: groupKey === "" ? null : groupKey,
            entries: entries.sort((a, b) => a.item.title.localeCompare(b.item.title, "ja")),
          }))
          .sort((a, b) => {
            if (a.group === null) return b.group === null ? 0 : -1;
            if (b.group === null) return 1;
            return listIndex(data.settings.groups, a.group) - listIndex(data.settings.groups, b.group) || a.group.localeCompare(b.group, "ja");
          }),
      }))
      .sort(
        (a, b) =>
          listIndex(data.settings.categories, a.category) - listIndex(data.settings.categories, b.category) ||
          a.category.localeCompare(b.category, "ja"),
      );
  }, [lastItems, data.settings.categories, data.settings.groups]);

  // ----------------------------- 記録 -----------------------------

  function recordCompletion(item: Item, targetDate: string, doneDate: string | null) {
    const completion: Completion = {
      id: genId(),
      itemId: item.id,
      targetDate,
      // 過去日記録・深夜タップの確認で選んだ日は正午扱いにして、確実に選んだ暦日に集計されるようにする
      completedAt: doneDate ? `${doneDate}T12:00:00` : nowLocalStamp(),
      titleSnapshot: item.title,
      categorySnapshot: item.category,
      groupSnapshot: item.group,
      note: "",
      count: null,
    };
    setData((current) => ({ ...current, completions: [completion, ...current.completions] }));
    setMessage(null);
    // 繰り返し在庫はワンタップ完了（長押し→日付選択でも同じ）。対象日が固有名と単位を兼ねるため、
    // 記録直後ダイアログを開かない。取り消しは在庫タブの前回行に一本化する（v3.2）
    if (isRepeatStockItem(item)) return;
    // ここに到達するのは前回日型のみ（単発在庫は consumeStockEntry を通る）
    setEnrichTarget({ completionId: completion.id, title: item.title, dateLabel: formatDateWithWeekday(doneDate ?? targetDate) });
    setEnrichNote("");
    setEnrichCount("");
  }

  // 単発在庫に1件積む。名前は任意（空でも積める）
  function addStockEntry(item: Item) {
    const label = (stockDrafts[item.id] ?? "").trim();
    const entry: StockEntry = { id: genId(), itemId: item.id, label, addedAt: nowLocalStamp() };
    setData((current) => ({ ...current, stockEntries: [...current.stockEntries, entry] }));
    setStockDrafts((current) => ({ ...current, [item.id]: "" }));
    setMessage(null);
  }

  // 単発在庫の消化：積みから外して完了ログへ。titleSnapshotは積んだ名前（空なら箱の名前）
  function consumeStockEntry(item: Item, entry: StockEntry, doneDate: string | null) {
    const completion: Completion = {
      id: genId(),
      itemId: item.id,
      targetDate: doneDate ?? todayLife,
      completedAt: doneDate ? `${doneDate}T12:00:00` : nowLocalStamp(),
      titleSnapshot: entry.label || item.title,
      categorySnapshot: item.category,
      groupSnapshot: item.group,
      note: "",
      count: null,
    };
    setData((current) => ({
      ...current,
      completions: [completion, ...current.completions],
      stockEntries: current.stockEntries.filter((stock) => stock.id !== entry.id),
    }));
    setEnrichTarget({
      completionId: completion.id,
      title: completion.titleSnapshot,
      dateLabel: formatDateWithWeekday(doneDate ?? todayLife),
      consumedStockEntry: entry,
    });
    setEnrichNote("");
    setEnrichCount("");
    setMessage(null);
  }

  // ----------------------------- 深夜タップの確認（A2） -----------------------------
  // その場のワンタップ（onTap）だけが対象。長押しの日付選択（openDatePick）は既に日付を選ぶ導線なので通さない。
  // 0:00〜4:59にタップしたときだけ「昨日／今日」を1回確認し、選んだ日を既存の日付指定と同じ経路
  // （recordCompletion / consumeStockEntry の doneDate 引数）に乗せる。新しい保存フィールドは増やさない

  function tapRepeatStock(item: Item, date: string) {
    if (isDeepNightHour(new Date())) {
      setNightConfirmTarget({ kind: "repeat", item, date });
      return;
    }
    recordCompletion(item, date, null);
  }

  function tapSingleStock(item: Item, entry: StockEntry) {
    if (isDeepNightHour(new Date())) {
      setNightConfirmTarget({ kind: "single", item, stockEntry: entry });
      return;
    }
    consumeStockEntry(item, entry, null);
  }

  function tapLastItem(item: Item) {
    if (isDeepNightHour(new Date())) {
      setNightConfirmTarget({ kind: "last", item });
      return;
    }
    recordCompletion(item, todayLife, null);
  }

  // 確認ダイアログで「昨日」「今日」のどちらかを選んだあとに呼ぶ。doneDateに選んだ日を渡す
  function resolveNightConfirm(doneDate: string) {
    if (!nightConfirmTarget) return;
    const target = nightConfirmTarget;
    setNightConfirmTarget(null);
    if (target.kind === "repeat") {
      recordCompletion(target.item, target.date, doneDate);
    } else if (target.kind === "single") {
      consumeStockEntry(target.item, target.stockEntry, doneDate);
    } else {
      recordCompletion(target.item, doneDate, doneDate);
    }
  }

  function saveEnrichment() {
    if (!enrichTarget) return;
    const trimmedNote = enrichNote.trim();
    const parsedCount = enrichCount.trim() === "" ? null : Number(enrichCount);
    if (parsedCount !== null && (!Number.isFinite(parsedCount) || parsedCount <= 0)) {
      setMessage({ type: "error", text: "数量は1以上の数字で入れてください" });
      return;
    }
    setData((current) => ({
      ...current,
      completions: current.completions.map((completion) =>
        completion.id === enrichTarget.completionId ? { ...completion, note: trimmedNote, count: parsedCount } : completion,
      ),
    }));
    setEnrichTarget(null);
  }

  function undoEnrichTarget() {
    if (!enrichTarget) return;
    const restoredEntry = enrichTarget.consumedStockEntry;
    setData((current) => ({
      ...current,
      completions: current.completions.filter((completion) => completion.id !== enrichTarget.completionId),
      // 単発在庫の消化を取り消したら、積みに戻す（表示はaddedAt順なので元の位置に戻る）
      stockEntries: restoredEntry ? [...current.stockEntries, restoredEntry] : current.stockEntries,
    }));
    setEnrichTarget(null);
    setMessage({ type: "success", text: "記録を取り消しました" });
  }

  // 記録の取り消し（誤タップの救済）。画面に出ている記録だけが対象。
  // 繰り返し在庫→対象日が在庫に戻る（ログを消せば自動で戻る）。単発在庫→積みに戻す。前回日型→前回が縮む
  function undoCompletion(completionId: string) {
    setData((current) => {
      const completion = current.completions.find((entry) => entry.id === completionId);
      if (!completion) return current;
      const item = current.items.find((entry) => entry.id === completion.itemId);
      const completions = current.completions.filter((entry) => entry.id !== completionId);
      let stockEntries = current.stockEntries;
      if (item && isSingleStockItem(item)) {
        // 消化した積みを戻す（元エントリのid/addedAtは失われるので、消化時刻を積み時刻として復元）
        const label = completion.titleSnapshot === item.title ? "" : completion.titleSnapshot;
        stockEntries = [...current.stockEntries, { id: genId(), itemId: item.id, label, addedAt: completion.completedAt }];
      }
      return { ...current, completions, stockEntries };
    });
    setUndoTargetId(null);
    setMessage({ type: "success", text: "記録を取り消しました" });
  }

  // 積んだもの（StockEntry）の取り下げ。完了ログは作らず、積みから消えるだけ（「楽しんだ」とは別操作）
  function withdrawEntry(entryId: string) {
    setData((current) => ({ ...current, stockEntries: current.stockEntries.filter((entry) => entry.id !== entryId) }));
    setWithdrawTarget(null);
    setMessage({ type: "success", text: "積みから取り下げました" });
  }

  // 在庫タブ：グループカードごとの「在庫なし」開閉
  function toggleZeroGroup(key: string) {
    setOpenZeroGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function openDatePick(item: Item, slotDate: string | null, stockEntry?: StockEntry) {
    setDatePickTarget({ item, slotDate, stockEntry });
    setPickedDate(addDaysKey(todayLife, -1));
  }

  function confirmDatePick() {
    if (!datePickTarget || !pickedDate) return;
    const { item, slotDate, stockEntry } = datePickTarget;
    setDatePickTarget(null);
    if (stockEntry) {
      consumeStockEntry(item, stockEntry, pickedDate);
      return;
    }
    recordCompletion(item, slotDate ?? pickedDate, pickedDate);
  }

  // ----------------------------- 項目フォーム -----------------------------

  function emptyDraft(): ItemDraft {
    return {
      title: "",
      category: data.settings.categories[0] ?? "その他",
      newCategory: "",
      group: NO_GROUP_VALUE,
      newGroup: "",
      isStock: false,
      repeatType: "weekly",
      weekday: "1",
      monthDay: "1",
      inventoryStartDate: "",
      memo: "",
      isActive: true,
    };
  }

  function draftFromItem(item: Item): ItemDraft {
    return {
      title: item.title,
      category: item.category,
      newCategory: "",
      group: item.group ?? NO_GROUP_VALUE,
      newGroup: "",
      isStock: item.isStock,
      // 在庫にしない項目を編集中にONへ切り替えたとき、繰り返しの初期値が毎週になるようにしておく
      repeatType: item.repeatType === "none" ? "weekly" : item.repeatType,
      weekday: item.weekday === null ? "1" : String(item.weekday),
      monthDay: item.monthDay === null ? "1" : String(item.monthDay),
      inventoryStartDate: item.inventoryStartDate ?? "",
      memo: item.memo,
      isActive: item.isActive,
    };
  }

  function saveDraft() {
    if (!draft) return;
    const title = draft.title.trim();
    if (!title) {
      setMessage({ type: "error", text: "タイトルを入れてください" });
      return;
    }
    const category = draft.category === NEW_CATEGORY_VALUE ? draft.newCategory.trim() : draft.category;
    if (!category) {
      setMessage({ type: "error", text: "カテゴリ名を入れてください" });
      return;
    }
    if (draft.group === NEW_GROUP_VALUE && !draft.newGroup.trim()) {
      setMessage({ type: "error", text: "グループ名を入れてください" });
      return;
    }
    const group = draft.group === NEW_GROUP_VALUE ? draft.newGroup.trim() : draft.group === NO_GROUP_VALUE ? null : draft.group;
    // 在庫にしない項目は repeatType=none 固定（曜日・日にち・起点日は持たない）
    const isStock = draft.isStock;
    const repeatType: RepeatType = isStock ? draft.repeatType : "none";
    const weekday = repeatType === "weekly" ? (Number(draft.weekday) as Weekday) : null;
    const monthDayNumber = Number(draft.monthDay);
    const monthDay = repeatType === "monthly" ? Math.min(Math.max(Math.round(monthDayNumber) || 1, 1), 31) : null;
    const inventoryStartDate =
      (repeatType === "weekly" || repeatType === "monthly") && /^\d{4}-\d{2}-\d{2}$/.test(draft.inventoryStartDate)
        ? draft.inventoryStartDate
        : undefined;
    const stamp = nowLocalStamp();

    setData((current) => {
      const categories = current.settings.categories.includes(category)
        ? current.settings.categories
        : [...current.settings.categories, category];
      const groups = group && !current.settings.groups.includes(group) ? [...current.settings.groups, group] : current.settings.groups;
      if (editingItemId) {
        return {
          ...current,
          settings: { ...current.settings, categories, groups },
          items: current.items.map((item) =>
            item.id === editingItemId
              ? { ...item, title, category, group, isStock, repeatType, weekday, monthDay, inventoryStartDate, memo: draft.memo.trim(), isActive: draft.isActive, updatedAt: stamp }
              : item,
          ),
        };
      }
      const item: Item = {
        id: genId(),
        title,
        category,
        group,
        isStock,
        repeatType,
        weekday,
        monthDay,
        isActive: draft.isActive,
        inventoryStartDate,
        memo: draft.memo.trim(),
        createdAt: stamp,
        updatedAt: stamp,
      };
      return { ...current, settings: { ...current.settings, categories, groups }, items: [...current.items, item] };
    });
    setDraft(null);
    setEditingItemId(null);
    setMessage({ type: "success", text: editingItemId ? "項目を更新しました" : "項目を追加しました" });
  }

  // 設定タブ：グループの追加（空でも「受け皿」として選択肢に残る）
  function addGroup() {
    const name = newGroupName.trim();
    if (!name) {
      setMessage({ type: "error", text: "グループ名を入れてください" });
      return;
    }
    if (data.settings.groups.includes(name)) {
      setMessage({ type: "error", text: "同じ名前のグループがあります" });
      return;
    }
    setData((current) => ({ ...current, settings: { ...current.settings, groups: [...current.settings.groups, name] } }));
    setNewGroupName("");
    setMessage({ type: "success", text: `グループ「${name}」を追加しました` });
  }

  // グループ削除：項目が1件でも入っているグループは削除しない（UIで無効化済み）。空グループを選択肢から外すだけ
  function deleteGroup(name: string) {
    if (data.items.some((item) => item.group === name)) return;
    setData((current) => ({
      ...current,
      settings: { ...current.settings, groups: current.settings.groups.filter((group) => group !== name) },
    }));
    setDeleteGroupTarget(null);
    setMessage({ type: "success", text: `グループ「${name}」を削除しました` });
  }

  function dismissBackupNotice() {
    localStorage.removeItem(BACKUP_NOTICE_KEY);
    setBackupNoticeVisible(false);
  }

  // 前回タブ：カテゴリ見出しの開閉切り替え
  function toggleCategoryOpen(category: string) {
    setOpenCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  }

  // 前回タブ：グループ見出しの開閉切り替え
  function toggleGroupOpen(key: string) {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function deleteItem(itemId: string) {
    // titleSnapshot 方式なので、項目を消しても完了ログと集計は残る。未消化の積みは箱と一緒に消す
    setData((current) => ({
      ...current,
      items: current.items.filter((item) => item.id !== itemId),
      stockEntries: current.stockEntries.filter((entry) => entry.itemId !== itemId),
    }));
    setDeleteTargetId(null);
    setMessage({ type: "success", text: "項目を削除しました（記録は残ります）" });
  }

  // ----------------------------- 入出力 -----------------------------

  function exportJson() {
    const payload = { app: "kazoe-cho", exportedAt: nowLocalStamp(), ...data };
    downloadTextFile(`kazoe-cho-backup-${todayLife}.json`, JSON.stringify(payload, null, 2), "application/json");
    setMessage({ type: "success", text: "JSONをエクスポートしました" });
  }

  function exportMarkdown() {
    downloadTextFile(`kazoe-cho-export-${todayLife}.md`, buildMarkdownExport(data, todayLife), "text/markdown");
    setMessage({ type: "success", text: "Markdownをエクスポートしました" });
  }

  // 集計タブ：いま画面に表示中の期間だけをMarkdownエクスポート（v3.4）。全件エクスポートとは用途が違うので併存させる
  function exportPeriodMarkdown() {
    const filename = `kazoe-cho-集計-${statsPeriod.fileLabel}.md`;
    downloadTextFile(filename, buildPeriodStatsMarkdown(statsPeriod.label, statCategories, statsTotalCount, statsTotalQuantity), "text/markdown");
    setMessage({ type: "success", text: "Markdownをエクスポートしました" });
  }

  function handleImportFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(String(reader.result)) as Record<string, unknown>;
        let incomingItems: Item[] = [];
        let incomingCompletions: Completion[] = [];
        let incomingStockEntries: StockEntry[] = [];
        let incomingCategories: string[] = [];
        let incomingGroups: string[] = [];
        let adoptDayBoundary: string | null = null;
        let sourceLabel = "";

        const asNew = normalizeAppData(raw);
        if (asNew) {
          incomingItems = asNew.items;
          incomingCompletions = asNew.completions;
          incomingStockEntries = asNew.stockEntries;
          // 空のカテゴリ・グループも「受け皿」なので設定ごと取り込む（シードJSON対応）
          incomingCategories = asNew.settings.categories;
          incomingGroups = asNew.settings.groups;
          sourceLabel = "かぞえ帳バックアップ";
        } else {
          const asOld = convertOldBackup(raw);
          if (!asOld) {
            setMessage({ type: "error", text: "対応していない形式のファイルです" });
            return;
          }
          incomingItems = asOld.items;
          incomingCompletions = asOld.completions;
          incomingCategories = asOld.items.map((item) => item.category);
          adoptDayBoundary = asOld.dayBoundaryTime;
          sourceLabel = "旧ゆるたすくバックアップ（変換して取り込み）";
        }

        const existingItemIds = new Set(data.items.map((item) => item.id));
        const existingCompletionIds = new Set(data.completions.map((completion) => completion.id));
        const existingStockEntryIds = new Set(data.stockEntries.map((entry) => entry.id));
        const addedItems = incomingItems.filter((item) => !existingItemIds.has(item.id));
        const addedCompletions = incomingCompletions.filter((completion) => !existingCompletionIds.has(completion.id));
        const addedStockEntries = incomingStockEntries.filter((entry) => !existingStockEntryIds.has(entry.id));

        setImportPreview({
          sourceLabel,
          incomingItems: addedItems,
          incomingCompletions: addedCompletions,
          incomingStockEntries: addedStockEntries,
          incomingCategories,
          incomingGroups,
          adoptDayBoundary,
          counts: [
            { label: "項目", loaded: incomingItems.length, added: addedItems.length, skipped: incomingItems.length - addedItems.length },
            { label: "完了ログ", loaded: incomingCompletions.length, added: addedCompletions.length, skipped: incomingCompletions.length - addedCompletions.length },
            { label: "積んだもの（未消化）", loaded: incomingStockEntries.length, added: addedStockEntries.length, skipped: incomingStockEntries.length - addedStockEntries.length },
          ],
        });
      } catch {
        setMessage({ type: "error", text: "JSONの読み込みに失敗しました" });
      }
    };
    reader.readAsText(file);
  }

  function applyImport() {
    if (!importPreview) return;
    setData((current) => {
      const categories = [...current.settings.categories];
      for (const category of [...importPreview.incomingCategories, ...importPreview.incomingItems.map((item) => item.category)]) {
        if (!categories.includes(category)) categories.push(category);
      }
      const groups = [...current.settings.groups];
      for (const group of [...importPreview.incomingGroups, ...importPreview.incomingItems.map((item) => item.group)]) {
        if (group && !groups.includes(group)) groups.push(group);
      }
      return {
        ...current,
        items: [...current.items, ...importPreview.incomingItems],
        completions: [...importPreview.incomingCompletions, ...current.completions],
        stockEntries: [...current.stockEntries, ...importPreview.incomingStockEntries],
        settings: {
          ...current.settings,
          categories,
          groups,
          dayBoundaryTime: importPreview.adoptDayBoundary ?? current.settings.dayBoundaryTime,
        },
      };
    });
    setImportPreview(null);
    setMessage({ type: "success", text: "追加インポートが完了しました" });
  }

  // ----------------------------- 集計 -----------------------------

  const statsPeriod = useMemo(() => {
    if (statsMode === "weekly") {
      const currentStart = weekStartOf(todayLife, data.settings.weekStartDay);
      const start = addDaysKey(currentStart, -7 * statsOffset);
      const end = addDaysKey(start, 6);
      return {
        label: `${formatDateWithWeekday(start)}〜${formatDateWithWeekday(end)}`,
        // 期間エクスポートのファイル名用（YYYY-MM-DD〜YYYY-MM-DD）。表示ラベルは曜日つきなのでファイル名には使わない
        fileLabel: `${start}〜${end}`,
        contains: (doneDate: string) => doneDate >= start && doneDate <= end,
      };
    }
    const monthKey = shiftMonthKey(monthKeyOf(todayLife), -statsOffset);
    return {
      label: formatMonthKey(monthKey),
      fileLabel: monthKey,
      contains: (doneDate: string) => monthKeyOf(doneDate) === monthKey,
    };
  }, [statsMode, statsOffset, todayLife, data.settings.weekStartDay]);

  const statsCompletions = useMemo(
    () => data.completions.filter((completion) => statsPeriod.contains(doneDateOf(completion))),
    [data.completions, statsPeriod],
  );

  const statCategories = useMemo(
    () => buildStatCategories(statsCompletions, data.settings.categories, data.settings.groups),
    [statsCompletions, data.settings.categories, data.settings.groups],
  );

  const statsTotalCount = statCategories.reduce((sum, category) => sum + category.count, 0);
  const statsTotalQuantity = statCategories.reduce((sum, category) => sum + category.quantity, 0);

  // ----------------------------- 描画 -----------------------------

  const tabLabels: { key: Tab; label: string }[] = [
    { key: "home", label: "在庫" },
    { key: "last", label: "前回" },
    { key: "stats", label: "集計" },
    { key: "settings", label: "設定" },
  ];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">いつから？いくつ？の行動台帳</p>
          <h1>かぞえ帳</h1>
        </div>
      </header>

      {message && (
        <div className={`message ${message.type}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)}>閉じる</button>
        </div>
      )}

      {backupNoticeVisible && (
        <div className="notice-banner">
          <p>データをv3形式に更新しました。念のためJSONエクスポートで控えを取っておくのがおすすめです（更新前のデータはこの端末内に退避済み）</p>
          <div className="button-row">
            <button type="button" className="primary-button" onClick={() => { exportJson(); dismissBackupNotice(); }}>JSONエクスポート</button>
            <button type="button" onClick={dismissBackupNotice}>あとで</button>
          </div>
        </div>
      )}

      <main className="view-stack">
        {activeTab === "home" && (
          <>
            <section className="section inventory-lead">
              <h2>楽しみの在庫</h2>
              <p className="small-note">
                全体{inventoryTotal}個 / 継続{recurringInventoryTotal}回ぶん / 予定{scheduledInventoryTotal}件
              </p>
            </section>
            {inventoryGroups.length === 0 && (
              <section className="section">
                <p className="empty-text">在庫型の項目がまだありません。設定タブで「在庫にする」項目（毎週・毎月・単発在庫）をつくると、ここに在庫が積まれていきます。</p>
              </section>
            )}
            {/* グループ1つ＝カード1枚（v3.1）。在庫がある項目を上、在庫0はカード内の「在庫なし」に畳む */}
            {inventoryGroups.map((group) => {
              // 在庫がある分だけ数える。0の側は「在庫なし」の畳みが伝えるのでチップに出さない
              const countParts: string[] = [];
              if (group.totalDates > 0) countParts.push(`${group.totalDates}回ぶん`);
              if (group.totalItems > 0) countParts.push(`${group.totalItems}件`);
              const groupLabel = group.group ?? "（グループなし）";
              const zeroOpen = openZeroGroups.has(group.key);
              return (
                <section key={group.key} className="section inventory-card">
                  <div className="inventory-card-head">
                    <h3>{groupLabel}</h3>
                    {countParts.length > 0 && <span className="count-chip">{countParts.join("・")}</span>}
                  </div>
                  {/* グループ配下の最新1件。タップで取り消せる（誤タップの救済） */}
                  {group.latest && (
                    <button type="button" className="single-latest undo-latest" onClick={() => setUndoTargetId(group.latest!.id)}>
                      前回：{formatShortDate(doneDateOf(group.latest))}（{group.latest.titleSnapshot}）
                    </button>
                  )}
                  {group.stocked.length > 0 && <div className="card-divider" />}
                  {group.stocked.map((entry) => {
                    const showSub = entry.item.title !== (group.group ?? "");
                    return (
                      <div key={entry.item.id} className="inv-item-block">
                        {showSub && <p className="inv-item-title">{entry.item.title}</p>}
                        {entry.type === "repeat" ? (
                          <div className="inventory-date-list">
                            {entry.dates.map((date) => (
                              <div key={date} className="inventory-date-row">
                                <span>{formatDateWithWeekday(date)}ぶん</span>
                                <RecordButton
                                  label="楽しんだ"
                                  className="enjoy-button"
                                  onTap={() => tapRepeatStock(entry.item, date)}
                                  onLongPress={() => openDatePick(entry.item, date)}
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <>
                            <div className="inventory-date-list">
                              {entry.entries.map((stock) => (
                                <div key={stock.id} className="inventory-date-row single-entry-row">
                                  <span>{stock.label || "（名前なし）"}</span>
                                  <div className="entry-actions">
                                    <button
                                      type="button"
                                      className="withdraw-button"
                                      onClick={() => setWithdrawTarget({ entryId: stock.id, label: stock.label || "（名前なし）" })}
                                    >
                                      取り下げる
                                    </button>
                                    <RecordButton
                                      label="楽しんだ"
                                      className="enjoy-button"
                                      onTap={() => tapSingleStock(entry.item, stock)}
                                      onLongPress={() => openDatePick(entry.item, null, stock)}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="stock-add-row">
                              <input
                                value={stockDrafts[entry.item.id] ?? ""}
                                onChange={(event) => setStockDrafts((current) => ({ ...current, [entry.item.id]: event.target.value }))}
                                placeholder="例：国宝（積むものの名前）"
                              />
                              <button type="button" className="primary-button" onClick={() => addStockEntry(entry.item)}>積む</button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                  {/* 在庫0の項目はこのカードの中に畳む（展開時も1件1行の軽い表示） */}
                  {group.zero.length > 0 && (
                    <div className="zero-stock-section">
                      <button type="button" className="zero-stock-chip" onClick={() => toggleZeroGroup(group.key)}>
                        <span>在庫なし {group.zero.length}件</span>
                        <span className="chip-caret">{zeroOpen ? "たたむ ▲" : "ひらく ▼"}</span>
                      </button>
                      {zeroOpen && (
                        <div className="zero-stock-list">
                          {group.zero.map((entry) =>
                            entry.type === "repeat" ? (
                              <div key={entry.item.id} className="zero-stock-row">
                                <span className="zero-stock-title">{entry.item.title}</span>
                                <span className="zero-stock-note">ぜんぶ楽しみ済み 🎉</span>
                              </div>
                            ) : (
                              <div key={entry.item.id} className="zero-stock-row">
                                <span className="zero-stock-title">{entry.item.title}</span>
                                <div className="zero-stock-add">
                                  <input
                                    value={stockDrafts[entry.item.id] ?? ""}
                                    onChange={(event) => setStockDrafts((current) => ({ ...current, [entry.item.id]: event.target.value }))}
                                    placeholder="積むものの名前"
                                  />
                                  <button type="button" onClick={() => addStockEntry(entry.item)}>積む</button>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}

        {activeTab === "last" && (
          <>
            <section className="section">
              <h2>前回いつ？</h2>
              <p className="small-note">事実だけを並べる棚。目標も達成率もありません。「やった」長押しで過去の日付でも記録できます</p>
            </section>
            {lastCategories.length === 0 && (
              <section className="section">
                <p className="empty-text">前回日型の項目がまだありません。設定タブで「在庫にしない」項目（洗濯・サウナ・記事執筆など）をつくると、ここに並びます。</p>
              </section>
            )}
            {/* カテゴリ＞グループ＞項目 の3階層。初回起動はすべて閉じ、以降の開閉状態はfold-stateに保存する（v3.4） */}
            {lastCategories.map((categoryBlock) => {
              // カテゴリの件数＝配下の全グループ＋カテゴリ直下（group=null）の項目総数
              const categoryCount = categoryBlock.groups.reduce((sum, group) => sum + group.entries.length, 0);
              const categoryOpen = openCategories.has(categoryBlock.category);
              return (
                <section key={categoryBlock.category} className="section">
                  <button type="button" className="last-category-head" onClick={() => toggleCategoryOpen(categoryBlock.category)}>
                    <span>{categoryBlock.category} {categoryCount}件</span>
                    <span className="chip-caret">{categoryOpen ? "▲" : "▼"}</span>
                  </button>
                  {categoryOpen && (
                    <div className="last-category-body">
                      {categoryBlock.groups.map((groupBlock) => {
                        const collapseKey = `${categoryBlock.category}|${groupBlock.group ?? ""}`;
                        // グループ未設定（null）はカテゴリ直下の項目なので見出しを持たず、カテゴリが開けば常に表示する
                        const groupOpen = groupBlock.group === null || openGroups.has(collapseKey);
                        return (
                          <div key={collapseKey} className="last-group-block">
                            {groupBlock.group !== null && (
                              <button type="button" className="last-group-head" onClick={() => toggleGroupOpen(collapseKey)}>
                                <span>{groupBlock.group} {groupBlock.entries.length}件</span>
                                <span className="chip-caret">{groupOpen ? "▲" : "▼"}</span>
                              </button>
                            )}
                            {groupOpen && (
                              <div className={`last-list${groupBlock.group !== null ? " grouped" : ""}`}>
                                {groupBlock.entries.map(({ item, recent }) => {
                                  const latest = recent[0] ?? null;
                                  const latestDoneDate = latest ? doneDateOf(latest) : null;
                                  return (
                                    <div key={item.id} className="last-row">
                                      <div className="last-info">
                                        <span className="last-title">{item.title}</span>
                                        <span className="last-meta">
                                          {latest && latestDoneDate ? (
                                            <>
                                              前回：
                                              {/* 直近3回の各日付はタップで取り消せる（画面に出ている記録だけが対象・誤タップの救済） */}
                                              <button type="button" className="undo-date-chip" onClick={() => setUndoTargetId(latest.id)}>
                                                {formatShortDate(latestDoneDate)}
                                                {latest.note ? `（${latest.note}）` : ""}・
                                                {diffDays(latestDoneDate, todayLife) === 0 ? "今日" : `${diffDays(latestDoneDate, todayLife)}日前`}
                                              </button>
                                              {/* 2回前・3回前は補助情報として淡く小さく。主役は前回日と経過日数（確定仕様） */}
                                              {recent.length > 1 && (
                                                <span className="last-history">
                                                  {" ／ "}
                                                  {recent.slice(1).map((completion, index) => (
                                                    <Fragment key={completion.id}>
                                                      {index > 0 && "・"}
                                                      <button type="button" className="undo-date-chip subtle" onClick={() => setUndoTargetId(completion.id)}>
                                                        {formatShortDate(doneDateOf(completion))}
                                                      </button>
                                                    </Fragment>
                                                  ))}
                                                </span>
                                              )}
                                            </>
                                          ) : (
                                            "記録はこれから"
                                          )}
                                        </span>
                                      </div>
                                      <RecordButton
                                        label="やった"
                                        className="did-button"
                                        onTap={() => tapLastItem(item)}
                                        onLongPress={() => openDatePick(item, null)}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}

        {activeTab === "stats" && (
          <>
            <section className="section">
              <h2>集計</h2>
              <p className="small-note">充実してる度の見える化。採点ではありません（週は{WEEKDAY_LABELS[data.settings.weekStartDay]}曜始まり）</p>
              <div className="stats-controls">
                <div className="segmented">
                  <button type="button" className={statsMode === "weekly" ? "active" : ""} onClick={() => { setStatsMode("weekly"); setStatsOffset(0); }}>週次</button>
                  <button type="button" className={statsMode === "monthly" ? "active" : ""} onClick={() => { setStatsMode("monthly"); setStatsOffset(0); }}>月次</button>
                </div>
                <div className="period-nav">
                  <button type="button" onClick={() => setStatsOffset((value) => value + 1)}>◀ 前</button>
                  <span className="period-label">{statsPeriod.label}</span>
                  <button type="button" disabled={statsOffset === 0} onClick={() => setStatsOffset((value) => Math.max(0, value - 1))}>次 ▶</button>
                </div>
              </div>
              <p className="stats-total">合計 {statsTotalCount} 件・数量 {statsTotalQuantity}</p>
            </section>
            {statCategories.length === 0 && (
              <section className="section">
                <p className="empty-text">この期間の記録はまだありません。</p>
              </section>
            )}
            {statCategories.map((category) => (
              <section key={category.category} className="section">
                <div className="stat-category-head">
                  <h3 className="group-title">{category.category}</h3>
                  <span className="stat-subtotal">{category.count}件・数量{category.quantity}</span>
                </div>
                <table className="stat-table">
                  <thead>
                    <tr><th>項目</th><th>件数</th><th>数量</th></tr>
                  </thead>
                  <tbody>
                    {/* グループは見出し行だけ。合計行は出さない（重みの違う行動を足した数に意味がないため） */}
                    {category.groups.map((group) => (
                      <Fragment key={group.group ?? "__direct__"}>
                        {group.group !== null && (
                          <tr className="stat-group-row">
                            <td colSpan={3}>{group.group}</td>
                          </tr>
                        )}
                        {group.rows.map((row) => (
                          <tr key={`${group.group ?? ""}|${row.title}`} className={group.group !== null ? "stat-grouped-row" : undefined}>
                            <td>{row.title}</td>
                            <td className="num">{row.count}</td>
                            <td className="num">{row.quantity}</td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </section>
            ))}
            <section className="section">
              <button type="button" className="primary-button" onClick={exportPeriodMarkdown}>この期間をMarkdownエクスポート</button>
              <p className="small-note">今表示している期間（{statsPeriod.label}）だけを書き出します。全件のエクスポートは設定タブにあります</p>
            </section>
          </>
        )}

        {activeTab === "settings" && (
          <>
            <section className="section">
              <button type="button" className="settings-section-head" onClick={() => setItemsSectionOpen((value) => !value)}>
                <h2>項目 {data.items.length}件</h2>
                <span className="chip-caret">{itemsSectionOpen ? "▲" : "▼"}</span>
              </button>
              {itemsSectionOpen && (
                <div className="settings-section-body">
                  <button type="button" className="primary-button add-item-button" onClick={() => { setDraft(emptyDraft()); setEditingItemId(null); }}>
                    ＋ 項目をつくる
                  </button>
                  <div className="item-filters">
                    <label className="item-search-field">
                      項目を検索
                      <input
                        type="search"
                        value={itemSearch}
                        onChange={(event) => setItemSearch(event.target.value)}
                        placeholder="タイトル・カテゴリ・グループ"
                      />
                    </label>
                    <div className="item-filter-grid">
                      <label>
                        カテゴリ
                        <select value={itemCategoryFilter} onChange={(event) => setItemCategoryFilter(event.target.value)}>
                          <option value="">すべて</option>
                          {data.settings.categories.map((category) => <option key={category} value={category}>{category}</option>)}
                        </select>
                      </label>
                      <label>
                        グループ
                        <select value={itemGroupFilter} onChange={(event) => setItemGroupFilter(event.target.value)}>
                          <option value="">すべて</option>
                          <option value={NO_GROUP_VALUE}>（なし）</option>
                          {data.settings.groups.map((group) => <option key={group} value={group}>{group}</option>)}
                        </select>
                      </label>
                      <label>
                        在庫種別
                        <select value={itemStockFilter} onChange={(event) => setItemStockFilter(event.target.value as SettingsStockFilter)}>
                          <option value="all">すべて</option>
                          <option value="repeat">継続</option>
                          <option value="single">単発</option>
                          <option value="none">在庫にしない</option>
                        </select>
                      </label>
                    </div>
                    <p className="item-filter-count">{filteredSettingsItems.length} / {data.items.length}件</p>
                  </div>
                  <div className="item-list">
                    {filteredSettingsItems.map((item) => {
                      const repeatLabel =
                        item.repeatType === "weekly" && item.weekday !== null
                          ? `毎週${WEEKDAY_LABELS[item.weekday]}`
                          : item.repeatType === "monthly" && item.monthDay !== null
                            ? `毎月${item.monthDay}日`
                            : item.repeatType === "single"
                              ? "手で積む"
                              : "随時";
                      return (
                        <div key={item.id} className={`item-row ${item.isActive ? "" : "inactive"}`}>
                          <div className="item-row-info">
                            <span className="item-row-title">{item.title}</span>
                            <span className="item-row-meta">
                              {isSingleStockItem(item) ? "単発在庫" : isInventoryItem(item) ? "在庫型" : "前回日型"}・{item.category}{item.group ? `＞${item.group}` : ""}・{repeatLabel}
                              {item.isActive ? "" : "・停止中"}
                            </span>
                          </div>
                          <div className="item-row-actions">
                            <button type="button" onClick={() => { setDraft(draftFromItem(item)); setEditingItemId(item.id); }}>編集</button>
                            <button type="button" className="subtle-button" onClick={() => setDeleteTargetId(item.id)}>削除</button>
                          </div>
                        </div>
                      );
                    })}
                    {data.items.length === 0 && <p className="empty-text">項目はまだありません。</p>}
                    {data.items.length > 0 && filteredSettingsItems.length === 0 && <p className="empty-text">条件に合う項目はありません。</p>}
                  </div>
                </div>
              )}
            </section>

            <section className="section">
              <button type="button" className="settings-section-head" onClick={() => setGroupsSectionOpen((value) => !value)}>
                <h2>グループ {data.settings.groups.length}件</h2>
                <span className="chip-caret">{groupsSectionOpen ? "▲" : "▼"}</span>
              </button>
              {groupsSectionOpen && (
                <div className="settings-section-body">
                  <p className="small-note">カテゴリと項目の間の中分類（アニメ、開発垢、家事…）。項目が0件のグループは在庫・前回タブに出ませんが、選択肢としてはここに残ります。項目が入っているグループは削除できません（先に項目を移すか削除してください）</p>
                  <div className="group-add-row">
                    <input
                      value={newGroupName}
                      onChange={(event) => setNewGroupName(event.target.value)}
                      placeholder="例：アニメ、開発垢、家事"
                    />
                    <button type="button" className="primary-button" onClick={addGroup}>追加</button>
                  </div>
                  <div className="item-list">
                    {data.settings.groups.map((group) => {
                      const hasMembers = data.items.some((item) => item.group === group);
                      return (
                        <div key={group} className="item-row">
                          <div className="item-row-info">
                            <span className="item-row-title">{group}</span>
                            {hasMembers && <span className="item-row-meta">項目が入っています</span>}
                          </div>
                          <div className="item-row-actions">
                            <button type="button" className="subtle-button" disabled={hasMembers} onClick={() => setDeleteGroupTarget(group)}>削除</button>
                          </div>
                        </div>
                      );
                    })}
                    {data.settings.groups.length === 0 && <p className="empty-text">グループはまだありません。項目フォームからも追加できます。</p>}
                  </div>
                </div>
              )}
            </section>

            <section className="section">
              <h2>データ</h2>
              <div className="data-actions">
                <div className="data-action-block">
                  <button type="button" onClick={exportJson}>JSONエクスポート</button>
                  <p className="small-note">バックアップと端末間のデータ移動に使います</p>
                </div>
                <div className="data-action-block">
                  <button type="button" onClick={() => importInputRef.current?.click()}>JSON追加インポート</button>
                  <p className="small-note">かぞえ帳のバックアップと、旧ゆるたすくのバックアップ（自動変換）に対応。取り込む前に件数を確認できます</p>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    style={{ display: "none" }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) handleImportFile(file);
                      event.target.value = "";
                    }}
                  />
                </div>
                <div className="data-action-block">
                  <button type="button" onClick={exportMarkdown}>Markdownエクスポート</button>
                  <p className="small-note">週次・月次の件数入り。AIに読ませる分析用</p>
                </div>
              </div>
            </section>

            <section className="section">
              <h2>時間の区切り</h2>
              <div className="form-grid-2">
                <label>
                  週の開始曜日
                  <select
                    value={data.settings.weekStartDay}
                    onChange={(event) => setData((current) => ({ ...current, settings: { ...current.settings, weekStartDay: Number(event.target.value) as Weekday } }))}
                  >
                    {WEEKDAY_LABELS.map((label, index) => (
                      <option key={label} value={index}>{label}曜日</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          </>
        )}
      </main>

      <nav className="bottom-nav">
        {tabLabels.map((tab) => (
          <button key={tab.key} type="button" className={activeTab === tab.key ? "active" : ""} onClick={() => setActiveTab(tab.key)}>
            {tab.label}
          </button>
        ))}
      </nav>

      {/* 項目の新規・編集モーダル（v3.1で常設フォームから移行。閉じても設定リストのスクロール位置が保たれる） */}
      {draft && (
        <div className="dialog-backdrop">
          <div className="dialog item-form-dialog">
            <h3>{editingItemId ? "項目を編集" : "新しい項目"}</h3>
            <label>
              タイトル（必須）
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例：週刊少年ジャンプ、サウナ、記事執筆" />
            </label>
            <div className="form-grid-2">
              <label>
                カテゴリ
                <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
                  {data.settings.categories.map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                  <option value={NEW_CATEGORY_VALUE}>＋新しいカテゴリ</option>
                </select>
              </label>
              <label>
                グループ（任意）
                <select value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })}>
                  <option value={NO_GROUP_VALUE}>（なし）</option>
                  {data.settings.groups.map((group) => (
                    <option key={group} value={group}>{group}</option>
                  ))}
                  <option value={NEW_GROUP_VALUE}>＋新しいグループ</option>
                </select>
              </label>
            </div>
            {draft.category === NEW_CATEGORY_VALUE && (
              <label>
                新しいカテゴリ名
                <input value={draft.newCategory} onChange={(event) => setDraft({ ...draft, newCategory: event.target.value })} />
              </label>
            )}
            {draft.group === NEW_GROUP_VALUE && (
              <label>
                新しいグループ名
                <input value={draft.newGroup} onChange={(event) => setDraft({ ...draft, newGroup: event.target.value })} placeholder="例：アニメ、開発垢、家事" />
              </label>
            )}
            <div className="form-grid-2">
              <label>
                在庫にする
                <select
                  value={draft.isStock ? "yes" : "no"}
                  onChange={(event) => setDraft({ ...draft, isStock: event.target.value === "yes" })}
                >
                  <option value="no">在庫にしない</option>
                  <option value="yes">在庫にする</option>
                </select>
                <span className="field-help">オンにすると、やっていない分が在庫としてたまります</span>
              </label>
              {draft.isStock && (
                <label>
                  繰り返し
                  <select value={draft.repeatType} onChange={(event) => setDraft({ ...draft, repeatType: event.target.value as RepeatType })}>
                    <option value="weekly">毎週</option>
                    <option value="monthly">毎月</option>
                    <option value="single">単発在庫（手で積む）</option>
                  </select>
                </label>
              )}
            </div>
            {/* 在庫にしない項目には繰り返し・曜日・起点日を出さない（死んだUIを置かない） */}
            {draft.isStock && (draft.repeatType === "weekly" || draft.repeatType === "monthly") && (
              <div className="form-grid-2">
                {draft.repeatType === "weekly" ? (
                  <label>
                    曜日
                    <select value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: event.target.value })}>
                      {WEEKDAY_LABELS.map((label, index) => (
                        <option key={label} value={index}>{label}曜日</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label>
                    日にち
                    <input type="number" min={1} max={31} value={draft.monthDay} onChange={(event) => setDraft({ ...draft, monthDay: event.target.value })} />
                  </label>
                )}
                <label>
                  この日から数え始める（任意）
                  <input type="date" value={draft.inventoryStartDate} onChange={(event) => setDraft({ ...draft, inventoryStartDate: event.target.value })} />
                  <span className="field-help">この日以降の対象日だけを在庫として数えます。未入力なら作成日から</span>
                </label>
              </div>
            )}
            <label className="check-label">
              <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
              有効にする
            </label>
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={saveDraft}>保存する</button>
              <button type="button" onClick={() => { setDraft(null); setEditingItemId(null); }}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {enrichTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>記録しました</h3>
            <p>
              {enrichTarget.title}（{enrichTarget.dateLabel}）
            </p>
            <p className="small-note">{enrichTarget.consumedStockEntry ? "よければメモを足せます。空のままで大丈夫" : "よければメモや数量を足せます。どちらも空のままで大丈夫"}</p>
            <label>
              メモ1行（作品名・場所・具体）
              <input value={enrichNote} onChange={(event) => setEnrichNote(event.target.value)} placeholder="例：国宝、〇〇温泉" />
            </label>
            {/* 単発在庫は1件1タイトル前提なので数量は出さない（確定仕様） */}
            {!enrichTarget.consumedStockEntry && (
              <label>
                数量（未入力なら1）
                <input type="number" min={1} inputMode="numeric" value={enrichCount} onChange={(event) => setEnrichCount(event.target.value)} placeholder="例：4" />
              </label>
            )}
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={saveEnrichment}>とじる</button>
              <button type="button" className="subtle-button" onClick={undoEnrichTarget}>記録を取り消す</button>
            </div>
          </div>
        </div>
      )}

      {datePickTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>過去の日付で記録</h3>
            <p>
              {datePickTarget.item.title}
              {datePickTarget.slotDate ? `（${formatDateWithWeekday(datePickTarget.slotDate)}ぶん）` : ""}
              {datePickTarget.stockEntry?.label ? `（${datePickTarget.stockEntry.label}）` : ""}
            </p>
            <label>
              やった日
              <input type="date" value={pickedDate} max={todayLife} onChange={(event) => setPickedDate(event.target.value)} />
            </label>
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={confirmDatePick}>記録する</button>
              <button type="button" onClick={() => setDatePickTarget(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {/* 記録の取り消し（誤タップの救済）。編集機能ではないのでラベルは「取り消す」で統一 */}
      {undoTargetId && (() => {
        const completion = data.completions.find((entry) => entry.id === undoTargetId);
        if (!completion) return null;
        const item = data.items.find((entry) => entry.id === completion.itemId);
        const backNote =
          item && isSingleStockItem(item)
            ? "取り消すと、積みに戻ります。"
            : item && isInventoryItem(item)
              ? "取り消すと、対象日が在庫に戻ります。"
              : "取り消すと、前回の記録が消えます。";
        return (
          <div className="dialog-backdrop">
            <div className="dialog">
              <h3>この記録を取り消しますか？</h3>
              <p>
                {completion.titleSnapshot}（{formatShortDate(doneDateOf(completion))}）
              </p>
              <p className="small-note">{backNote}記録を整える機能ではなく、押し間違いを戻すためのものです。</p>
              <div className="button-row dialog-actions">
                <button type="button" className="danger-button" onClick={() => undoCompletion(undoTargetId)}>取り消す</button>
                <button type="button" onClick={() => setUndoTargetId(null)}>やめる</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 積んだものの取り下げ（記録を作らずに積みから消す） */}
      {withdrawTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>積みから取り下げますか？</h3>
            <p>「{withdrawTarget.label}」を積みから外します。</p>
            <p className="small-note">「楽しんだ」とは違い、完了ログは作られません。読まずにやめたものを、記録を汚さずに消せます。</p>
            <div className="button-row dialog-actions">
              <button type="button" className="danger-button" onClick={() => withdrawEntry(withdrawTarget.entryId)}>取り下げる</button>
              <button type="button" onClick={() => setWithdrawTarget(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {/* 深夜タップの確認（A2）。既定の選択は置かない（押し間違いでそのまま日付が入るのを避けるため） */}
      {nightConfirmTarget && (() => {
        const yesterdayKey = addDaysKey(todayLife, -1);
        const title =
          nightConfirmTarget.kind === "single"
            ? nightConfirmTarget.stockEntry.label || nightConfirmTarget.item.title
            : nightConfirmTarget.item.title;
        return (
          <div className="dialog-backdrop">
            <div className="dialog">
              <h3>昨日と今日、どちらの記録にしますか？</h3>
              <p>{title}</p>
              <p className="small-note">深夜0時〜5時のタップだけ、念のため確認しています。</p>
              <div className="button-row dialog-actions">
                <button type="button" onClick={() => resolveNightConfirm(yesterdayKey)}>昨日（{formatShortDate(yesterdayKey)}）</button>
                <button type="button" onClick={() => resolveNightConfirm(todayLife)}>今日（{formatShortDate(todayLife)}）</button>
              </div>
              <div className="button-row dialog-actions">
                <button type="button" onClick={() => setNightConfirmTarget(null)}>やめる</button>
              </div>
            </div>
          </div>
        );
      })()}

      {deleteTargetId && (() => {
        const item = data.items.find((entry) => entry.id === deleteTargetId);
        const stockCount = data.stockEntries.filter((entry) => entry.itemId === deleteTargetId).length;
        const logCount = data.completions.filter((entry) => entry.itemId === deleteTargetId).length;
        return (
          <div className="dialog-backdrop">
            <div className="dialog">
              <h3>「{item?.title ?? "この項目"}」を削除します</h3>
              {stockCount > 0 && <p>積んだもの {stockCount}件 も一緒に消えます。</p>}
              <p>完了ログ {logCount}件 は残ります（集計にも出ます）。</p>
              <div className="button-row dialog-actions">
                <button type="button" className="danger-button" onClick={() => deleteItem(deleteTargetId)}>削除する</button>
                <button type="button" onClick={() => setDeleteTargetId(null)}>やめる</button>
              </div>
            </div>
          </div>
        );
      })()}

      {deleteGroupTarget && (
        <div className="dialog-backdrop">
          <div className="dialog">
            <h3>グループ「{deleteGroupTarget}」を削除しますか？</h3>
            <p>このグループには項目が入っていません。選択肢から取り除くだけで、これまでの記録（完了ログ・集計）には影響しません。</p>
            <div className="button-row dialog-actions">
              <button type="button" className="danger-button" onClick={() => deleteGroup(deleteGroupTarget)}>削除する</button>
              <button type="button" onClick={() => setDeleteGroupTarget(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}

      {importPreview && (
        <div className="dialog-backdrop">
          <div className="dialog append-import-dialog">
            <h3>追加インポートのプレビュー</h3>
            <p>{importPreview.sourceLabel}</p>
            <div className="import-preview-list">
              {importPreview.counts.map((count) => (
                <div key={count.label} className="import-preview-item">
                  <h3>{count.label}</h3>
                  <dl>
                    <div><dt>読み込み</dt><dd>{count.loaded}</dd></div>
                    <div><dt>追加</dt><dd>{count.added}</dd></div>
                    <div><dt>スキップ（重複）</dt><dd>{count.skipped}</dd></div>
                  </dl>
                </div>
              ))}
            </div>
            {importPreview.adoptDayBoundary && (
              <p className="small-note">日付境界 {importPreview.adoptDayBoundary} も引き継ぎます</p>
            )}
            <div className="button-row dialog-actions">
              <button type="button" className="primary-button" onClick={applyImport}>追加する</button>
              <button type="button" onClick={() => setImportPreview(null)}>やめる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
