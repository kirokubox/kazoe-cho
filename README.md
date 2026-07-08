# かぞえ帳

**「いつから？いくつ？」に一瞬で答える行動台帳。** ゆるたすくの後継アプリ。

- Googleカレンダー＝原本（時刻つきの事実）、Keep＝詳細、本アプリ＝**索引**
- 入れていいのは「やりたいこと」だけ。締切・義務・時間分数は持たない
- 仕様の正本：`05_開発・Webアプリ/10_かぞえ帳/101_かぞえ帳_要件と経緯.md`

## 画面（4タブ）

| タブ | 役割 |
| --- | --- |
| 在庫 | 楽しみ（週刊誌・アニメ等）が何回ぶん溜まっているか。対象日は畳まず全件表示。「楽しんだ」で消す |
| 前回 | 習慣・作業・振り返りの「前回いつ（＋メモ）」一覧。「やった」で前回日が今日に更新 |
| 集計 | 週次・月次の件数と数量（数量未入力は1として集計）。過去期間へ切替可 |
| 設定 | 項目の追加編集、JSON入出力、Markdownエクスポート、日付境界・週開始曜日 |

- 種類（楽しみ/習慣/振り返り/作業）×繰り返しで表示が決まる：**楽しみ×毎週/毎月＝在庫型、それ以外＝前回日型**
- 記録はワンタップで成立。メモ1行と数量は任意（記録直後のダイアログで足せる）
- 「楽しんだ/やった」**長押し**で過去の日付として記録できる（昨日ぶんを今日つける用）
- 日付境界は既定05:00（深夜の記録は前日扱い）。週の締めは既定で月曜始まり

## データ

- 保存は localStorage のみ（キー：`yuki-kazoe-cho-data` / `yuki-kazoe-cho-active-view`）。
  旧ゆるたすく（`yuki-task-manager-data`）と同一端末で共存できる
- クラウド同期なし。端末間の移動は JSONエクスポート → JSON追加インポート（取り込み前に件数プレビュー）
- 旧ゆるたすくのバックアップJSON（task-manager-backup形式）は追加インポートで**自動変換**される
  - 移行対象：recurringTasks・recurringCompletions・dayBoundaryTime・inventoryStartDate（kind「確認」は「習慣」へ）
  - 移行しない：tasks・routineItems・activityGroups・分数系（durationMinutes等）・timeSlot・place
- 完了ログは titleSnapshot 方式：項目を削除・改名してもログと集計は消えない
- **実データはリポジトリに入れない**。`sample-data/kazoe-cho-sample.json` はインポート動作確認用のサンプル

## 開発

```
npm install
npm run dev        # http://127.0.0.1:5173/kazoe-cho/
npm run build      # 型チェック＋本番ビルド（変更後は必ず通す）
```

スマホ実機確認（PCと同一Wi-Fi）：`npm.cmd run dev -- --host 0.0.0.0`

## 公開（GitHub Pages＋PWA）

- `main` に push すると GitHub Actions（`.github/workflows/deploy.yml`）が Pages へ自動デプロイ
- Vite の `base` は `/kazoe-cho/`（リポジトリ名に一致させる）
- PWA：manifest＋Service Worker。ホーム画面に追加してスマホ単独運用する
- **更新の確実な反映**（旧ゆるたすくの「古い画面が残る」問題への対策）：
  - ビルド時に `sw.js` のキャッシュ名へ版番号を刻印（`vite.config.ts` のプラグイン）
  - 画面表示はネットワーク優先、起動時・画面復帰時に更新チェック
  - 新しい Service Worker を検知したら即有効化して一度だけ自動リロード
- 検索避け（`robots.txt`・`noindex`）は外さない
