import { useEffect, useState } from "react";

/** How long the guest can sit still before the CTA nudges. */
const DEFAULT_IDLE_MS = 10_000;
/** Must stay in step with the `nudge-shake` animation duration in tailwind.config.js. */
const SHAKE_MS = 700;

/**
 * 👋 Idle nudge — flips `true` for one shake animation every `idleMs` of
 * stillness, then re-arms so a guest who ignores it gets nudged again and
 * again. Any real interaction (tap, key, scroll, wheel) cancels the pending
 * nudge and restarts the clock, so the button never shakes while someone is
 * already using the page. Only the class is toggled — motion-sensitive guests
 * are handled by `motion-reduce:animate-none` where the class is applied.
 */
export const useIdleShake = (enabled: boolean, idleMs = DEFAULT_IDLE_MS) => {
  const [shaking, setShaking] = useState(false);

  useEffect(() => {
    if (!enabled) return;

    let idleTimer: number | undefined;
    let shakeTimer: number | undefined;
    // False once this effect instance is torn down, so a shake that lands
    // mid-teardown never re-arms the next window.
    let active = true;

    // Re-arm rather than using setInterval: the next window is measured from
    // the end of the previous shake, not from the previous start.
    const arm = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        setShaking(true);
        shakeTimer = window.setTimeout(() => {
          setShaking(false);
          if (active) arm();
        }, SHAKE_MS);
      }, idleMs);
    };

    const onActivity = () => {
      window.clearTimeout(shakeTimer);
      setShaking(false);
      arm();
    };

    arm();
    const events: (keyof WindowEventMap)[] = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));

    return () => {
      active = false;
      window.clearTimeout(idleTimer);
      // The shake timer is deliberately left to run out: whenever `shaking` is
      // true that timer is already pending, so an in-flight nudge clears
      // itself and the class can never stick on across a close/reopen.
      events.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, [enabled, idleMs]);

  return shaking;
};

export default useIdleShake;
