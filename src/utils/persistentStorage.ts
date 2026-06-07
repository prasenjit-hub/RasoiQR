const COOKIE_PREFIX = "rq_";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const COOKIE_PATH = "/";
const COOKIE_SAMESITE = "Lax";

function escapeRegex(str: string): string {
  return str.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1");
}

function getCookie(name: string): string | null {
  const escaped = escapeRegex(name);
  const match = document.cookie.match(
    new RegExp("(?:^|; )" + escaped + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string): void {
  document.cookie =
    `${name}=${encodeURIComponent(value)}; ` +
    `max-age=${COOKIE_MAX_AGE}; ` +
    `path=${COOKIE_PATH}; ` +
    `SameSite=${COOKIE_SAMESITE}`;
}

function deleteCookie(name: string): void {
  document.cookie =
    `${name}=; max-age=0; path=${COOKIE_PATH}; SameSite=${COOKIE_SAMESITE}`;
}

export const persistentStorage = {
  getItem(key: string): string | null {
    try {
      const v = window.localStorage.getItem(key);
      if (v !== null) {
        if (getCookie(COOKIE_PREFIX + key) === null) {
          setCookie(COOKIE_PREFIX + key, v);
        }
        return v;
      }
    } catch {
    }
    return getCookie(COOKIE_PREFIX + key);
  },

  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
    }
    setCookie(COOKIE_PREFIX + key, value);
  },

  removeItem(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
    }
    deleteCookie(COOKIE_PREFIX + key);
  },
};
