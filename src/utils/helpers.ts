import { APP_CONFIG } from "../config/config";

/**
 * Format currency value
 */
export const formatCurrency = (amount: number | undefined | null): string => {
  if (amount === undefined || amount === null || isNaN(amount)) {
    return `${APP_CONFIG.defaultCurrency}0.00`;
  }
  return `${APP_CONFIG.defaultCurrency}${amount.toFixed(2)}`;
};

/**
 * Hard cap for a single cart line — mirrors the server-side guard in
 * `customer_create_order` (`v_qty > 50` raises). Every customer-side add path
 * (menu card +, cart +, customizer quantity, duplicate-line merge) clamps to
 * this, so the UI can never build a line the server will reject.
 */
export const MAX_ITEM_QUANTITY = 50;

/**
 * The table code carried by a table QR (`?t=<code>`, migration 045), read off
 * the URL and normalised the one way the server expects it.
 *
 * Every customer page that can be reached from a table QR needs this, because
 * the code is the ONLY thing that says which table the guest is sitting at —
 * `customer_create_order` resolves the label from it and ignores anything else
 * the client claims. Losing it mid-visit silently demotes the guest to a
 * takeaway customer: they cannot order dine-in any more and Call Waiter
 * disappears, with nothing on screen explaining why.
 */
export const tableCodeFromSearch = (params: URLSearchParams): string =>
  (params.get("t") || "").trim().toLowerCase();

/**
 * Append that code to an in-app path, so a link never drops the guest's table.
 *
 * Used by the menu → orders → order → back chain: each hop is a real URL, so
 * the browser's own Back button, a refresh and a shared link all keep working
 * instead of depending on history that a deep link never had.
 */
export const withTableCode = (
  path: string,
  tableCode?: string | null
): string => {
  const code = (tableCode ?? "").trim().toLowerCase();
  if (!code) return path;
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(code)}`;
};

/**
 * A status an order never leaves.
 *
 * The customer tracking pages keep their status fresh by re-asking
 * `get_orders_for_tracking`, which is fine while an order can still move and
 * pure waste once it cannot — a finished order is the one case where the page
 * can stop talking to the network entirely. `ready` is deliberately NOT in here:
 * it still moves on to `completed`.
 */
const TERMINAL_ORDER_STATUSES = new Set(["completed", "cancelled", "rejected"]);

export const isTerminalOrderStatus = (
  status: string | null | undefined
): boolean => TERMINAL_ORDER_STATUSES.has(String(status ?? "").trim().toLowerCase());

/**
 * 🔁 Idempotency reference for one checkout attempt (migration 039).
 *
 * `customer_create_order` takes this as `p_client_ref`: a retry that carries a
 * reference the restaurant already stored returns that same order instead of
 * committing a second one, which is what closes the "response lost on the
 * wire → guest taps again → dish cooked twice" hole. It must therefore be
 * stable across retries of one attempt and different for any edited payload —
 * `CheckoutContent` keys it on the payload and mints a new one when that
 * changes.
 *
 * The order column is `uuid`, so the fallback still has to look like one:
 * `crypto.randomUUID` needs a secure context (fine on https and localhost, not
 * on a plain-http LAN address a phone might open), so an older in-app browser
 * falls back to `getRandomValues`, and only a browser with no WebCrypto at all
 * falls back to `Math.random`.
 */
export const newIdempotencyRef = (): string => {
  const cryptoObj = globalThis.crypto;

  if (typeof cryptoObj?.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoObj?.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 version 4 layout — the server column is a real uuid type.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Pick a readable font size for a restaurant name based on its length.
 *
 * The customer hero card gives the name a fixed slot next to the logo, so a
 * single fixed size is wrong at both ends: it overflows on a long name and
 * looks undersized on a short one. Short names get the largest step and long
 * names step down, each step sized so the name stays within two lines at the
 * card's narrowest practical width. Callers pair this with `line-clamp-2` +
 * `break-words`, so anything longer is ellipsised instead of breaking the card.
 *
 * Every tier carries a responsive pair — the second value applies from the
 * `sm` breakpoint (≥640px), where the card is wider.
 */
export const restaurantNameSizeClass = (
  name: string | undefined | null
): string => {
  const len = (name ?? "").trim().length;
  if (len <= 14) return "text-xl sm:text-2xl";
  if (len <= 27) return "text-lg sm:text-2xl";
  if (len <= 45) return "text-base sm:text-xl";
  return "text-sm sm:text-lg";
};

/**
 * Latin letters that Unicode does NOT decompose (đ, ł, ø, ı …). Stripping
 * combining marks is therefore not enough on its own — these need an explicit
 * map. The two strings MUST line up character for character, and they are the
 * exact pair migration 047 uses in `normalize_slug`, so what the admin previews
 * and what the database stores cannot disagree.
 */
/** The cap `admin_create_restaurant` applies, and the one this file enforces. */
export const MAX_SLUG_LENGTH = 50;

const SLUG_ACCENTS =
  "àáâãäåāăąçćčďđèéêëēėęěğģìíîïīįłļñńňòóôõöøōőřśšşťţùúûüūůűýÿžźż";
const SLUG_BASES =
  "aaaaaaaaacccddeeeeeeeeggiiiiiillnnnoooooooorsssttuuuuuuuyyzzz";

/**
 * Mirror of the database's `normalize_slug()` (migration 047).
 *
 * The DATABASE is the authority: `admin_create_restaurant` normalises whatever
 * this returns, substitutes `r-<hex>` when nothing is left, and appends `-2`,
 * `-3`, … on a collision. This exists so the admin can SEE the menu link they
 * are about to get beforehand — the slug is printed on a QR standee and can
 * never be changed afterwards, so a surprise here is permanent.
 *
 * The order matches the SQL and matters: fold accents, then DELETE apostrophes
 * (`Mummy's` → `mummys`, not `mummy-s`), then collapse every remaining run of
 * punctuation to one hyphen, then trim the edges.
 *
 * It does NOT make the value unique — the RPC owns that, and appends `-2`,
 * `-3`, … on a name clash.
 */
