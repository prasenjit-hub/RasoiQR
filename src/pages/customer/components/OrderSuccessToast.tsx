import React, { useEffect, useRef, useState } from "react";
import { CheckCircle, X } from "lucide-react";

// ⏱️ Timings — the exit transition matches the 300ms transition used by the
// checkout bottom-sheet in CustomerMenu so the toast never outlives the sheet.
const TOAST_VISIBLE_MS = 4000; // auto-dismiss after 4 seconds
const TOAST_TRANSITION_MS = 300; // fade / slide in & out duration

interface OrderSuccessToastProps {
  /** Order number returned by customer_create_order — omitted when unavailable. */
  orderNumber?: string | null;
  /** Table label the server resolved from the QR code; null for takeaway. */
  tableNumber?: string | null;
  onDismiss: () => void;
}

/** "Table 3 • Order #1234" — each half only when we actually have the value. */
const buildContextLine = (
  orderNumber?: string | null,
  tableNumber?: string | null
): string => {
  const parts: string[] = [];
  if (tableNumber) parts.push(`Table ${tableNumber}`);
  if (orderNumber) parts.push(`Order #${orderNumber}`);
  return parts.join(" • ");
};

// 🍽️ Lightweight inline toast — this project has no toast library, and a
// full-screen toast container would be overkill for a single notification.
// Mobile-first: pinned to the top-centre so it never collides with the
// floating cart bar at the bottom.
const OrderSuccessToast: React.FC<OrderSuccessToastProps> = ({
  orderNumber,
  tableNumber,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(false);
  // Keep the latest callback in a ref so the timers below never restart when
  // the parent re-renders (the timer effect must run exactly once).
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    // Double rAF: the browser must paint the hidden state before the visible
    // state is applied, otherwise the enter transition is skipped.
    let innerFrame = 0;
    const outerFrame = requestAnimationFrame(() => {
      innerFrame = requestAnimationFrame(() => setVisible(true));
    });

    const hideTimer = setTimeout(
      () => setVisible(false),
      TOAST_VISIBLE_MS - TOAST_TRANSITION_MS
    );
    const dismissTimer = setTimeout(
      () => dismissRef.current(),
      TOAST_VISIBLE_MS
    );

    return () => {
      cancelAnimationFrame(outerFrame);
      if (innerFrame) cancelAnimationFrame(innerFrame);
      clearTimeout(hideTimer);
      clearTimeout(dismissTimer);
    };
  }, []);

  const contextLine = buildContextLine(orderNumber, tableNumber);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed top-4 left-0 right-0 z-[60] px-4 pointer-events-none transition-all duration-300 ease-out ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-4 opacity-0"
      }`}
    >
      <div className="max-w-md mx-auto pointer-events-auto flex items-center gap-3 rounded-2xl border border-emerald-100 bg-white px-4 py-3.5 shadow-xl shadow-emerald-900/10">
        <div className="w-10 h-10 flex-shrink-0 rounded-full bg-emerald-50 flex items-center justify-center">
          <CheckCircle className="w-6 h-6 text-emerald-500 stroke-[2.5]" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-extrabold text-neutral-800 leading-tight">
            Order placed successfully!
          </p>
          {contextLine && (
            <p className="mt-0.5 text-xs font-bold text-neutral-400 truncate">
              {contextLine}
            </p>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="w-7 h-7 flex-shrink-0 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
        >
          <X className="w-3.5 h-3.5 stroke-[2.5]" />
        </button>
      </div>
    </div>
  );
};

export default OrderSuccessToast;
