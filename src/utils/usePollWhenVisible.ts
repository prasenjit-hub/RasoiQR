import { useEffect, useRef } from "react";

/**
 * Re-run `callback` on an interval, but only while the tab is in the foreground.
 *
 * Why polling and not Realtime: both customer tracking pages used to follow
 * `orders` through a `postgres_changes` channel, and for an anonymous guest that
 * channel can never deliver a row. Migration 033 leaves `anon` with no SELECT
 * privilege on `orders` at all — `has_table_privilege('anon','public.orders',
 * 'SELECT')` is false — and no policy grants one, so Realtime has nothing it may
 * read or send. The subscription joined, held a socket open and silently
 * delivered nothing, which is why a status change never appeared until the guest
 * pressed refresh. `get_orders_for_tracking` is anon-callable by design and
 * returns exactly the rows a guest is allowed to see, so asking again is both
 * the honest and the cheap way to keep a status fresh.
 *
 * The rules that keep that cheap and correct:
 *   · a hidden tab is never polled (a phone in a pocket must not burn data)
 *   · the moment the tab comes back it refreshes, because that is exactly when
 *     the data on screen is stale
 *   · at most one request is in flight, so a slow reply cannot stack them up
 *   · `enabled: false` removes the timer entirely — callers pass false once an
 *     order is finished
 *
 * `callback` is held in a ref, so re-rendering the page does not restart the
 * interval (the old code keyed its effect on `restaurant?.id`, which fired the
 * whole load twice on every open).
 */
export const usePollWhenVisible = (
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true
): void => {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) return;

    let inFlight = false;

    const tick = async () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        await callbackRef.current();
      } catch {
        // A failed poll is not worth telling the guest about: the page keeps
        // the last good data on screen and the next tick tries again.
      } finally {
        inFlight = false;
      }
    };

    const interval = window.setInterval(() => void tick(), intervalMs);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
};