export const normalizeSlug = (
  input: string | null | undefined,
  maxLength: number = MAX_SLUG_LENGTH
): string => {
  if (!input) return "";

  // `for … of` walks code points, matching PostgreSQL's `char_length`/`translate`
  // rather than JS string indices (which split surrogate pairs).
  let folded = "";
  for (const ch of input.toLowerCase()) {
    const at = SLUG_ACCENTS.indexOf(ch);
    folded += at >= 0 && at < SLUG_BASES.length ? SLUG_BASES[at] : ch;
  }

  const cleaned = folded
    .replace(/['"’”`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // The RPC does `left(normalize_slug(x), 50)`, and a cut that lands on a hyphen
  // leaves a trailing one — which `restaurants_slug_format` then REJECTS. The
  // RPC's exception handler turns that into `success = false` AFTER the auth
  // user was already created, i.e. an orphaned login. Cutting and then trimming
  // here produces the same length without that failure mode, so the browser can
  // never submit a value the constraint refuses.
  return cleaned.slice(0, maxLength).replace(/-+$/, "");
};

/**
 * Generate random order number
 */
export const generateOrderNumber = (): string => {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${APP_CONFIG.orderPrefix}${timestamp}${random}`;
};

/**
 * Generate temporary password
 */
export const generateTempPassword = (): string => {
  const uppers = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowers = "abcdefghjkmnpqrstuvwxyz";
  const numbers = "23456789";
  const specials = "!@#$%^&*";
  
  // Ensure at least one of each type
  let password = 
    uppers.charAt(Math.floor(Math.random() * uppers.length)) +
    lowers.charAt(Math.floor(Math.random() * lowers.length)) +
    numbers.charAt(Math.floor(Math.random() * numbers.length)) +
    specials.charAt(Math.floor(Math.random() * specials.length));

  const allChars = uppers + lowers + numbers + specials;
  
  // Fill the rest to make it 12 characters
  for (let i = password.length; i < 12; i++) {
    password += allChars.charAt(Math.floor(Math.random() * allChars.length));
  }
  
  // Shuffle the password
  return password.split('').sort(() => 0.5 - Math.random()).join('');
};

/**
 * Calculate order totals
 */
export const calculateOrderTotals = (items: any[]) => {
  const subtotal = items.reduce((sum, item) => sum + item.item_total, 0);
  const tax = 0;
  const total = subtotal;

  return { subtotal, tax, total };
};

/**
 * Format date and time
 */
export const formatDateTime = (dateString: string): string => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
};

export const formatDate = (dateString: string): string => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
};

export const formatTime = (dateString: string): string => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
};

/**
 * Validate email
 */
export const isValidEmail = (email: string): boolean => {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
};

/**
 * Validate phone number (Indian format)
 */
export const isValidPhone = (phone: string): boolean => {
  const re = /^[6-9]\d{9}$/;
  return re.test(phone.replace(/[\s\-()]/g, ""));
};

/**
 * Debounce function
 */
export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};

/**
 * Get status color class
 */
export const getStatusColor = (status: string): string => {
  const statusConfig =
    APP_CONFIG.orderStatuses[status as keyof typeof APP_CONFIG.orderStatuses];
  return statusConfig?.color || "neutral";
};

/**
 * Calculate item price with size and addons
 */
export const calculateItemPrice = (
  basePrice: number,
  selectedSize?: { price: number },
  selectedAddons?: { price: number }[]
): number => {
  let price = selectedSize ? selectedSize.price : basePrice;
  if (selectedAddons && selectedAddons.length > 0) {
    price += selectedAddons.reduce((sum, addon) => sum + addon.price, 0);
  }
  return price;
};

/**
 * Download file
 */
export const downloadFile = (url: string, filename: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

/**
 * Copy to clipboard
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    return false;
  }
};

/**
 * Alert chimes the dashboard can play. Both files live in /public as short,
 * pre-compressed audio.
 *
 *  · `order`  — a customer placed an order (the original chime).
 *  · `waiter` — a table pressed "Call Waiter". It deliberately gets a *
 *    different tone: staff should be able to tell "someone is waving at me"
 *    from "an order came in" without walking back to the screen.
 */
export type AlertSound = "order" | "waiter";

const ALERT_SRC: Record<AlertSound, string> = {
  order: "/notification.aac",
  // Mixkit "clear announce tones" (2861), trailing 0.44s of silence trimmed,
  // 3.6s mono. MP3 rather than the source's 701KB 44.1kHz WAV: 58KB over the
  // wire, and a Linux Firefox with no system AAC decoder can still play it.
  waiter: "/waiter-call.mp3",
};

/**
 * Where a kitchen's own sound preference is kept.
 *
 * Per *device* (localStorage), not per restaurant: the tablet on the counter
 * needs its own setting from the owner's phone in the room next door, and the
 * tablet is the one that must stay loud. It also keeps this out of the
 * database — `restaurants` has no client write path (034), and the profile RPC
 * is for profile fields, not for a UI preference.
 */
const ALERT_SETTINGS_KEY = "rq_alert_sound";

export interface AlertSoundState {
  /** Master switch for this device. */
  muted: boolean;
  /** 0–1, the same scale as `HTMLMediaElement.volume`. */
  volume: number;
  /**
   * Runtime only, never stored: the browser refused a chime because the page
   * had not been touched yet (autoplay policy). The menu says so instead of
   * leaving the owner to wonder why a call arrived silently.
   */
  blocked: boolean;
}

const clampVolume = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
};

const readStoredAlertSettings = (): { muted: boolean; volume: number } => {
  try {
    const raw = window.localStorage.getItem(ALERT_SETTINGS_KEY);
    if (!raw) return { muted: false, volume: 1 };
    const parsed = JSON.parse(raw) as { muted?: unknown; volume?: unknown };
    return { muted: parsed.muted === true, volume: clampVolume(parsed.volume ?? 1) };
  } catch {
    // Private mode / storage disabled / a hand-edited value: fall back to the
    // defaults rather than breaking every alert on the device.
    return { muted: false, volume: 1 };
  }
};

/**
 * One object, replaced (never mutated) when something changes, so React can
 * read it through `useSyncExternalStore` by identity.
 */
let alertState: AlertSoundState = { ...readStoredAlertSettings(), blocked: false };
const alertStateListeners = new Set<() => void>();

/**
 * One player per sound, built on first use and then reused.
 *
 * `new Audio()` at the moment of the alert would start the download right when
 * the tone is needed, so the beep landed a beat late — or not at all on a slow
 * connection. Building the element once lets `preload` fetch it in the
 * background, and a repeat alert just rewinds instead of re-downloading.
 */
const alertPlayers = new Map<AlertSound, HTMLAudioElement>();

/** Push the device's current volume/mute onto every player that exists. */
const applyAlertVolume = () => {
  alertPlayers.forEach((player) => {
    player.volume = alertState.volume;
    player.muted = alertState.muted;
  });
};

const getAlertPlayer = (sound: AlertSound): HTMLAudioElement => {
  let player = alertPlayers.get(sound);
  if (!player) {
    player = new Audio(ALERT_SRC[sound]);
    player.preload = "auto";
    alertPlayers.set(sound, player);
    applyAlertVolume();
  }
  return player;
};

const publishAlertState = (patch: Partial<AlertSoundState>) => {
  alertState = { ...alertState, ...patch };
  alertStateListeners.forEach((listener) => listener());
};

const persistAlertSettings = () => {
  try {
    window.localStorage.setItem(
      ALERT_SETTINGS_KEY,
      JSON.stringify({ muted: alertState.muted, volume: alertState.volume })
    );
  } catch {
    // Best-effort: the setting still applies to this session.
  }
};

/**
 * Fetch both chimes ahead of time. Call it from a signed-in screen only — on
 * the customer menu these files would be dead weight on someone's mobile data.
 */
export const preloadAlertSounds = () => {
  (Object.keys(ALERT_SRC) as AlertSound[]).forEach((sound) => getAlertPlayer(sound));
};

// ── Alert sound settings (the kitchen's own knob) ────────────────────────────

/** Snapshot for React — object identity changes only when a setting does. */
export const getAlertSoundState = (): AlertSoundState => alertState;

export const subscribeAlertSoundSettings = (listener: () => void) => {
  alertStateListeners.add(listener);
  return () => {
    alertStateListeners.delete(listener);
  };
};

/** True when a chime would actually be heard on this device. */
export const isAlertSoundAudible = () => !alertState.muted && alertState.volume > 0;

export const setAlertSoundMuted = (muted: boolean) => {
  publishAlertState({ muted });
  applyAlertVolume();
  persistAlertSettings();
};

export const setAlertSoundVolume = (volume: number) => {
  publishAlertState({ volume: clampVolume(volume) });
  applyAlertVolume();
  persistAlertSettings();
};

/**
 * Play one of the alert chimes (silently ignored when the device is muted).
 */
export const playAlertSound = (sound: AlertSound = "order") => {
  if (!isAlertSoundAudible()) return;

  const player = getAlertPlayer(sound);

  try {
    // Rewind so a second call arriving mid-chime still alerts.
    player.currentTime = 0;
  } catch {
    // Safari throws here before metadata is loaded; play() below still works.
  }

  player
    .play()
    .then(() => {
      // A successful chime proves the page is unlocked again (the owner has
      // interacted with it), so the "blocked" note in the menu goes away.
      if (alertState.blocked) publishAlertState({ blocked: false });
    })
    .catch((err: unknown) => {
      // Autoplay policy: the very first alert after a page load can be blocked
      // until the owner interacts with the page. The call itself is still
      // visible in WaiterCallsPanel, so this is a warning plus a note in the
      // sound menu — not an error the owner has to act on.
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        publishAlertState({ blocked: true });
      }
      console.warn(`Alert sound "${sound}" did not play:`, err);
    });
};

/**
 * Request Browser Notification Permission
 */
export const requestNotificationPermission = async () => {
  if (!("Notification" in window)) {
    console.log("This browser does not support desktop notification");
    return;
  }
  if (Notification.permission !== "denied" && Notification.permission !== "granted") {
    await Notification.requestPermission();
  }
};

/**
 * Show Browser Notification
 */
export const showBrowserNotification = (title: string, body?: string) => {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
};
