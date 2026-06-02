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

/**
 * Single unified AuthContext for the whole app.
 *
 * Resolves the authenticated user to one of:
 *   - admin       — has a row in admin_users with is_active = TRUE
 *   - restaurant  — has a row in public.users joined to a restaurant
 *   - none        — orphan or unauthenticated (auto signOut)
 *
 * Production-grade hardening (Phase 2.5):
 *   - `ready` flag with hard 3s timeout so the UI never gets stuck
 *     on "Verifying..." even if getSession() hangs
 *   - useRef dedup guard on loadProfile to avoid concurrent RPC calls
 *   - useIsMounted helper to silence setState-after-unmount warnings
 *   - Skips redundant INITIAL_SESSION / TOKEN_REFRESHED events in the
 *     auth state listener
 *
 * Phase 2 uses only the admin path. Phase 3 (off localStorage) will
 * start populating the restaurant path without any API change here.
 */

export interface AdminProfile {
  id: string;
  email: string;
  name: string | null;
  is_active: boolean;
  is_super_admin: boolean;
}

export interface RestaurantProfile {
  id: string;
  name: string;
  slug: string;
  email: string;
  is_active: boolean;
}

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
  resetPassword: (email: string) => Promise<{ error: string | null }>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  admin: null,
  restaurant: null,
  ready: false,
  signIn: async () => ({ success: false, error: "AuthProvider not mounted" }),
  signOut: async () => {},
  resetPassword: async () => ({ error: "AuthProvider not mounted" }),
});

export const useAuth = () => useContext(AuthContext);

// 3 seconds is the hard upper bound for the initial auth check.
// In practice, getSession() should resolve in < 100ms from localStorage.
const READY_TIMEOUT_MS = 3000;

/**
 * useIsMounted: returns a ref that is `true` while the component is mounted.
 * Use `safeSetState(ref.current, fn)` to avoid setState-after-unmount warnings.
 */
function useIsMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [admin, setAdmin] = useState<AdminProfile | null>(null);
  const [restaurant, setRestaurant] = useState<RestaurantProfile | null>(null);
  const [ready, setReady] = useState(false);

  // Dedup guard: prevents concurrent loadProfile calls for the same user.
  // The getSession() callback AND the onAuthStateChange listener can both
  // fire for a single sign-in; without this guard we'd hit the RPC twice.
  const profileFetchInFlight = useRef(false);

  const isMounted = useIsMounted();
  const safeSetState = useCallback(
    (fn: () => void) => {
      if (isMounted.current) fn();
    },
    [isMounted]
  );

  function clearAll() {
    setUser(null);
    setAdmin(null);
    setRestaurant(null);
  }

  // Resolve the auth user to a profile (admin or restaurant).
  // Idempotent — safe to call multiple times.
  // Uses SECURITY DEFINER RPCs (Phase 1 + 4) so the client never
  // queries admin_users / users / restaurants directly.
  const loadProfile = useCallback(
    async (authUser: User): Promise<"admin" | "restaurant" | null> => {
      // Skip if a profile load is already in flight
      if (profileFetchInFlight.current) {
        return null;
      }
      profileFetchInFlight.current = true;

      try {
        safeSetState(() => setUser(authUser));

        // 1. Try admin
        try {
          const { data: adminRows } = await supabase.rpc("get_my_admin_profile");
          if (adminRows && adminRows.length > 0) {
            safeSetState(() => {
              setAdmin(adminRows[0]);
              setRestaurant(null);
            });
            return "admin" as const;
          }
        } catch (err) {
          console.error("get_my_admin_profile error:", err);
        }

        // 2. Try restaurant owner
        try {
          const { data: restaurantRows } = await supabase.rpc(
            "get_my_restaurant_profile"
          );
          if (restaurantRows && restaurantRows.length > 0) {
            safeSetState(() => {
              setRestaurant(restaurantRows[0]);
              setAdmin(null);
            });
            return "restaurant" as const;
          }
        } catch (err) {
          console.error("get_my_restaurant_profile error:", err);
        }

        // 3. Orphan — auth user with no profile row
        await supabase.auth.signOut();
        safeSetState(clearAll);
        return null;
      } finally {
        profileFetchInFlight.current = false;
      }
    },
    [safeSetState]
  );

  // Initial session check + auth state listener.
  // `ready` is guaranteed to become `true` within READY_TIMEOUT_MS
  // no matter what happens with getSession() (network hang, RPC
  // error, etc.). The UI is keyed off `ready` instead of `loading`
  // to avoid the "stuck on Verifying..." bug.
  useEffect(() => {
    let cancelled = false;

    // Hard timeout — prevents the UI from being permanently stuck
    // if getSession() never resolves (e.g., PostgREST cache issue,
    // network partition, or a Supabase SDK deadlock).
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      console.warn(
        "[Auth] Initial auth check did not complete within " +
          READY_TIMEOUT_MS +
          "ms, forcing ready=true"
      );
      safeSetState(() => setReady(true));
    }, READY_TIMEOUT_MS);

    // 1. Initial session check
    supabase.auth
      .getSession()
      .then(async ({ data: { session } }) => {
        if (cancelled) return;
        clearTimeout(timeoutId);
        if (session?.user) {
          await loadProfile(session.user);
        }
        safeSetState(() => setReady(true));
      })
      .catch((err) => {
        if (cancelled) return;
        clearTimeout(timeoutId);
        console.error("[Auth] getSession() error:", err);
        safeSetState(() => setReady(true));
      });

    // 2. Auth state listener (fires for SIGNED_IN, SIGNED_OUT, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (cancelled) return;

        // INITIAL_SESSION fires automatically when the listener is
        // attached. Already handled by getSession() above, so skip.
        if (event === "INITIAL_SESSION") return;

        // TOKEN_REFRESHED: user is the same, just a new access token.
        // USER_UPDATED: user metadata changed, no profile reload needed.
        // Either way, don't hit the RPC again.
        if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
          return;
        }

        // SIGNED_IN, PASSWORD_RECOVERY, or any other event with a session
        if (session?.user) {
          await loadProfile(session.user);
        } else {
          // SIGNED_OUT
          safeSetState(clearAll);
        }
        safeSetState(() => setReady(true));
      }
    );

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      subscription.unsubscribe();
    };
  }, [loadProfile, safeSetState]);

  async function signIn(
    email: string,
    password: string
  ): Promise<SignInResult> {
    // 1. Supabase Auth — the session is returned in `data.session` directly.
    //    Don't call getSession() afterwards; that reads async-updated SDK
    //    state and can race with this caller.
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

    // 2. Resolve the profile. loadProfile is idempotent so even if the
    //    onAuthStateChange listener fires concurrently, the state is consistent.
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

  async function resetPassword(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(
      email.toLowerCase().trim(),
      {
        redirectTo: `${window.location.origin}/admin/reset-password`,
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
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
