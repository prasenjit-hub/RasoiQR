import { TURNSTILE_SITE_KEY } from "../config/config";

/**
 * Cloudflare Turnstile loader.
 *
 * Deliberately a plain module, not a hook, and deliberately lazy: the script is
 * ~60 KB from a third-party origin, and the customer menu (the page every guest
 * lands on) must not pay for it. Nothing here runs until the checkout sheet
 * actually mounts a `TurnstileWidget`.
 *
 * `render=explicit` is part of the URL on purpose. The implicit mode auto-scans
 * the DOM for `.cf-turnstile` elements, which fights React: a re-render can
 * leave Cloudflare looking at a node React already replaced. Explicit mode means
 * this module decides exactly when a widget exists and when it is removed.
 */

/** Public key from `VITE_TURNSTILE_SITE_KEY`. Empty → the whole gate is off. */
export const isTurnstileEnabled = TURNSTILE_SITE_KEY.length > 0;

/** The subset of the Turnstile client API this app uses. */
interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_ID = "cf-turnstile-script";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * One in-flight load at a time. A rejected promise is discarded (see `onError`)
 * so a guest whose network blipped can retry by tapping again, instead of being
 * stuck with a permanently failed loader.
 */
let loader: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Turnstile needs a browser."));
  }
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loader) return loader;

  loader = new Promise<TurnstileApi>((resolve, reject) => {
    const onLoad = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile loaded but window.turnstile is missing."));
    };
    const onError = () => {
      // Let the next attempt start over rather than caching the failure.
      loader = null;
      reject(new Error("Could not load the security check."));
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      // A previous mount injected it. It may still be loading — listen rather
      // than assuming, because attaching after `load` has fired never resolves.
      if (window.turnstile) {
        resolve(window.turnstile);
        return;
      }
      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener("error", onError, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    document.head.appendChild(script);
  });

  return loader;
}
