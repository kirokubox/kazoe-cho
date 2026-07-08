import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Service Worker のキャッシュ名にビルドごとの版番号を刻む。
// GitHub Pages 更新後にスマホで古い画面が残る問題（旧ゆるたすくで発生）への対策で、
// デプロイのたびに sw.js の中身が必ず変わる＝ブラウザが SW を更新として扱うことを保証する。
function stampServiceWorkerVersion(): Plugin {
  let outDir = "dist";
  return {
    name: "stamp-service-worker-version",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const swPath = resolve(outDir, "sw.js");
      const source = readFileSync(swPath, "utf8");
      const version = new Date().toISOString().replace(/[-:.TZ]/g, "");
      writeFileSync(swPath, source.replaceAll("__BUILD_VERSION__", version));
    },
  };
}

export default defineConfig({
  base: "/kazoe-cho/",
  plugins: [react(), stampServiceWorkerVersion()],
});
