import { useRef } from "react";
import { LONG_PRESS_MS } from "./constants";

// ----------------------------- 長押し対応ボタン -----------------------------

export function RecordButton({ label, className, onTap, onLongPress }: { label: string; className: string; onTap: () => void; onLongPress: () => void }) {
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  return (
    <button
      type="button"
      className={className}
      onPointerDown={() => {
        firedRef.current = false;
        clearTimer();
        timerRef.current = window.setTimeout(() => {
          firedRef.current = true;
          onLongPress();
        }, LONG_PRESS_MS);
      }}
      onPointerUp={clearTimer}
      onPointerLeave={clearTimer}
      onPointerCancel={clearTimer}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (firedRef.current) {
          firedRef.current = false;
          return;
        }
        onTap();
      }}
    >
      {label}
    </button>
  );
}
