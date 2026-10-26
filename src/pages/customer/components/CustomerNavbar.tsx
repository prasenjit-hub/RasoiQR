import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, ClipboardList, Loader2, UtensilsCrossed } from "lucide-react";
import {
  getWaiterCallStatus,
  type WaiterCallResult,
} from "../../../services/restaurantService";

interface CustomerNavbarProps {
  /** Shown in the middle slot when the customer is not at a table (takeaway). */
  restaurantName?: string;
  /**
   * The table's label, resolved by the server from the QR code (`?t=<code>`).
   * Dine-in only — a Master-QR guest has no table.
   */
  tableNumber?: string;
  onOrders: () => void;
  /**
   * Places a real waiter call (migration 036). Reject with an `Error` to put the
   * button into its retry state; resolve with the created/deduped call so the
   * bar can poll it and tell the customer when staff has picked it up.
   *
   * Omit it entirely and the button is not rendered: calling a waiter only means
   * something from a table QR, so a takeaway customer (Master QR) sees the
   * restaurant name in that slot instead of a control that cannot work.
   */
  onCallWaiter?: () => Promise<WaiterCallResult | void>;
}

/** One waiter call per minute — a client-side courtesy, not the throttle. The
 *  real cap is 6 calls per table per hour inside `customer_call_waiter`. */
const COOLDOWN_SECONDS = 60;

/** How often to ask whether staff has acknowledged the open call. */
const POLL_INTERVAL_MS = 15_000;

/**
 * idle          → nothing called yet (or the call was closed by staff)
 * calling       → request in flight, button disabled
 * notified      → staff has been pinged; still unattended
 * acknowledged  → a member of staff claimed it and is on the way
 * error         → the request failed; no cooldown was started, so retry is free
 */
type CallState = "idle" | "calling" | "notified" | "acknowledged" | "error";

/**
 * Sticky customer action bar.
 *
 * Left  — Call Waiter, Middle — table (or restaurant name on takeaway),
 * Right — Track Orders. Keeps the two things a seated customer needs most in
 * the thumb zone at all times, instead of only at the top of a long menu.
 */
