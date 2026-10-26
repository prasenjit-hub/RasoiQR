import React, { useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";

// ⏱️ 5-second window to undo a cart removal (Baymard: undo must be salient;
// replacement semantics — the newest removal wins, older ones are final).
const TOAST_VISIBLE_MS = 5000;
const TOAST_TRANSITION_MS = 300;

interface UndoToastProps {
  /** Name of the removed item, e.g. "Coca Cola". */
  itemName: string;
  onUndo: () => void;
  onDismiss: () => void;
}

// 🛒 Bottom-centre undo toast for cart removals. Pinned low so it sits near
// the thumb that just tapped remove; never collides with the order toast.
const UndoToast: React.FC<UndoToastProps> = ({ itemName, onUndo, onDismiss }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => setVisible(true));
    });

    const hideTimer = setTimeout(
      () => setVisible(false),
      TOAST_VISIBLE_MS - TOAST_TRANSITION_MS
    );
    const dismissTimer = setTimeout(onDismiss, TOAST_VISIBLE_MS);

    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
      clearTimeout(hideTimer);
      clearTimeout(dismissTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-6 left-0 right-0 z-[60] px-4 pointer-events-none transition-all duration-300 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <div className="max-w-md mx-auto pointer-events-auto flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 shadow-xl shadow-neutral-900/10">
        <div className="w-9 h-9 flex-shrink-0 rounded-full bg-neutral-100 flex items-center justify-center">
          <Trash2 className="w-4.5 h-4.5 w-[18px] h-[18px] text-neutral-500" />
        </div>
        <p className="flex-1 min-w-0 text-sm font-bold text-neutral-700 truncate">
          {itemName} removed
        </p>
        <button
          onClick={onUndo}
          className="flex items-center gap-1.5 flex-shrink-0 bg-neutral-900 hover:bg-neutral-700 active:scale-95 transition-all text-white text-xs font-extrabold uppercase tracking-wider px-4 py-2.5 rounded-xl"
        >
          <RotateCcw className="w-3.5 h-3.5 stroke-[2.5]" />
          Undo
        </button>
      </div>
    </div>
  );
};

export default UndoToast;
