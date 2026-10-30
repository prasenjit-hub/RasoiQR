import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Loader2,
  QrCode,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { Alert, Button } from "../../../components/ui";
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
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:px-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-[32px] bg-white shadow-2xl sm:rounded-3xl">
        {/* Header */}
        <div className="sticky top-0 z-10 rounded-t-[32px] bg-white px-6 pb-3 pt-4 sm:rounded-t-3xl">
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-neutral-200 sm:hidden" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-600">
                Direct UPI
              </p>
              <h3 className="truncate text-2xl font-black text-neutral-900">
                {amount > 0 ? `Pay ${formatCurrency(amount)}` : "Pay via UPI"}
              </h3>
              <p className="truncate text-xs font-bold text-neutral-400">
                Order #{orderNumber || "…"}
                {info?.restaurant_name ? ` · ${info.restaurant_name}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close payment"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-4 px-6 pb-6">
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
              <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4">
                <p className="text-xs font-black text-amber-900">
                  Paying {payee} directly
                </p>
                <p className="mt-1 text-[11px] font-semibold leading-relaxed text-amber-800/80">
                  RasoiQR does not receive or hold this money. Pay exactly{" "}
                  {formatCurrency(amount)}.
                </p>
              </div>

              {upiUri ? (
                <>
                  {/* Phone: the app chooser. Desktop: a QR, because `upi://`
                      has nothing to open there. */}
                  <a
                    href={upiUri}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3.5 text-xs font-black uppercase tracking-wider text-white transition-colors hover:bg-neutral-800 md:hidden"
                  >
                    <Smartphone className="h-4 w-4" />
                    Pay {formatCurrency(amount)} in UPI app
                  </a>

                  <div className="hidden flex-col items-center gap-2 rounded-2xl border border-neutral-200 p-4 md:flex">
                    <QRCodeSVG value={upiUri} size={200} level="M" marginSize={2} />
                    <p className="text-[11px] font-semibold text-neutral-500">
                      Scan with any UPI app
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowQr((value) => !value)}
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

                  <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-50 p-3">
                    <div className="min-w-0">
                      <p className="text-[10px] font-black uppercase tracking-wider text-neutral-400">
                        UPI ID
                      </p>
                      <p className="truncate font-mono text-xs font-bold text-neutral-800">
                        {info.upi_id}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopy}
                      icon={<Copy className="h-3.5 w-3.5" />}
                    >
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>

                  <Button
                    fullWidth
                    loading={claiming}
                    onClick={handleClaim}
                    className="rounded-xl py-3.5 text-xs font-black uppercase tracking-wider"
                  >
                    I have paid
                  </Button>

                  <p className="text-center text-[11px] font-medium leading-relaxed text-neutral-400">
                    After paying, tap above. The restaurant checks its own UPI app and
                    confirms — your order starts after that.
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

          <p className="text-center text-[10px] font-semibold leading-relaxed text-neutral-400">
            Money goes directly to {payee}. RasoiQR is not a payment intermediary.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PaymentSheet;
