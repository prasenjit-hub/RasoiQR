import React, { useEffect, useRef, useState } from "react";
import { UtensilsCrossed, ShoppingBag, UserRound, Phone } from "lucide-react";
import { Alert, BottomSheet, Button, Input } from "../../../components/ui";
import {
  createOrderAsCustomer,
  getOrderPaymentInfo,
  getRestaurantPaymentOptions,
  type RestaurantPaymentOptions,
} from "../../../services/restaurantService";
import { formatCurrency, isValidPhone, newIdempotencyRef } from "../../../utils/helpers";
import type { CartItem } from "../CustomerMenu";
import { persistentStorage } from "../../../utils/persistentStorage";
import { useIdleShake } from "../../../utils/useIdleShake";
import { isTurnstileEnabled } from "../../../services/turnstile";
import TurnstileWidget from "./TurnstileWidget";

// 👋 The checkout CTA nudges sooner than the cart's (5s vs 10s): the guest is
// on the last step with the form already in front of them, so a shorter pause
// is a genuine stall rather than browsing.
const CHECKOUT_IDLE_MS = 5_000;

// How long a tapped "Place Order" waits for Cloudflare's token before giving up.
// On a phone the widget is often still solving in the background when the guest
// taps, and refusing that tap made them tap twice for no reason. Waiting is
// invisible when the token is already there and rarely costs more than a moment.
const TURNSTILE_WAIT_MS = 6_000;

// ---- Customer identity persistence (repeat-customer auto-fill) ----
// ONLY name + phone are persisted. The table is NEVER stored — it always comes
// fresh from the table's QR code (?t=<code>) on every scan, and the server is
// the one that resolves that code into a table (migration 045).
const CUSTOMER_NAME_KEY = "rasoiqr:customer:name";
const CUSTOMER_PHONE_KEY = "rasoiqr:customer:phone";
const IDENTITY_SAVE_DEBOUNCE_MS = 500;

/** @throws if storage is unavailable (private mode) — caller must catch. */
const readIdentity = (): { name: string; phone: string } => {
  return {
    name: (persistentStorage.getItem(CUSTOMER_NAME_KEY) ?? "").trim(),
    phone: (persistentStorage.getItem(CUSTOMER_PHONE_KEY) ?? "").trim(),
  };
};

/** Skips blank values; @throws if storage is unavailable — caller must catch. */
const writeIdentity = (name: string, phone: string) => {
  const trimmedName = name.trim();
  const trimmedPhone = phone.trim();
  if (trimmedName) {
    persistentStorage.setItem(CUSTOMER_NAME_KEY, trimmedName);
  }
  if (trimmedPhone) {
    persistentStorage.setItem(CUSTOMER_PHONE_KEY, trimmedPhone);
  }
};

