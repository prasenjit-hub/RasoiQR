/* eslint-disable react-refresh/only-export-components */
// Context files commonly export both the Provider component AND the
// useXxx hook. The hot-reload rule complains about non-component
// exports, but in practice AuthContext is the standard pattern.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../config/supabase";
import type { Restaurant } from "../config/supabase";

/**
 * RasoiQR — Production-grade AuthContext (Phase 2.7)
 *
 * Uses @supabase/ssr createBrowserClient → cookie-based session
 * storage. This bypasses two known P0 bugs in @supabase/supabase-js:
 *   - Web Locks API deadlock in getSession/getUser
 *   - Async callback deadlock in onAuthStateChange
 *
 * Auth flow (simple, production-grade):
 *   1. getSession()  — reads from cookies (instant, no network)
 *   2. getUser()     — validates JWT with server (authoritative)
 *   3. loadProfile() — resolves user → admin or restaurant via RPC
 *
 * Safety mechanisms:
 *   - 5s outer timeout on refresh() — protects against network hang
 *     or any future SDK regression
 *   - profileFetchInFlight dedup — prevents concurrent RPC calls
 *     from rapid onAuthStateChange fires
 *   - mountedRef + safeSetState — React 19 StrictMode safety
 *   - setTimeout(0) in onAuthStateChange — Supabase canonical pattern
 *     (per official docs, async callbacks can deadlock the SDK)
 */

export interface AdminProfile {
  id: string;
  email: string;
  name: string | null;
  is_active: boolean;
  is_super_admin: boolean;
}

// Full Restaurant row (Phase 3 — get_my_restaurant_profile returns RETURNS restaurants).
export type RestaurantProfile = Restaurant;

export type SignInResult =
  | { success: true; role: "admin" | "restaurant" }
  | { success: false; error: string };

