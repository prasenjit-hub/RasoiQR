/**
 * "Something new arrived on a tab you are not looking at" flags for the
 * restaurant dashboard nav — the orange dot beside Dashboard / Orders.
 *
 * Deliberately in memory, not stored: the dot answers "did anything arrive
 * while I was somewhere else in this session?". It starts empty on every load
 * and clears the moment its own page is on screen, so a refresh never shows a
 * dot for work that was already handled and nothing stale can stick to the tab.
 */
export type UnseenTab = "dashboard" | "orders";

const tabs = new Set<UnseenTab>();
const listeners = new Set<() => void>();

/** Replaced (never mutated) when something changes, so React can read it by identity. */
let snapshot: UnseenTab[] = [];

const publish = () => {
  snapshot = [...tabs];
  listeners.forEach((listener) => listener());
};

export const getUnseenTabs = (): UnseenTab[] => snapshot;

export const subscribeUnseenTabs = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Which nav tab a pathname belongs to (null = a tab that never dots).
 *
 * The two are told apart by exact match: `/restaurant` is a prefix of every
 * child route, so a `startsWith` would make the Orders page count as the
 * Dashboard.
 */
export const unseenTabForPath = (pathname: string): UnseenTab | null => {
  if (pathname === "/restaurant/orders") return "orders";
  if (pathname === "/restaurant" || pathname === "/restaurant/") return "dashboard";
  return null;
};

export const markTabUnseen = (tab: UnseenTab) => {
  if (tabs.has(tab)) return;
  tabs.add(tab);
  publish();
};

export const markTabSeen = (tab: UnseenTab) => {
  if (!tabs.has(tab)) return;
  tabs.delete(tab);
  publish();
};