// ---- Order failure messages (audit P1-4) ----
// The database is the source of truth for WHY an order was refused, and the
// remaining refusals are permanent — "try again" would loop forever. Map the
// known server messages to something the customer can actually act on.
// Exported so it can be unit-tested without rendering the sheet.
export const customerOrderErrorMessage = (serverMessage?: string): string => {
  const message = (serverMessage ?? "").toLowerCase();

  // Permanent: the restaurant is closed to online ordering (trial expired, or
  // blocked by an admin). Retrying cannot help.
  if (
    message.includes("trial expired") ||
    message.includes("not found or inactive")
  ) {
    return "This restaurant isn't accepting online orders right now. Please order with the staff.";
  }
  // The ONLY rate-limit refusal left is the PHONE cap (migrations 040/041): the
  // number belongs to the person ordering, so it can only spend their own quota.
  // Two refusals were deliberately removed and must not come back without a
  // refusal path to match:
  //   · migration 042 — no restaurant-wide "kitchen is busy" refusal. The
  //     5-minute burst is alert-only now: it applied to every guest at the
  //     venue, so 30 cheap orders from an attacker were enough to have real
  //     ones refused.
  //   · migration 043 — no per-table refusal. `table_number` is shared by every
  //     guest at that table and is client-supplied, so it refused large parties
  //     ordering on separate phones and could be used to lock a real table.
  //     045 made the table server-verified (a per-table code), which removes the
  //     second half of that objection — but not the first: a table is still
  //     shared, and the code is still copyable. No cap is back.
  if (message.includes("too many orders from this mobile number")) {
    return "This mobile number has already placed several orders. Please ask a member of staff for help.";
  }
  // Migration 045: the table now comes from a CODE in the QR, and it fails in
  // exactly two ways — no code at all (Master QR, or a stale bundle still
  // sending a table number), or a code the server no longer knows (rotated or
  // stopped table). Both are fixed by rescanning the table's own standee.
  if (message.includes("need the qr code from your table")) {
    return "Dine-in ordering needs the QR code from your table. Please scan the QR code on your table, or choose Takeaway.";
  }
  if (message.includes("qr code is no longer valid")) {
    return "This table's QR code isn't valid any more. Please ask a member of staff, or choose Takeaway.";
  }
  if (message.includes("unavailable menu item")) {
    return "One of your items just became unavailable. Please refresh the menu and try again.";
  }
  if (message.includes("invalid size") || message.includes("invalid addon")) {
    return "One of your item options is out of date. Please refresh the menu and try again.";
  }
  if (message.includes("at least one item")) {
    return "Your cart is empty. Please add an item before ordering.";
  }
  // Migration 050: the owner can change the two switches while a checkout is
  // open. Both refusals name the action the guest can take.
  if (message.includes("does not accept upi prepaid")) {
    return "This restaurant isn't taking UPI prepaid orders right now. Please choose Pay at counter, or ask a member of staff.";
  }
  if (message.includes("accepts upi prepaid orders only")) {
    // Reachable when the options fetch failed (the selector never appeared) or
    // the owner switched to UPI-only while this checkout was open. Both need a
    // refresh to get the selector back.
    return "This restaurant is taking UPI prepaid orders only right now. Please refresh the page and choose Pay now via UPI.";
  }
  if (message.includes("invalid payment method")) {
    return "Please choose how you'd like to pay and try again.";
  }

  // Network-level failures reach this function as an error object too (the
  // Supabase client turns a rejected fetch into `{ data: null, error }`), so
  // the ambiguous case has to be handled HERE, not only in the catch block.
  // A dropped connection cannot tell us whether the order committed, and
  // saying "could not place order" would be a lie half the time. Retrying is
  // safe either way — migration 039 replays instead of duplicating.
  if (/failed to fetch|networkerror|load failed|network request failed|fetch/i.test(message)) {
    return "We couldn't confirm your order — the connection dropped. Please check your orders, then try again; retrying won't create a duplicate.";
  }

  // The Turnstile gate in front of the order (supabase/functions/submit-order).
  // A token that failed is almost always a token that was already spent — the
  // guest who tapped twice, or whose response was lost — so this copy has to
  // point at their orders as well as at a retry. 039 makes the retry replay the
  // order instead of creating a second one.
  if (message.includes("security check")) {
    return "We couldn't finish the quick security check. Please check your orders, then try again — retrying won't create a duplicate.";
  }
  // Misconfigured deployment (no TURNSTILE_SECRET_KEY). Permanent by nature, so
  // it must not say "try again" — that would loop until the admin acts.
  if (message.includes("not configured on this server")) {
    return "Online ordering is temporarily unavailable. Please order with a member of staff.";
  }

  return "Could not place order. Please try again.";
};

/** Everything the parent needs to close the sheet, clear the cart and toast. */
export interface PlacedOrderInfo {
  /** Row id of the created order (used to remember it for the tracking page). */
  orderId: string | null;
  /** Human-friendly order number, when the RPC returns one. */
  orderNumber: string | null;
  /**
   * Table number for dine-in (the label the SERVER resolved from the QR code);
   * null for takeaway / Master-QR orders.
   */
  tableNumber: string | null;
  /**
   * Migration 050: the order is UPI prepaid, so the parent must open the
   * payment sheet instead of just toasting. Read back from the server, not
   * inferred — the server is the authority on what was stored.
   */
  paymentRequired: boolean;
}

// Checkout Panel Component (Slide-up Content)
interface CheckoutContentProps {
  isOpen: boolean;
  cart: CartItem[];
  restaurantId: string;
  /** Migration 050: used to ask what payment options the owner turned on. */
  slug: string;
  /**
   * Migration 045: the table is identified by the CODE its QR carries
   * (`?t=<code>`). Present only when the server resolved it — an unknown or
   * rotated code leaves this undefined and the sheet in takeaway mode.
   */
  tableCode?: string | null;
  /** The label the server resolved from that code ("5"), shown to the guest. */
  tableLabel?: string | null;
  onClose: () => void;
  /**
   * Fired ONLY after the order was created server-side. The parent owns the
   * sheet, so it closes it (300ms slide-down + backdrop fade), clears the cart
   * and shows the success toast. Never called on failure.
   */
  onSuccess: (order: PlacedOrderInfo) => void;
}