interface AuthContextValue {
  user: User | null;
  admin: AdminProfile | null;
  restaurant: RestaurantProfile | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string, redirectToPath: string) => Promise<{ error: string | null }>;
  /** Manually re-run the auth check. Useful for tab-focus refresh. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  admin: null,
  restaurant: null,
  ready: false,
  signIn: async () => ({ success: false, error: "AuthProvider not mounted" }),
  signOut: async () => {},
  resetPassword: async () => ({ error: "AuthProvider not mounted" }),
  refresh: async () => {},
});

export const useAuth = () => useContext(AuthContext);

// Outer timeout: protects against any future SDK regression or network
// hang. Industry standard for client auth flows (Vercel, Clerk, Auth0
// use 3-8s outer timeouts).
const REFRESH_TIMEOUT_MS = 8000;

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [admin, setAdmin] = useState<AdminProfile | null>(null);
  const [restaurant, setRestaurant] = useState<RestaurantProfile | null>(null);
  const [ready, setReady] = useState(false);

  // Dedup guard: prevents concurrent profile fetches.
  const profileFetchInFlight = useRef(false);

  // React 19 StrictMode-safe: track mount status, skip setState after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeSetState = useCallback((fn: () => void) => {
    if (mountedRef.current) fn();
  }, []);

  function clearAll() {
    setUser(null);
    setAdmin(null);
    setRestaurant(null);
  }

  // Load admin/restaurant profile for the given user via SECURITY
  // DEFINER RPCs. Client never queries admin_users/users directly.
  //
  // Orphan handling: only treat as orphan when BOTH RPCs return a
  // definitive empty result. If either errors (transient network blip,
  // rate limit, etc.), keep the user signed in — the protected route
  // shows "Not authorized" or a loading state. We never call
  // signOut() here: that would destroy the session cookies and force
  // a re-login on any transient RPC failure.
  const loadProfile = useCallback(
    async (authUser: User): Promise<"admin" | "restaurant" | null> => {
      if (profileFetchInFlight.current) {
        return null;
      }
      profileFetchInFlight.current = true;

      try {
        safeSetState(() => setUser(authUser));

        let adminConfirmedEmpty = false;
        let restaurantConfirmedEmpty = false;

        // 1. Try admin
        try {
          const { data: adminRows } = await supabase.rpc(
            "get_my_admin_profile"
          );
          if (adminRows && adminRows.length > 0) {
            safeSetState(() => {
              setAdmin(adminRows[0]);
              setRestaurant(null);
            });
            return "admin" as const;
          }
          if (adminRows !== null) {
            adminConfirmedEmpty = true;
          }
        } catch (err) {
          console.error("[Auth] get_my_admin_profile error:", err);
        }

        // 2. Try restaurant owner
        try {
          const { data: restaurantRows } = await supabase.rpc(
            "get_my_restaurant_profile"
          );
          // Normalize: PostgREST returns SETOF/RETURNS TABLE as an
          // array, but RETURNS <single row type> as a single object.
          // Handle both shapes defensively (Phase 3 lesson learned).
          const restaurantArray: Restaurant[] | null = Array.isArray(
            restaurantRows
          )
            ? (restaurantRows as Restaurant[])
            : restaurantRows
            ? [restaurantRows as Restaurant]
            : null;
          if (restaurantArray && restaurantArray.length > 0) {
            safeSetState(() => {
              setRestaurant(restaurantArray[0]);
              setAdmin(null);
            });
            return "restaurant" as const;
          }
          if (restaurantRows !== null) {
            restaurantConfirmedEmpty = true;
          }
        } catch (err) {
          console.error("[Auth] get_my_restaurant_profile error:", err);
        }

        // 3a. Definitive orphan: BOTH RPCs returned empty.
        // Keep user signed in (cookies preserved) so the protected
        // route can show "Not authorized" UI. Don't call signOut() —
        // that would destroy the session and force re-login.
        if (adminConfirmedEmpty && restaurantConfirmedEmpty) {
          console.warn(
            "[Auth] User has no admin or restaurant profile:",
            authUser.email
          );
          safeSetState(() => {
            setAdmin(null);
            setRestaurant(null);
          });
          return null;
        }

        // 3b. Incomplete: at least one RPC errored (transient).
        // Keep cookies, keep user signed in, no profile loaded.
        console.warn(
          "[Auth] Profile RPCs incomplete (transient), keeping user signed in"
        );
        return null;
      } finally {
        profileFetchInFlight.current = false;
      }
    },
    [safeSetState]
  );

  // THE CORE: simple, production-grade auth check.
  //   getSession()  → cookies, instant, untrusted
  //   getUser()     → server-validated JWT, authoritative
  //   loadProfile() → RPC resolution to admin/restaurant
  const doRefresh = useCallback(async (): Promise<void> => {
    // Step 1: cookies (fast, possibly stale)
    const sessionResult = await supabase.auth.getSession();
    const sessionUser: User | null = sessionResult.data.session?.user ?? null;

    // Step 2: server-validated JWT (authoritative)
    // Falls back to sessionUser if getUser fails transiently (network blip).
    let resolvedUser: User | null = null;
    try {
      const userResult = await supabase.auth.getUser();
      resolvedUser = userResult.data.user;
    } catch (err) {
      console.warn("[Auth] getUser failed, falling back to session:", err);
      resolvedUser = sessionUser;
    }

    if (!resolvedUser) {
      safeSetState(clearAll);
      return;
    }

    await loadProfile(resolvedUser);
  }, [safeSetState, loadProfile]);

  // Public refresh — wraps doRefresh with a 8s outer timeout.
  // Guarantees `ready=true` regardless of SDK/network state.
  // The 8s window is generous enough for cold Supabase server
  // responses on first call. doRefresh may still complete in the
  // background after timeout; either way, UI is unblocked.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      await Promise.race([
        doRefresh(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            console.debug(
              `[Auth] refresh() exceeded ${REFRESH_TIMEOUT_MS}ms — UI unblocked, doRefresh continues in background`
            );
            resolve();
          }, REFRESH_TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      console.error("[Auth] refresh error:", err);
    } finally {
      safeSetState(() => setReady(true));
    }
  }, [doRefresh, safeSetState]);

  // Lifecycle: initial check + reactive auth state listener.
  useEffect(() => {
    let cancelled = false;

    // Run the initial auth check.
    void (async () => {
      if (cancelled) return;
      await refresh();
    })();

    // Auth state listener for reactive updates.
    //
    // CRITICAL: this callback must NOT be async and must NOT call any
    // Supabase function directly. Per Supabase official docs:
    //
    //   "A callback can be an async function and it runs synchronously
    //    during the processing of the changes causing the event. You
    //    can easily create a dead-lock by using await on a call to
    //    another method of the Supabase library."
    //   - https://supabase.com/docs/reference/javascript/auth-onauthstatechange
    //
    // We schedule async work via setTimeout(0) so it runs AFTER the
    // event has been fully processed. This is the canonical pattern.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setTimeout(() => {
          if (cancelled) return;
          void (async () => {
            // INITIAL_SESSION: handled by refresh() above
            if (event === "INITIAL_SESSION") return;

            // TOKEN_REFRESHED / USER_UPDATED: user is unchanged
            if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
              return;
            }

            if (session?.user) {
              await loadProfile(session.user);
            } else {
              // SIGNED_OUT or token cleared
              safeSetState(clearAll);
            }
          })();
        }, 0);
      }
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [refresh, safeSetState, loadProfile]);

  async function signIn(
    email: string,
    password: string
  ): Promise<SignInResult> {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.toLowerCase().trim(),
      password,
    });
    if (error) {
      return { success: false, error: error.message };
    }
    if (!data.session?.user) {
      return { success: false, error: "Authentication failed (no session)" };
    }

    const role = await loadProfile(data.session.user);
    if (role === "admin" || role === "restaurant") {
      return { success: true, role };
    }
    return {
      success: false,
      error: "Account not authorized for this application",
    };
  }

  async function signOut() {
    await supabase.auth.signOut();
    safeSetState(clearAll);
  }

  async function resetPassword(email: string, redirectToPath: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(
      email.toLowerCase().trim(),
      {
        redirectTo: `${window.location.origin}${redirectToPath}`,
      }
    );
    return { error: error?.message ?? null };
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        admin,
        restaurant,
        ready,
        signIn,
        signOut,
        resetPassword,
        refresh,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