const CustomerNavbar: React.FC<CustomerNavbarProps> = ({
  restaurantName,
  tableNumber,
  onOrders,
  onCallWaiter,
}) => {
  const [cooldown, setCooldown] = useState(0);
  const [callState, setCallState] = useState<CallState>("idle");
  const [callId, setCallId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCooldown = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setCooldown(COOLDOWN_SECONDS);
    timerRef.current = setInterval(() => {
      setCooldown((seconds) => {
        if (seconds <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return seconds - 1;
      });
    }, 1000);
  }, []);

  const handleCallWaiter = async () => {
    if (!onCallWaiter || callState === "calling" || cooldown > 0) return;

    // While a call is already open the button stays tappable on purpose: the
    // RPC dedupes, so a second tap returns the same row instead of stacking
    // another request — and a customer who taps again gets confirmation rather
    // than a dead button.

    setCallState("calling");
    setErrorMessage(null);

    try {
      const result = await onCallWaiter();
      if (!mountedRef.current) return;

      setCallId(result?.id ?? null);
      setCallState(result?.status === "acknowledged" ? "acknowledged" : "notified");
      startCooldown();
    } catch (err) {
      if (!mountedRef.current) return;

      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Could not reach the restaurant. Please try again."
      );
      // No cooldown on failure — a dead request must not cost the customer a
      // minute of silence. The error label is the retry affordance.
      setCallState("error");
    }
  };

  // Watch the call we opened. Staff acknowledgement is worth telling the
  // customer about (it is the difference between "I asked" and "someone is
  // coming"); a resolved/cancelled call frees the button again.
  useEffect(() => {
    if (!callId || (callState !== "notified" && callState !== "acknowledged")) {
      return;
    }

    let cancelled = false;
    const check = async () => {
      const status = await getWaiterCallStatus(callId);
      if (cancelled || !mountedRef.current) return;

      if (status === "acknowledged") {
        setCallState((current) => (current === "notified" ? "acknowledged" : current));
      } else if (status && status !== "pending") {
        // resolved or cancelled — the visit is over, let them call again.
        setCallId(null);
        setCallState("idle");
      }
    };

    const interval = setInterval(() => {
      void check();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [callId, callState]);

  const busy = callState === "calling";
  const waitingOnStaff = callState === "notified" || callState === "acknowledged";
  // `cooldown` is the only thing that locks the button besides the in-flight
  // request: it starts on success, so an open call always shows as reachable.
  const disabled = busy || cooldown > 0;

  const waiterLabel = busy
    ? "Calling…"
    : callState === "acknowledged"
    ? "On the way"
    : callState === "notified"
    ? "Notified"
    : callState === "error"
    ? "Retry"
    : "Waiter";

  const waiterAriaLabel = busy
    ? "Calling a waiter"
    : callState === "acknowledged"
    ? "A waiter is on the way"
    : callState === "notified"
    ? "Waiter already notified"
    : callState === "error"
    ? `Call failed. ${errorMessage ?? "Please try again."}`
    : "Call a waiter";

  return (
    <nav
      aria-label="Customer actions"
      className="sticky top-0 z-40 h-14 bg-white/95 backdrop-blur-md border-b border-gray-100 shadow-sm"
    >
      {/* ⚖️ Grid, not `flex justify-between`. With `justify-between` the two
          side pills are content-sized, so the leftover space is shared between
          the two gaps and the middle slot only *looks* centred while the pills
          happen to be the same width. Tapping Waiter swaps "Waiter" (84px) for
          "On the way" (110px), which dragged the table label ~17px to the right
          mid-tap. Three equal tracks pin the middle slot to the true centre
          whatever the pills say.

          All three are `minmax(0,1fr)` and none is `auto`: an `auto` middle
          track sizes itself to its own content, so the percentage cap on the
          label below resolved circularly and a long name instead widened the
          track until it slid under the Orders pill. */}
      <div className="max-w-xl mx-auto h-full px-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
        {onCallWaiter && (
          <button
            type="button"
            onClick={handleCallWaiter}
            disabled={disabled}
            title={callState === "error" ? errorMessage ?? undefined : undefined}
            aria-label={waiterAriaLabel}
            // The bar carries exactly one loud element: solid amber (Orders). This
            // is the secondary *action* so it stays an outlined button, while the
            // table beside it is a flat label (status, not a control) — which is
            // what keeps the two apart at a glance. Don't take this any lighter
            // though: a gray-50 fill on the white bar reads as ghosted/disabled,
            // so the definition comes from border + shadow + near-black label.
            // Error keeps the same outlined shape in red — a shape change here
            // would read as a different control instead of a retry.
            // `max-[359px]:` trims the pill's padding + icon gap below 360px, where
            // the three equal tracks shrink to ~91px and the widest label
            // ("On the way", 110px pill) would otherwise graze the table label by
            // ~2px. At 360px and up nothing here applies — the pill keeps its
            // roomy `px-3`.
            className={`col-start-1 justify-self-start flex items-center gap-1.5 max-[359px]:gap-1 rounded-full border px-3 max-[359px]:px-2 py-2.5 text-xs font-extrabold whitespace-nowrap transition-colors active:scale-95 ${
              waitingOnStaff
                ? "bg-emerald-600 border-emerald-500 text-white"
                : callState === "error"
                ? "bg-white border-red-300 text-red-700 shadow-sm hover:bg-red-50"
                : "bg-white border-gray-300 text-gray-900 shadow-sm hover:bg-gray-100 hover:border-gray-400"
            } ${busy ? "opacity-80 cursor-wait" : ""}`}
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : waitingOnStaff ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <Bell className="w-3.5 h-3.5" />
            )}
            <span>{waiterLabel}</span>
          </button>
        )}

        {tableNumber ? (
          // Status, not a control (a span — tapping it does nothing), and not a
          // pill either: the two real controls in this bar are rounded-full, so a
          // chip here read as tappable. The label stays plain text and the accent
          // is a thin emerald rule *underneath* it — the rule stretches to
          // whatever the label is ("Table 5" / "Table 12") and there is no shape
          // around the text for anyone to try tapping.
          // `max-w-full`, not `w-full`: this label is a status, not a control, so
          // it stays hugging its text (and the emerald rule hugs with it). The cap
          // only bites on a pathological label, where it lets the inner
          // `truncate` clip instead of pushing the label under the pills.
          <span className="col-start-2 max-w-full justify-self-center flex min-w-0 flex-col items-stretch gap-[3px] whitespace-nowrap">
            <span className="flex min-w-0 items-center gap-1.5">
              <UtensilsCrossed className="h-4 w-4 shrink-0 text-emerald-600" />
              <span className="min-w-0 truncate text-sm font-extrabold text-gray-900">
                Table {tableNumber}
              </span>
            </span>
            <span className="h-[3px] rounded-full bg-emerald-400" aria-hidden="true" />
          </span>
        ) : (
          restaurantName && (
            <span className="col-start-2 max-w-full justify-self-center truncate text-center text-sm font-extrabold text-gray-900">
              {restaurantName}
            </span>
          )
        )}

        <button
          type="button"
          onClick={onOrders}
          // Dark label on the amber fill, not white: white on amber-500 is only
          // 2.15:1 (fails WCAG AA for 12px text) while gray-900 reaches 8.35:1.
          // The neutral gray border matches the Waiter button, so both controls
          // sit on the same edge language.
          aria-label="Track your orders"
          className="col-start-3 justify-self-end flex items-center gap-1.5 rounded-full border border-gray-300 bg-amber-500 px-3 py-2.5 text-xs font-extrabold text-gray-900 whitespace-nowrap transition-transform active:scale-95"
        >
          <ClipboardList className="w-3.5 h-3.5" />
          <span>Orders</span>
        </button>
      </div>
    </nav>
  );
};

export default CustomerNavbar;
