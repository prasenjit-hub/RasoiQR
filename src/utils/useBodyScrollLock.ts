import { useEffect } from "react";

// 📱 Global body-scroll lock, shared by every overlay in the app.
//
// Reference counted: when two overlays are open at once (for example an admin
// Modal on top of another overlay) the first lock wins and only the last unlock
// restores the page — so one overlay closing can never hand scrolling back to
// the page still hidden underneath it.
let lockCount = 0;
let restoreY = 0;

const saved = {
  position: "",
  top: "",
  left: "",
  right: "",
  width: "",
  overflow: "",
  paddingRight: "",
};

const lockBodyScroll = () => {
  lockCount += 1;
  if (lockCount > 1) return;

  const { body } = document;
  // A visible scrollbar would otherwise make the page jump when it disappears.
  const scrollbarWidth =
    window.innerWidth - document.documentElement.clientWidth;

  // iOS reports a negative scrollY mid-rubber-band; clamping stops the frozen
  // page from being nudged downwards behind the overlay.
  restoreY = Math.max(0, window.scrollY);

  saved.position = body.style.position;
  saved.top = body.style.top;
  saved.left = body.style.left;
  saved.right = body.style.right;
  saved.width = body.style.width;
  saved.overflow = body.style.overflow;
  saved.paddingRight = body.style.paddingRight;

  // `position: fixed` is the technique iOS Safari actually honours, and
  // freezing the body at -scrollY keeps the page pixel-identical behind the
  // overlay. Overlay children stay put because `position: fixed` (unlike a
  // transform) does not create a containing block for them.
  body.style.position = "fixed";
  body.style.top = `-${restoreY}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  body.style.overflow = "hidden";
  body.style.paddingRight = scrollbarWidth > 0 ? `${scrollbarWidth}px` : "";
};

const unlockBodyScroll = () => {
  if (lockCount === 0) return;
  lockCount -= 1;
  if (lockCount > 0) return;

  const { body } = document;

  body.style.position = saved.position;
  body.style.top = saved.top;
  body.style.left = saved.left;
  body.style.right = saved.right;
  body.style.width = saved.width;
  body.style.overflow = saved.overflow;
  body.style.paddingRight = saved.paddingRight;

  // Drop the customer back exactly where they were before the overlay opened.
  window.scrollTo(0, restoreY);
};

/**
 * Freezes the page behind an overlay while `isLocked` is true. The overlay's
 * own scroll containers keep working normally.
 */
export const useBodyScrollLock = (isLocked: boolean) => {
  useEffect(() => {
    if (!isLocked) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [isLocked]);
};
