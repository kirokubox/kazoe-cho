// __BUILD_VERSION__ はビルド時に vite.config.ts のプラグインが版番号へ置換する。
// デプロイごとに sw.js の中身が変わるので、ブラウザが必ず「更新あり」と判定する。
const CACHE_NAME = "kazoe-cho-cache-__BUILD_VERSION__";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/kazoe-cho-icon.svg",
  "./icons/kazoe-cho-maskable.svg",
  "./icons/kazoe-cho-icon-192.png",
  "./icons/kazoe-cho-icon-512.png",
  "./icons/apple-touch-icon.png",
];
const APP_FALLBACK = new URL("index.html", self.registration.scope);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// 新しい SW が waiting になったとき、ページ側（main.tsx）からの合図で即座に切り替える
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // 画面表示（ナビゲーション）はネットワーク優先。オフライン時だけキャッシュへフォールバック
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(APP_FALLBACK, copy));
          return response;
        })
        .catch(() => caches.match(APP_FALLBACK)),
    );
    return;
  }

  // アセットはキャッシュ優先（ファイル名にハッシュ付き。キャッシュ自体が版ごとに切り替わる）
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      });
    }),
  );
});
