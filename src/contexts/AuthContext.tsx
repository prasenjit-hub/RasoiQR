/* eslint-disable react-refresh/only-export-components */
// Context files commonly export both the Provider component AND the
// useXxx hook. The hot-reload rule complains about non-component
// exports, but in practice AuthContext is the standard pattern.

import { createContext, useContext, useEffect, useState, useCallback } from "react";
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
  loading: boolean;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error: string | null }>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  admin: null,
  restaurant: null,
  loading: true,
  signIn: async () => ({ success: false, error: "AuthProvider not mounted" }),
  signOut: async () => {},
  resetPassword: async () => ({ error: "AuthProvider not mounted" }),
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [admin, setAdmin] = useState<AdminProfile | null>(null);
  const [restaurant, setRestaurant] = useState<RestaurantProfile | null>(null);
  const [loading, setLoading] = useState(true);

  function clearAll() {
    setUser(null);
    setAdmin(null);
    setRestaurant(null);
  }

  // Resolve the auth user to a profile (admin or restaurant).
  // Idempotent — safe to call multiple times.
  // Uses SECURITY DEFINER RPCs (Phase 1 + 4) so the client never
  // queries admin_users / users / restaurants directly.
  const loadProfile = useCallback(async (authUser: User) => {
    setUser(authUser);

    // 1. Try admin
    try {
      const { data: adminRows } = await supabase.rpc("get_my_admin_profile");
      if (adminRows && adminRows.length > 0) {
        setAdmin(adminRows[0]);
        setRestaurant(null);
        return "admin" as const;
      }
    } catch (err) {
      console.error("get_my_admin_profile error:", err);
    }

    // 2. Try restaurant owner
    try {
      const { data: restaurantRows } = await supabase.rpc("get_my_restaurant_profile");
      if (restaurantRows && restaurantRows.length > 0) {
        setRestaurant(restaurantRows[0]);
        setAdmin(null);
        return "restaurant" as const;
      }
    } catch (err) {
      console.error("get_my_restaurant_profile error:", err);
    }

    // 3. Orphan — auth user with no profile row
    await supabase.auth.signOut();
    clearAll();
    return null;
  }, []);

  // Initial session check + auth state listener
  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (cancelled) return;
      if (session?.user) {
        await loadProfile(session.user);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        if (cancelled) return;
        if (session?.user) {
          await loadProfile(session.user);
        } else {
          clearAll();
        }
      }
    );

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  async function signIn(email: string, password: string): Promise<SignInResult> {
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
    return { success: false, error: "Account not authorized for this application" };
  }

  async function signOut() {
    await supabase.auth.signOut();
    clearAll();
  }

  async function resetPassword(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email.toLowerCase().trim(), {
      redirectTo: `${window.location.origin}/admin/reset-password`,
    });
    return { error: error?.message ?? null };
  }

  return (
    <AuthContext.Provider
      value={{ user, admin, restaurant, loading, signIn, signOut, resetPassword }}
    >
      {children}
    </AuthContext.Provider>
  );
};
