import { useEffect, useRef } from "react";

// 🖐️ Drag-down-to-dismiss for bottom sheets (mobile first, mouse works too).
//
// The sheet keeps its existing class-based open/close transform; the gesture
// only writes a temporary inline transform on the panel while a finger pulls
// down from the header strip, then hands the panel straight back — either by
// snapping to rest or by asking the sheet to close. Nothing is stored in React
// state, so there is no drag state to go stale between open/close cycles and a
// 60fps drag does not re-render the sheet.

const SETTLE_MS = 220;
const SETTLE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Height of the grab strip at the top of a sheet (pill + title row). */
const GRAB_ZONE_PX = 88;
/** Movement before the gesture counts as a drag instead of a tap. */
const START_SLOP_PX = 8;
/** Drag distance that commits the dismissal on release. */
const DISMISS_DISTANCE_PX = 96;
/** Shorter travel that still commits when released fast enough. */
const FLICK_DISTANCE_PX = 24;
/** Release speed (px per ms) that commits a dismissal regardless of travel. */
const FLICK_VELOCITY = 0.6;

interface UseDragToDismissOptions {
  /** Sheet is open — only then is the gesture armed. */
  enabled: boolean;
  /** Called once the sheet has animated fully off screen. */
  onDismiss: () => void;
}

export const useDragToDismiss = ({
  enabled,
  onDismiss,
}: UseDragToDismissOptions) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!enabled) return;

    const panel = panelRef.current;
    if (!panel) return;

    let settleTimer: number | null = null;
    let frame: number | null = null;
    let detachGesture: (() => void) | null = null;

    const setTransform = (offset: number, animate: boolean) => {
      panel.style.transition = animate
        ? `transform ${SETTLE_MS}ms ${SETTLE_EASING}`
        : "none";
      panel.style.transform = `translateY(${offset}px)`;
    };

    // Removes the inline transform/transition, which hands the panel back to
    // the class-based `translate-y-0` / `translate-y-full` transform. Both put
    // the sheet in the same visual place, so nothing jumps.
    const releaseTransform = () => {
      panel.style.removeProperty("transform");
      panel.style.removeProperty("transition");
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;

      const target = event.target as HTMLElement;
      // Header controls (✕, links, fields) must keep their own taps.
      if (target.closest("button, a, input, textarea, select, [data-no-drag]")) {
        return;
      }

      // Only the header strip is a drag zone — the body below stays scrollable,
      // so a pull inside the scrolled list never hijacks the scroll.
      const rect = panel.getBoundingClientRect();
      if (event.clientY - rect.top > GRAB_ZONE_PX) return;

      const startY = event.clientY;
      let lastY = startY;
      let lastTime = event.timeStamp;
      let velocity = 0;
      let dragging = false;
      let pendingOffset = 0;

      const flush = () => {
        frame = null;
        setTransform(pendingOffset, false);
      };

      const onMove = (moveEvent: PointerEvent) => {
        const delta = moveEvent.clientY - startY;
        const dt = moveEvent.timeStamp - lastTime;

        if (dt > 0) velocity = (moveEvent.clientY - lastY) / dt;
        lastY = moveEvent.clientY;
        lastTime = moveEvent.timeStamp;

        // Upward pulls are ignored: the sheet is already at full height.
        if (delta < START_SLOP_PX) return;

        dragging = true;
        pendingOffset = delta;
        // Coalesce rapid touch moves into a single write per frame.
        if (frame === null) frame = window.requestAnimationFrame(flush);
      };

      const onUp = () => {
        detach();
        if (!dragging) return;

        if (frame !== null) {
          window.cancelAnimationFrame(frame);
          frame = null;
        }

        const travelled = lastY - startY;
        const dismiss =
          travelled > DISMISS_DISTANCE_PX ||
          (travelled > FLICK_DISTANCE_PX && velocity > FLICK_VELOCITY);

        setTransform(
          dismiss ? panel.offsetHeight || window.innerHeight : 0,
          true
        );

        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          if (dismiss) {
            // React flips the sheet's own class to "closed" here; the effect
            // teardown below clears this inline transform right after that
            // commit, so the sheet never flashes back into view.
            onDismissRef.current();
          } else {
            releaseTransform();
          }
        }, SETTLE_MS);
      };

      const detach = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        detachGesture = null;
      };

      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      detachGesture = detach;
    };

    panel.addEventListener("pointerdown", onPointerDown);

    return () => {
      panel.removeEventListener("pointerdown", onPointerDown);
      detachGesture?.();
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      releaseTransform();
    };
  }, [enabled]);

  return { panelRef };
};
