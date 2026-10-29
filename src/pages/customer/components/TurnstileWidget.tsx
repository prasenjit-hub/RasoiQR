import { useEffect, useRef } from "react";
import { TURNSTILE_SITE_KEY } from "../../../config/config";
import { isTurnstileEnabled, loadTurnstile } from "../../../services/turnstile";

/**
 * The visible half of the order gate — which, in `interaction-only` mode, is
 * usually nothing at all.
 *
 * Cloudflare's managed widget solves in the background for a real guest; the
 * box only appears when it genuinely needs a human to do something. That is the
 * whole point of choosing Turnstile over a classic CAPTCHA on a checkout: a
 * guest who has already typed their name and phone should not be handed a
 * traffic-light puzzle.
 *
 * `onToken(null)` is a normal state, not an error — a token is single-use and
 * expires after 300 s, and this component tells the parent about all three ways
 * it can disappear (expiry, error, remount) so the parent never submits a token
 * it believes is still good.
 *
 * Rendered only when `VITE_TURNSTILE_SITE_KEY` is set. With the key absent this
 * returns null and the checkout behaves exactly as it did before Turnstile.
 */
interface TurnstileWidgetProps {
  /** Latest token, or null when there is nothing usable right now. */
  onToken: (token: string | null) => void;
  /**
   * The script could not be loaded at all (offline, an ad blocker blocking
   * challenges.cloudflare.com, a CSP rule). The parent decides the copy — this
   * component only reports it.
   */
  onUnavailable?: () => void;
}

const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({ onToken, onUnavailable }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // The parent passes fresh closures on every render. Reading them through a ref
  // keeps the mount effect below from re-running (which would tear down and
  // re-render the widget — a new challenge — on every keystroke in the form).
  const handlers = useRef({ onToken, onUnavailable });
  useEffect(() => {
    handlers.current = { onToken, onUnavailable };
  });

  useEffect(() => {
    if (!isTurnstileEnabled) return;

    let cancelled = false;
    let widgetId: string | undefined;

    loadTurnstile()
      .then((api) => {
        // The component may have unmounted (or StrictMode's first pass been
        // discarded) while the script was loading.
        if (cancelled || !containerRef.current) return;

        widgetId = api.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          // Hide the box entirely unless Cloudflare needs the guest to act.
          appearance: "interaction-only",
          theme: "light",
          callback: (token: string) => handlers.current.onToken(token),
          // Both mean "this token is no longer usable" — clearing it is what
          // stops the checkout from submitting a dead token and reading the
          // resulting refusal as a failure of the order itself.
          "expired-callback": () => handlers.current.onToken(null),
          "error-callback": () => handlers.current.onToken(null),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Turnstile failed to load:", error);
        handlers.current.onToken(null);
        handlers.current.onUnavailable?.();
      });

    return () => {
      cancelled = true;
      // Explicitly remove rather than leaving the node for Cloudflare to find:
      // render=explicit mode expects the caller to own the lifecycle, and a
      // stale widget inside a React-replaced node is how duplicate challenges
      // happen.
      if (widgetId && typeof window !== "undefined" && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          /* already gone */
        }
      }
    };
  }, []);

  if (!isTurnstileEnabled) return null;

  // No wrapper styling on purpose: with `interaction-only` this element is
  // empty until Cloudflare decides it needs to be visible, and an empty styled
  // div would leave a gap in the form.
  return <div ref={containerRef} />;
};

export default TurnstileWidget;
