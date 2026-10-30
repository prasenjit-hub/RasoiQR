import React, { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useBodyScrollLock } from "../../utils/useBodyScrollLock";
import { useDragToDismiss } from "../../utils/useDragToDismiss";

/**
 * The one mobile sheet shell for the customer flow.
 *
 * Cart, item customizer, checkout and the UPI payment sheet used to carry four
 * hand-copied shells: same backdrop, same `rounded-t-[32px]` panel, same grab
 * handle, same slide transform — duplicated in `CustomerMenu` and then again in
 * `PaymentSheet`. The copies drifted (the payment sheet was 448px wide instead
 * of 576, had a different backdrop, slid in with no animation and never locked
 * the page behind it), which is exactly the kind of difference a guest reads as
 * "this screen is from another app".
 *
 * So the chrome lives here once:
 *  - backdrop + panel + grab handle + title row + close button
 *  - `translate-y` slide in/out, with a one-frame mount flip so a sheet that
 *    mounts already open (PaymentSheet) still slides instead of popping
 *  - drag-down-to-dismiss through `useDragToDismiss`
 *  - reference-counted body scroll lock (safe when two sheets stack)
 *
 * What stays with the caller is content: each sheet keeps its own scroll region
 * and its own pinned footer as children, because the cart, the customizer and
 * the checkout form all scroll differently. The panel is a flex column, so a
 * `flex-1 overflow-y-auto` body plus a `shrink-0` footer behaves exactly as the
 * old hand-written shells did.
 */
interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Small amber label above the title (e.g. "UPI payment"). */
  eyebrow?: string;
  /** Tailwind max-height class for the panel; the body scrolls inside it. */
  maxHeightClass?: string;
  /** Overlay z-index class — the payment sheet opens above the checkout. */
  zClassName?: string;
  children: React.ReactNode;
}

export const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  onClose,
  title,
  subtitle,
  eyebrow,
  maxHeightClass = "max-h-[85vh]",
  zClassName = "z-50",
  children,
}) => {
  useBodyScrollLock(open);
  const { panelRef } = useDragToDismiss({ enabled: open, onDismiss: onClose });

  // A sheet mounted already open never paints the closed transform, so the CSS
  // transition has nothing to animate from. Flipping one frame later gives
  // PaymentSheet (rendered only while an order needs paying) the same slide-up
  // as the sheets that stay mounted.
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 bg-neutral-950/70 backdrop-blur-sm ${zClassName} transition-opacity duration-300 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed bottom-0 left-0 right-0 mx-auto flex w-full max-w-xl flex-col overflow-hidden rounded-t-[32px] bg-white shadow-2xl ${zClassName} ${maxHeightClass} transition-transform duration-300 ease-out ${
          entered ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-auto mt-3.5 mb-1 h-1.5 w-12 shrink-0 touch-none rounded-full bg-neutral-200" />

        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-100 px-6 pb-3 pt-2">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-600">
                {eyebrow}
              </p>
            )}
            <h3 className="truncate text-xl font-extrabold text-neutral-800">{title}</h3>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs font-bold text-neutral-400">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 transition-colors hover:bg-neutral-200/80"
          >
            <X className="h-5 w-5 stroke-[2.5]" />
          </button>
        </div>

        {children}
      </div>
    </>
  );
};
