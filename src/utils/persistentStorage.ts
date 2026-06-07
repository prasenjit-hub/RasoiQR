const COOKIE_PREFIX = "rq_";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const COOKIE_PATH = "/";
const COOKIE_SAMESITE = "Lax";
const IS_HTTPS =
  typeof window !== "undefined" && window.location.protocol === "https:";

const isDebug =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("rqDebug") === "1";

function log(...args: unknown[]) {
  if (isDebug) {
    console.log("[persistentStorage]", ...args);
  }
}

function getCookie(name: string): string | null {
  const cookies = document.cookie.split("; ");
  for (const cookie of cookies) {
    const eqIdx = cookie.indexOf("=");
    if (eqIdx === -1) continue;
    const k = cookie.slice(0, eqIdx);
    if (k !== name) continue;
    const v = cookie.slice(eqIdx + 1);
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

function setCookie(name: string, value: string): void {
  const secureFlag = IS_HTTPS ? "; Secure" : "";
  document.cookie =
    `${name}=${encodeURIComponent(value)}; ` +
    `max-age=${COOKIE_MAX_AGE}; ` +
    `path=${COOKIE_PATH}; ` +
    `SameSite=${COOKIE_SAMESITE}${secureFlag}`;
}

function deleteCookie(name: string): void {
  document.cookie =
    `${name}=; max-age=0; path=${COOKIE_PATH}; SameSite=${COOKIE_SAMESITE}`;
}

export const persistentStorage = {
  getItem(key: string): string | null {
    log("getItem", key);
    try {
      const v = window.localStorage.getItem(key);
      log("  localStorage result:", v === null ? "null" : "value");
      if (v !== null) {
        if (getCookie(COOKIE_PREFIX + key) === null) {
          setCookie(COOKIE_PREFIX + key, v);
        }
        return v;
      }
    } catch (e) {
      log("  localStorage error:", e);
    }
    const cookie = getCookie(COOKIE_PREFIX + key);
    log("  cookie result:", cookie === null ? "null" : "value");
    return cookie;
  },

  setItem(key: string, value: string): void {
    log("setItem", key, value);
    try {
      window.localStorage.setItem(key, value);
      log("  localStorage: written");
    } catch (e) {
      log("  localStorage error:", e);
    }
    try {
      setCookie(COOKIE_PREFIX + key, value);
      log("  cookie: written");
    } catch (e) {
      log("  cookie error:", e);
    }
  },

  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
    }
    deleteCookie(COOKIE_PREFIX + key);
  },
};
