import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Loader2,
  QrCode,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Alert, BottomSheet, Button } from "../../../components/ui";
import {
  claimUpiPayment,
  getOrderPaymentInfo,
  type OrderPaymentInfo,
} from "../../../services/restaurantService";
import { formatCurrency } from "../../../utils/helpers";
import { buildUpiUri } from "../../../utils/upi";
import type { PlacedOrderInfo } from "./CheckoutContent";

interface PaymentSheetProps {
  order: PlacedOrderInfo | null;
  onClose: () => void;
}

/**
 * The guest's side of a direct-UPI order (migration 050).
 *
 * ⚠️ "I have paid" is a CLAIM, not a confirmation. The money goes to the
 * restaurant's own VPA, and there is no public API to verify a UPI reference —
 * so the restaurant checks its own app and taps "Payment received". The kitchen
 * does not open before that (enforced in `transition_order_status`, not here).
 */
const PaymentSheet: React.FC<PaymentSheetProps> = ({ order, onClose }) => {
  const [info, setInfo] = useState<OrderPaymentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [showQr, setShowQr] = useState(false);
  // Which half of the flow the guest is on. Before they leave for the UPI app,
  // "Open UPI app" is the primary action; after they have left (or opened the
  // QR for another phone), the only useful next step is "I have paid". Two
  // filled black buttons at once made the guest choose between them.
  const [openedApp, setOpenedApp] = useState(false);

  useEffect(() => {
    if (!order?.orderId) return;

    let cancelled = false;
    setLoading(true);
    setError("");
    setClaimed(false);
    setInfo(null);

    void getOrderPaymentInfo(order.orderId).then((row) => {
      if (cancelled) return;
      setInfo(row);
      if (!row) {
        setError(
          "We couldn't load this order's payment details. Please check your order and try again."
        );
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [order?.orderId]);

  if (!order) return null;

  const amount = Number(info?.total ?? 0);
  const orderNumber = info?.order_number ?? order.orderNumber ?? "";
  const payee = info?.upi_payee_name || info?.restaurant_name || "the restaurant";
  const upiUri = info?.upi_id
    ? buildUpiUri({
        upiId: info.upi_id,
        payeeName: payee,
        amount,
        orderNumber,
      })
    : null;

  const status = info?.payment_status;
  const paid = status === "paid";
  const alreadyClaimed = status === "claimed";
  const finished = paid || alreadyClaimed || claimed;
  const notRequired = info != null && !info.payment_required;
  const unavailable = status === "failed" || status === "expired";

  const handleCopy = async () => {
    if (!info?.upi_id) return;
    try {
      await navigator.clipboard.writeText(info.upi_id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy the UPI ID. Please select it and copy it manually.");
    }
  };

  const handleClaim = async () => {
    if (!order.orderId) return;
    setClaiming(true);
    setError("");

    const result = await claimUpiPayment(order.orderId);
    setClaiming(false);

    if (result.error) {
      setError(result.error);
      return;
    }

    // The staff member may have confirmed the transfer while this sheet was
    // open; the RPC then hands back 'paid'. Say so, instead of downgrading a
    // confirmed payment to "submitted".
    if (result.status === "paid") {
      setInfo((current) =>
        current ? { ...current, payment_status: "paid" } : current
      );
    }

    // 'claimed' and 'paid' are both success: idempotency may hand back a state
    // a previous tap already reached.
    setClaimed(true);
  };

  return (
    <BottomSheet
      open
      onClose={onClose}
      eyebrow="UPI payment"
      title={amount > 0 ? `Pay ${formatCurrency(amount)}` : "Pay via UPI"}
      subtitle={`Order #${orderNumber || "…"}${
        info?.restaurant_name ? ` · ${info.restaurant_name}` : ""
      }`}
      maxHeightClass="max-h-[90vh]"
      zClassName="z-[80]"
    >
      <div className="flex-1 space-y-4 overflow-y-auto px-6 pb-6 pt-4">
          {error && <Alert type="error" message={error} />}

          {loading && (
            <div className="flex items-center justify-center gap-2 rounded-2xl bg-neutral-50 py-10 text-sm font-semibold text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading payment details…
            </div>
          )}

          {/* The owner switched UPI off between checkout and this screen, or a
              stale order was opened. Cash is always a valid fallback. */}
          {!loading && notRequired && (
            <div className="space-y-4 text-center">
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-neutral-100">
                <ShieldCheck className="h-8 w-8 text-neutral-500" />
              </div>
              <div>
                <h4 className="text-lg font-black text-neutral-900">Pay at the counter</h4>
                <p className="mt-1 text-sm font-medium text-neutral-500">
                  This order does not need an online payment. The restaurant will collect it.
                </p>
              </div>
              <Button fullWidth onClick={onClose}>
                Done
              </Button>
            </div>
          )}

          {!loading && finished && (
            <div className="space-y-4 text-center">
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-emerald-50">
                <CheckCircle2 className="h-8 w-8 text-emerald-500" />
              </div>
              <div>
                <h4 className="text-lg font-black text-neutral-900">
                  {paid ? "Payment confirmed" : "Payment submitted"}
                </h4>
                <p className="mt-1 text-sm font-medium leading-relaxed text-neutral-500">
                  {paid
                    ? "The restaurant has confirmed your payment. Your order is with the kitchen."
                    : "The restaurant will check its own UPI app and confirm. Your order starts after that."}
                </p>
              </div>
              <Button fullWidth onClick={onClose}>
                Done
              </Button>
            </div>
          )}

          {!loading && unavailable && (
            <Alert
              type="warning"
              message="This order is no longer awaiting a UPI payment. Please pay at the counter or talk to a member of staff."
            />
          )}

          {!loading && !notRequired && !finished && !unavailable && info && (
            <>
              {/* One amber line, not a card. "Paying {payee} directly" used to
                  be the heading here, but the closing line already says the
                  money goes straight to the restaurant — so it was the same
                  claim twice. What survives is the one fact no other line
                  carries: the exact amount, which every UPI app lets the payer
                  edit before confirming. */}
              <p className="rounded-xl bg-amber-50/70 px-3.5 py-2.5 text-center text-[11px] font-semibold leading-relaxed text-amber-800">
                Pay exactly {formatCurrency(amount)} — don't change the amount.
              </p>

              {upiUri ? (
                <>
                  {/* Phone: the app chooser. Desktop: a QR, because `upi://`
                      has nothing to open there. */}
                  <a
                    href={upiUri}
                    onClick={() => setOpenedApp(true)}
                    className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3.5 text-xs font-black uppercase tracking-wider transition-colors md:hidden ${
                      openedApp
                        ? "border border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50"
                        : "bg-neutral-900 text-white hover:bg-neutral-800"
                    }`}
                  >
                    <Smartphone className="h-4 w-4" />
                    Open UPI app
                  </a>

                  <div className="hidden flex-col items-center gap-2 rounded-2xl border border-neutral-200 p-4 md:flex">
                    <QRCodeSVG value={upiUri} size={200} level="M" marginSize={2} />
                    <p className="text-[11px] font-semibold text-neutral-500">
                      Scan with any UPI app
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setShowQr((value) => !value);
                      // Showing the QR means they are paying on another phone,
                      // so the next step here is still "I have paid".
                      setOpenedApp(true);
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-neutral-200 px-4 py-3 text-xs font-bold text-neutral-600 md:hidden"
                  >
                    <QrCode className="h-4 w-4" />
                    {showQr ? "Hide QR code" : "Scan from another phone"}
                  </button>

                  {showQr && (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-neutral-200 p-4 md:hidden">
                      <QRCodeSVG value={upiUri} size={200} level="M" marginSize={2} />
                      <p className="text-[11px] font-semibold text-neutral-500">
                        Scan with any UPI app
                      </p>
                    </div>
                  )}

                  {/* Compact row: the old one used a size="sm" outline Button
                      (40px tall, 2px black border, 8px vertical padding) inside
                      a p-3 card, which made a single line of text look like a
                      form field. The label stays — it tells a guest what to
                      paste — but the control is now a quiet 30px chip. */}
                  <div className="flex items-center gap-2.5 rounded-xl bg-neutral-50 py-1.5 pl-3.5 pr-1.5">
                    <span className="shrink-0 text-[10px] font-black uppercase tracking-wider text-neutral-500">
                      UPI ID
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs font-bold text-neutral-800">
                      {info.upi_id}
                    </span>
                    <button
                      type="button"
                      onClick={handleCopy}
                      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-[11px] font-bold text-neutral-600 transition-colors hover:bg-neutral-100"
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>

                  {/* Step-aware emphasis: outline until they have actually left
                      for the app, filled black afterwards — the screen then
                      reads pay → confirm instead of offering two primaries. */}
                  <Button
                    fullWidth
                    loading={claiming}
                    onClick={handleClaim}
                    variant={openedApp ? "primary" : "outline"}
                    className="rounded-xl py-3.5 text-xs font-black uppercase tracking-wider"
                  >
                    I have paid
                  </Button>

                  {/* One line, two facts the guest cannot see elsewhere: the
                      money never passes through us, and staff confirm before
                      cooking starts. The old pair of paragraphs said the same
                      thing twice and read as fine print. */}
                  <p className="text-center text-[11px] font-medium leading-relaxed text-neutral-500">
                    Money goes straight to {payee} — the kitchen starts after staff
                    confirms in their UPI app.
                  </p>
                </>
              ) : (
                <Alert
                  type="warning"
                  message="This restaurant hasn't finished setting up UPI. Please pay at the counter."
                />
              )}
            </>
          )}

      </div>
    </BottomSheet>
  );
};

export default PaymentSheet;