const CheckoutContent: React.FC<CheckoutContentProps> = ({
  isOpen,
  cart,
  restaurantId,
  slug,
  tableCode,
  tableLabel,
  onClose,
  onSuccess,
}) => {
  // A resolved table code → both order types. Master QR or a code the server did
  // not recognise → Takeaway only, because the order RPC refuses dine-in without
  // a code the server itself resolved. There is no "type your table number"
  // escape hatch any more: that number was never verifiable.
  const hasTableContext = Boolean(tableCode && tableLabel);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [orderType, setOrderType] = useState<"table" | "takeaway">(
    hasTableContext ? "table" : "takeaway"
  );
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);

  // Migration 050 — the owner's switches decide what this section shows.
  // `null` while loading; a failure falls back to cash, never blocks ordering.
  const [paymentOptions, setPaymentOptions] = useState<RestaurantPaymentOptions | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<"counter" | "upi">("counter");

  // ---- Turnstile (bot gate, optional) --------------------------------------
  // `nonce` is the widget's React key: bumping it remounts the widget, which is
  // how a spent token is replaced. A token is single-use and lives 300 s, so the
  // _previous_ attempt's token is dead the moment it is used — remounting on a
  // failed submit and on every open is what keeps the next attempt carrying a
  // fresh one. `tokenRef` mirrors the state so the submit handler can read the
  // current value without a stale closure.
  const [turnstileNonce, setTurnstileNonce] = useState(0);
  const [turnstileUnavailable, setTurnstileUnavailable] = useState(false);
  // True while a tapped submit is waiting for the token. It disables the CTA so
  // the wait cannot be paid for with a second tap.
  const [waitingForToken, setWaitingForToken] = useState(false);
  const turnstileTokenRef = useRef<string | null>(null);
  const tokenWaiters = useRef<Array<(token: string | null) => void>>([]);

  // Resolve everyone waiting for a token the moment one (dis)appears, so the
  // submit continues immediately instead of sitting out the whole timeout.
  const settleTokenWaiters = (token: string | null) => {
    const waiters = tokenWaiters.current;
    tokenWaiters.current = [];
    waiters.forEach((resolve) => resolve(token));
  };

  const waitForToken = (timeoutMs: number) =>
    new Promise<string | null>((resolve) => {
      if (turnstileTokenRef.current) {
        resolve(turnstileTokenRef.current);
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (token: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tokenWaiters.current = tokenWaiters.current.filter((w) => w !== finish);
        resolve(token);
      };

      timer = setTimeout(() => finish(null), timeoutMs);
      tokenWaiters.current.push(finish);
    });

  // A ref, not state: the token is read imperatively at submit time and nothing
  // on screen depends on it, so re-rendering the whole sheet every time
  // Cloudflare refreshes a token would be pure cost.
  const handleTurnstileToken = (token: string | null) => {
    turnstileTokenRef.current = token;
    settleTokenWaiters(token);
  };

  const resetTurnstile = () => {
    turnstileTokenRef.current = null;
    settleTokenWaiters(null);
    setTurnstileUnavailable(false);
    setTurnstileNonce((n) => n + 1);
  };

  // 👋 PLACE ORDER shakes after 5s of stillness while this sheet is open, then
  // every 5s after that — the same nudge as the Crave-box CTA, at this step's
  // tighter interval. Typing or tapping restarts the clock.
  const ctaNudging = useIdleShake(isOpen, CHECKOUT_IDLE_MS);

  // 🔁 Idempotency (migration 039): the reference that makes a retried submit
  // return the order it already created instead of cooking it twice. It is
  // keyed on the payload, so two taps of the same unchanged form reuse one
  // reference (the retry case), while any edit — cart, name, phone, notes,
  // order type, table — mints a fresh one (a genuinely new order).
  const attemptRef = useRef<{ key: string; ref: string } | null>(null);

  const clientRefFor = (key: string): string => {
    if (attemptRef.current?.key === key) return attemptRef.current.ref;
    const ref = newIdempotencyRef();
    attemptRef.current = { key, ref };
    return ref;
  };

  // ---- Repeat-customer auto-fill (name + phone only, NEVER table number) ----
  // Debounce timers as refs so each keystroke resets the previous save.
  const nameSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phoneSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleNameChange = (value: string) => {
    setCustomerName(value);
    if (nameSaveTimer.current) clearTimeout(nameSaveTimer.current);
    nameSaveTimer.current = setTimeout(() => {
      try {
        writeIdentity(value, "");
      } catch {
        // Storage unavailable — ignore.
      }
    }, IDENTITY_SAVE_DEBOUNCE_MS);
  };

  const handlePhoneChange = (value: string) => {
    setCustomerPhone(value);
    if (phoneSaveTimer.current) clearTimeout(phoneSaveTimer.current);
    phoneSaveTimer.current = setTimeout(() => {
      try {
        writeIdentity("", value);
      } catch {
        // Storage unavailable — ignore.
      }
    }, IDENTITY_SAVE_DEBOUNCE_MS);
  };

  // Clear any stale error ONLY when the sheet transitions from closed to open
  useEffect(() => {
    if (isOpen && !prevIsOpen) {
      setError("");
    }
    setPrevIsOpen(isOpen);
  }, [isOpen, prevIsOpen]);

  // Migration 050 — fetched per open, because the owner can change the switches
  // between two guests. A failure is not fatal: cash is the fallback, and the
  // order RPC refuses a method the restaurant no longer accepts.
  useEffect(() => {
    if (!isOpen || !slug) return;

    let cancelled = false;
    setPaymentOptions(null);

    void getRestaurantPaymentOptions(slug).then((options) => {
      if (cancelled || !options) return;
      setPaymentOptions(options);
      // One enabled option is not a choice: fixing the method here keeps the
      // request honest, because the order RPC refuses a method the owner has
      // switched off. UI never shows this — it only picks the CTA wording.
      setPaymentMethod(options.accepts_cash ? "counter" : "upi");
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen, slug]);

  // If the table context ever disappears (code rotated or rejected while the
  // page was open), fall back to Takeaway so Dine-in is never left selected
  // under a guest who cannot then place the order.
  // Uses React's adjust-state-during-render pattern (no setState in an effect).
  const [prevHasTable, setPrevHasTable] = useState(hasTableContext);
  if (hasTableContext !== prevHasTable) {
    setPrevHasTable(hasTableContext);
    if (!hasTableContext) {
      setOrderType((prev) => (prev === "table" ? "takeaway" : prev));
    }
  }

  // Pre-fill name + phone on EVERY closed→open transition (render-time adjust —
  // same pattern as above). After "Order More" the fields are blank again, so the
  // next open re-reads storage. Table number is NOT touched here.
  const [prefilledIsOpen, setPrefilledIsOpen] = useState(isOpen);
  if (isOpen !== prefilledIsOpen) {
    setPrefilledIsOpen(isOpen);
    if (isOpen) {
      try {
        const saved = readIdentity();
        if (saved.name) setCustomerName(saved.name);
        if (saved.phone) setCustomerPhone(saved.phone);
      } catch {
        // Private mode / storage unavailable — fields just stay blank.
      }
      // A fresh open is a fresh order attempt, and the last attempt's Turnstile
      // token was spent by it — so hand the widget a new key here, not only on
      // failure. Without this, "Order More" after a successful order would
      // submit a dead token and read the refusal as a failure.
      if (isTurnstileEnabled) {
        turnstileTokenRef.current = null;
        setTurnstileUnavailable(false);
        setTurnstileNonce((n) => n + 1);
      }
    }
  }

  // Clears pending debounced saves if the sheet unmounts (e.g. menu change).
  useEffect(() => {
    return () => {
      if (nameSaveTimer.current) clearTimeout(nameSaveTimer.current);
      if (phoneSaveTimer.current) clearTimeout(phoneSaveTimer.current);
    };
  }, []);

  const subtotal = cart.reduce(
    (sum, item) => sum + item.itemTotal * item.quantity,
    0
  );
  const total = subtotal;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!customerName.trim()) {
      setError("Please write down your name to identify your plates!");
      return;
    }

    if (!isValidPhone(customerPhone)) {
      setError("Please check you have entered a valid 10-digit mobile number");
      return;
    }

    if (orderType === "table" && !hasTableContext) {
      setError("Please scan the QR code on your table to order for that table.");
      return;
    }

    // The bot gate, when configured. Checked here rather than letting the server
    // reject it so the guest gets an actionable sentence instead of "could not
    // place order" — and so nothing is written while the check is still running.
    if (isTurnstileEnabled) {
      if (turnstileUnavailable) {
        setError(
          "We couldn't load the quick security check. Please turn off any ad blocker for this site, then try again."
        );
        return;
      }
      if (!turnstileTokenRef.current) {
        // The widget is usually still solving when the guest taps. Wait for its
        // token instead of turning that tap into an error they must repeat.
        setWaitingForToken(true);
        const token = await waitForToken(TURNSTILE_WAIT_MS);
        setWaitingForToken(false);
        if (!token) {
          setError("One moment — finishing the security check. Please tap Place Order again.");
          return;
        }
      }
    }

    setLoading(true);

    try {
      // 🔁 The attempt key mirrors exactly what the server is told. Only the
      // values that change the order itself belong in it — a re-render or a
      // caret move must not mint a new reference, or a retry would double-order
      // again.
      const attemptKey = JSON.stringify({
        orderType,
        // A different method is a different order attempt, so it gets a fresh
        // idempotency reference (039) instead of replaying the old one.
        paymentMethod,
        tableCode: orderType === "table" ? tableCode : null,
        name: customerName.trim(),
        phone: customerPhone.trim(),
        notes: notes.trim(),
        items: cart.map((item) => ({
          menu_item_id: item.id,
          quantity: item.quantity,
          selected_size: item.selectedSize ?? null,
          selected_addons: item.selectedAddons,
        })),
      });

      const { data, error: orderError } = await createOrderAsCustomer({
        restaurantId,
        orderType: orderType === "table" ? "qr" : "counter",
        paymentMethod,
        tableCode: orderType === "table" ? tableCode ?? undefined : undefined,
        customerName,
        customerPhone,
        customerNotes: notes,
        clientRef: clientRefFor(attemptKey),
        turnstileToken: isTurnstileEnabled ? turnstileTokenRef.current : null,
        items: cart.map((item) => ({
          menu_item_id: item.id,
          quantity: item.quantity,
          selected_size: item.selectedSize ?? null,
          selected_addons: item.selectedAddons,
        })),
      });

      if (!orderError && data && Array.isArray(data) && data.length > 0) {
        // Redundant safety save on successful order (name + phone only).
        try {
          writeIdentity(customerName, customerPhone);
        } catch {
          // Storage unavailable — ignore; the debounced saves likely persisted it.
        }

        // The method is stored on the order; read it back rather than trusting
        // the local state. A failed read must not fail an order that already
        // exists, so it falls back to the choice we sent.
        const paymentInfo = data[0].order_id
          ? await getOrderPaymentInfo(data[0].order_id)
          : null;

        const placed: PlacedOrderInfo = {
          orderId: data[0].order_id ?? null,
          orderNumber: data[0].order_number ?? null,
          tableNumber: orderType === "table" ? tableLabel ?? null : null,
          paymentRequired: paymentInfo?.payment_required ?? paymentMethod === "upi",
        };

        // This attempt is spent: forget its reference so the next order starts
        // clean even if the cart happens to end up looking identical.
        attemptRef.current = null;

        // Hand off to the parent — it slides the sheet down (~300ms) while the
        // backdrop fades out, clears the cart, hides the cart bar and toasts.
        resetForm();
        onSuccess(placed);
      } else {
        // Failure → sheet stays open, form values and cart stay untouched.
        // The server message decides the copy, so a permanent refusal (expired
        // trial / blocked restaurant) no longer reads as "try again" (audit P1-4).
        console.error("customer_create_order failed:", orderError);
        setError(customerOrderErrorMessage(orderError?.message));
        // This attempt spent its Turnstile token, valid or not. Replace it now,
        // so the retry the message just invited carries a fresh one.
        if (isTurnstileEnabled) resetTurnstile();
      }
    } catch (unexpected) {
      // Network hiccup / unexpected throw. Deliberately NOT "could not place
      // order": the request may have committed and the response been lost, so
      // the honest message is "unconfirmed". Retrying is safe either way —
      // migration 039 replays the same order instead of creating a second one.
      console.error("customer_create_order threw:", unexpected);
      setError(
        "We couldn't confirm your order. Please check your orders, then try again — retrying won't create a duplicate."
      );
      // Same reason as the branch above: the token went out with a request that
      // may or may not have landed, so it is no longer usable either way.
      if (isTurnstileEnabled) resetTurnstile();
    } finally {
      // Always re-enable the Place Order button.
      setLoading(false);
    }
  };

  // Called once the order is safely in the DB: the sheet closes right away, so
  // stale notes never leak into the next order. Name + phone are re-loaded from
  // storage by the prefill block above the next time the sheet opens.
  const resetForm = () => {
    setCustomerName("");
    setCustomerPhone("");
    setNotes("");
    setOrderType(hasTableContext ? "table" : "takeaway");
  };

  // The table is confirmed by the server before this sheet opens, so it belongs
  // in the header line — the old standalone paragraph spent a whole row saying
  // the same thing.
  return (
    <BottomSheet
      open={isOpen}
      onClose={onClose}
      title="Review Order"
      subtitle={
        hasTableContext
          ? `Table ${tableLabel} · scanned from the QR`
          : "Takeaway order"
      }
      maxHeightClass="max-h-[90vh]"
    >
      <form
        id="checkout-form"
        onSubmit={handleSubmit}
        className="flex-1 overflow-y-auto p-6 space-y-6"
      >
        {error && <Alert type="error" message={error} />}

        {/* Order Type */}
        <div>
          <p className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">Order Type</p>
          <div className={`grid gap-3 ${hasTableContext ? "grid-cols-2" : "grid-cols-1"}`}>
            {hasTableContext && (
            <button
              type="button"
              onClick={() => setOrderType("table")}
              aria-pressed={orderType === "table"}
              className={`p-4 rounded-2xl border-2 font-bold transition-all text-xs flex flex-col items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 ${
                orderType === "table"
                  ? "border-amber-500 bg-amber-50/40 text-amber-900 shadow-sm"
                  : "border-gray-200 hover:border-neutral-300 text-neutral-500 bg-white"
              }`}
            >
              <UtensilsCrossed className="w-5 h-5" strokeWidth={2} />
              <span>Dine In (Table)</span>
            </button>
            )}
            <button
              type="button"
              onClick={() => setOrderType("takeaway")}
              aria-pressed={orderType === "takeaway"}
              className={`p-4 rounded-2xl border-2 font-bold transition-all text-xs flex flex-col items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 ${
                orderType === "takeaway"
                  ? "border-amber-500 bg-amber-50/40 text-amber-900 shadow-sm"
                  : "border-gray-200 hover:border-neutral-300 text-neutral-500 bg-white"
              }`}
            >
              <ShoppingBag className="w-5 h-5" strokeWidth={2} />
              <span>Takeaway / Parcel</span>
            </button>
          </div>
        </div>

        {/* Payment — rendered only when the owner has BOTH options on, because
            then it is a real decision for this guest. With one option the
            restaurant has already answered it, so the whole section (heading,
            loading text, failure text) is omitted and the CTA alone carries the
            consequence: "Place Order & Pay" for prepaid UPI, "Place Order" for
            cash. Adding a one-line explanation here only made the sheet taller
            and repeated what the button already said.

            Deliberately a segmented control, not two cards: payment is one
            binary decision, and the card treatment read as a second copy of
            Order Type while claiming ~120px of an already tall sheet. */}
        {paymentOptions?.accepts_cash && paymentOptions.accepts_upi_prepaid && (
          <div>
            <p className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
              Payment
            </p>

            {/* One sliding thumb instead of two buttons that swap colour. Both
                the track and the thumb are fully rounded, so the corners match
                by construction, and the selection glides from one option to the
                other. The thumb is purely visual: the buttons keep the real hit
                area and aria-pressed. */}
            <div
              role="group"
              aria-label="Payment method"
              className="relative flex rounded-full bg-neutral-100 p-1"
            >
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ease-out motion-reduce:transition-none ${
                  paymentMethod === "upi" ? "translate-x-full" : "translate-x-0"
                }`}
              />
              <button
                type="button"
                onClick={() => setPaymentMethod("counter")}
                aria-pressed={paymentMethod === "counter"}
                className={`relative z-10 flex-1 rounded-full px-3 py-2.5 text-xs font-bold transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 ${
                  paymentMethod === "counter"
                    ? "text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-700"
                }`}
              >
                Pay at counter
              </button>

              <button
                type="button"
                onClick={() => setPaymentMethod("upi")}
                aria-pressed={paymentMethod === "upi"}
                className={`relative z-10 flex-1 rounded-full px-3 py-2.5 text-xs font-bold transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 ${
                  paymentMethod === "upi"
                    ? "text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-700"
                }`}
              >
                Pay via UPI
              </button>
            </div>
          </div>
        )}

        {/* Customer Details */}
        <div>
          <label htmlFor="checkout-name" className="mb-2 block text-sm font-medium text-slate-700">
            Your Name<span className="text-red-600">*</span>
          </label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute left-4 top-1/2 z-10 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
            <Input
              id="checkout-name"
                value={customerName}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Rohit Sharma, John"
              autoComplete="name"
              className="h-12 pl-11 !rounded-xl !border-slate-200 !text-slate-900 placeholder:!text-slate-400 focus:!border-orange-600 focus:!ring-orange-100"
              required
            />
          </div>
        </div>

        <div>
          <label htmlFor="checkout-phone" className="mb-2 block text-sm font-medium text-slate-700">
            Mobile Number<span className="text-red-600">*</span>
          </label>
          <div className="relative">
            <Phone className="pointer-events-none absolute left-4 top-1/2 z-10 h-[18px] w-[18px] -translate-y-1/2 text-slate-400" />
            <Input
              id="checkout-phone"
              type="tel"
              inputMode="numeric"
              maxLength={10}
              autoComplete="tel"
                value={customerPhone}
              onChange={(e) => handlePhoneChange(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="e.g. 9876543210"
              className="h-12 pl-11 !rounded-xl !border-slate-200 !text-slate-900 placeholder:!text-slate-400 focus:!border-orange-600 focus:!ring-orange-100"
              required
            />
          </div>
          <p className="mt-1.5 text-xs text-slate-500">For order updates and billing</p>
        </div>

        {/* Special Instructions */}
        <div>
          <label htmlFor="special-instructions" className="mb-2 block text-sm font-semibold text-slate-700">
            Special Instructions <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <textarea
            id="special-instructions"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any allergies or special requests?"
            rows={2}
            className="h-24 w-full resize-none text-base px-4 py-3 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-600 bg-white text-slate-900 placeholder:text-slate-400 transition-all"
          />
        </div>

        {/* Turnstile renders nothing for a real guest (interaction-only) and
            costs no layout space until Cloudflare actually needs a human. The
            key is the nonce: remounting is how a spent token is replaced. */}
        {isTurnstileEnabled && (
          <TurnstileWidget
            key={turnstileNonce}
            onToken={handleTurnstileToken}
            onUnavailable={() => setTurnstileUnavailable(true)}
          />
        )}

      </form>

      {/* 💰 Pinned footer — bill total and the primary action stay put while the
          fields above scroll, exactly like the cart sheet. The button sits
          outside the form, so it reaches it through the `form` attribute. */}
      <div className="flex-shrink-0 rounded-t-3xl border-t border-neutral-100 bg-neutral-50/50 px-6 py-4 space-y-3">
        {/* Total row — plain text, not a nested card: the old Bill Summary card
            spent 32px of padding + a redundant "Table N" badge on a single
            line, which is real estate the scrollable fields need. */}
        {subtotal !== total && (
          <div className="flex justify-between text-xs font-bold text-neutral-500">
            <span>Subtotal</span>
            <span className="text-neutral-700">{formatCurrency(subtotal)}</span>
          </div>
        )}
        <div
          className={`flex justify-between items-baseline text-neutral-900 ${
            subtotal !== total ? "pt-2 border-t border-neutral-200/70" : ""
          }`}
        >
          <span className="text-lg font-bold">Total</span>
          <span className="text-xl font-black">{formatCurrency(total)}</span>
        </div>

        <Button
          form="checkout-form"
          type="submit"
          loading={loading}
          disabled={waitingForToken}
          fullWidth
          className={`rounded-xl py-3.5 font-bold text-xs uppercase tracking-wider ${
            // Never nudge a button that is already submitting.
            ctaNudging && !loading
              ? "animate-nudge-shake motion-reduce:animate-none"
              : ""
          }`}
        >
          {waitingForToken
            ? "Finishing security check…"
            : paymentMethod === "upi"
              ? "Place Order & Pay"
              : "Place Order"}
        </Button>
      </div>
    </BottomSheet>
  );
};

export default CheckoutContent;
