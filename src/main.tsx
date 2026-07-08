import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// PWA: Service Worker の登録と「更新が確実に反映される」仕組み。
// 旧ゆるたすくで「GitHub Pages 更新後もスマホに古い画面が残る」問題があったため、
// 1) 起動時・画面復帰時に必ず更新チェック
// 2) 新しい SW が待機状態になったら SKIP_WAITING を送って即座に有効化
// 3) SW が切り替わったら一度だけ自動リロード
// の3点をセットで入れている。
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .then((registration) => {
        const promoteWaitingWorker = () => {
          registration.waiting?.postMessage({ type: "SKIP_WAITING" });
        };
        promoteWaitingWorker();
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              promoteWaitingWorker();
            }
          });
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            registration.update().catch(() => {});
          }
        });
      })
      .catch((error) => {
        console.warn("Service Worker registration failed:", error);
      });

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}
