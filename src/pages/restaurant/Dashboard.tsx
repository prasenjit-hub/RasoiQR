import React, { useEffect, useSyncExternalStore } from "react";
import {
  useNavigate,
  Routes,
  Route,
  Link,
  useLocation,
  Navigate,
} from "react-router-dom";
import {
  LogOut,
  LayoutDashboard,
  ShoppingBag,
  UtensilsCrossed,
  FileText,
  Settings,
} from "lucide-react";
import { Loading, IconLogo } from "../../components/ui";
import { useAuth } from "../../contexts/AuthContext";
import RestaurantHome from "./RestaurantHome";
import Orders from "./Orders";
import Menu from "./Menu";
import Reports from "./Reports";
import RestaurantSettings from "./RestaurantSettings";
import NotAuthorized from "../admin/NotAuthorized";

import BlockedAccount from "./BlockedAccount";
import SubscriptionBanner from "./components/SubscriptionBanner";
import AlertSoundMenu from "./components/AlertSoundMenu";
import { supabase } from "../../config/supabase";
import { playAlertSound, preloadAlertSounds } from "../../utils/helpers";
import {
  getUnseenTabs,
  markTabSeen,
  markTabUnseen,
  subscribeUnseenTabs,
  unseenTabForPath,
  type UnseenTab,
} from "../../utils/unseenAlerts";
import { needsForcedPasswordChange } from "../../utils/authGuards";

const RestaurantDashboard: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, restaurant, ready, signOut } = useAuth();
  const unseenTabs = useSyncExternalStore(subscribeUnseenTabs, getUnseenTabs);

  // Opening a tab clears its dot — the page the dot was pointing at is now on
  // screen. Runs on navigation only, which is why the event handlers below also
  // check where the owner already is.
  useEffect(() => {
    const openTab = unseenTabForPath(location.pathname);
    if (openTab) markTabSeen(openTab);
  }, [location.pathname]);

  useEffect(() => {
    if (!restaurant) return;

    /**
     * Where the owner is *right now*, read at event time.
     *
     * `BrowserRouter` keeps `window.location.pathname` current, and unlike
     * `location` from `useLocation` it is not frozen into this effect's closure
     * (the channels must not be torn down and rebuilt on every navigation).
     */
    const currentTab = () => unseenTabForPath(window.location.pathname);

    // Start the two chimes downloading now instead of when the first alert
    // fires: a beep that arrives with the file it needs is a beep that arrives
    // late. Cheap (58KB + 38KB) and only runs on a signed-in screen.
    preloadAlertSounds();

    const orderChannel = supabase
      .channel(`global-order-alerts-${restaurant.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "orders",
          filter: `restaurant_id=eq.${restaurant.id}`,
        },
        (payload) => {
          if (payload.new.status !== "pending") return;

          playAlertSound("order");

          // Dot the Orders tab only if the order is *unseen*: with the Orders
          // page itself already on screen there is nothing to point at (and
          // that page shows the pending count in its own header).
          if (currentTab() !== "orders") markTabUnseen("orders");
        }
      )
      .subscribe();

    // Migration 036: a waiter call must be heard from every tab, not only from
    // the home dashboard where the list renders. This runs in the shell so the
    // sound is guaranteed once per call — WaiterCallsPanel deliberately does not
    // play it, otherwise the owner would hear two beeps for one tap. Realtime
    // only delivers rows the subscriber may SELECT (authenticated keeps SELECT
    // on waiter_calls, scoped by the owner policy), so this needs that grant to
    // stay in place.
    const waiterChannel = supabase
      .channel(`global-waiter-alerts-${restaurant.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "waiter_calls",
          filter: `restaurant_id=eq.${restaurant.id}`,
        },
        () => {
          playAlertSound("waiter");

          // Waiter calls are answered from the dashboard home (WaiterCallsPanel),
          // so that is the tab worth dotting — and the one that is already on
          // screen when the owner is looking straight at the panel.
          if (currentTab() !== "dashboard") markTabUnseen("dashboard");
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(orderChannel);
      void supabase.removeChannel(waiterChannel);
    };
  }, [restaurant]);

  if (!ready) {
    return <Loading text="Verifying session..." />;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (!restaurant) {
    return <NotAuthorized />;
  }
  if (!restaurant.is_active || restaurant.status === "blocked") {
    return <BlockedAccount />;
  }
  // Migration 031: setup is done but the owner still uses the temp password.
  // Guarding here as well as on login means a direct URL cannot skip it.
  if (needsForcedPasswordChange(user, restaurant)) {
    return <Navigate to="/change-password" replace />;
  }

  const handleLogout = async () => {
    await signOut();
    navigate("/login");
  };

  // `tab` is the tab an arriving alert may dot: a new order points at Orders,
  // a waiter call at the home dashboard, where the queue that answers it lives.
  const navItems: {
    path: string;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    tab?: UnseenTab;
  }[] = [
    { path: "/restaurant", icon: LayoutDashboard, label: "Dashboard", tab: "dashboard" },
    { path: "/restaurant/orders", icon: ShoppingBag, label: "Orders", tab: "orders" },
    { path: "/restaurant/menu", icon: UtensilsCrossed, label: "Menu" },
    { path: "/restaurant/reports", icon: FileText, label: "Reports" },
    { path: "/restaurant/settings", icon: Settings, label: "Settings" },
  ];

  return (
    <div className="min-h-screen bg-bg-subtle">
      {/* Top Navigation */}
      <nav className="bg-white border-b border-border sticky top-0 z-40">
        <div className="container-custom">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-3 min-w-0">
              <IconLogo className="w-8 h-8 text-accent flex-shrink-0" />
              <div className="min-w-0">
                <h1 className="text-lg font-bold text-text truncate">
                  {restaurant.name}
                </h1>
                <p className="text-xs text-text-secondary truncate">{user.email}</p>
              </div>
            </div>
            {/* The chime controls ride with the shell, not with one page: the
                kitchen tablet can be sitting on Orders or Reports and still
                needs to raise or silence the alerts. */}
            <div className="flex items-center gap-1">
              <AlertSoundMenu />
              <button
                onClick={handleLogout}
                className="flex items-center space-x-2 text-text-secondary hover:text-error transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </div>
      </nav>

      {/* Secondary Navigation */}
      <div className="bg-white border-b border-border">
        <div className="container-custom">
          {/* Wraps on a phone. As a scroller the last two tabs (Reports,
              Settings) sat off-screen with no scrollbar and no cut-off edge to
              hint at them, so the navigation looked like it had three items. */}
          <div className="flex flex-wrap gap-x-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              const isUnseen = item.tab ? unseenTabs.includes(item.tab) : false;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  // `px-3` on a phone is what lets the five tabs land in two
                  // rows instead of three; from `sm` up the padding is unchanged.
                  className={`flex items-center space-x-2 px-3 py-3 sm:px-4 border-b-2 transition-colors whitespace-nowrap ${
                    isActive
                      ? "border-accent text-accent font-medium"
                      : "border-transparent text-text-secondary hover:text-text"
                  }`}
                >
                  {/* The dot sits on the icon's corner rather than beside the
                      label: it marks the tab itself, and the white ring keeps it
                      crisp on the white bar instead of letting it bleed into the
                      glyph. Clicking through is what clears it. */}
                  <span className="relative">
                    <item.icon className="w-5 h-5" />
                    {isUnseen && (
                      <span
                        className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-brand ring-2 ring-white"
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span>{item.label}</span>
                  {/* Colour alone says nothing to a screen reader. */}
                  {isUnseen && <span className="sr-only"> — new activity</span>}
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container-custom py-8">
        <SubscriptionBanner />
        <Routes>
          <Route index element={<RestaurantHome />} />
          <Route path="orders" element={<Orders />} />
          <Route path="menu" element={<Menu />} />
          <Route path="reports" element={<Reports />} />
          <Route path="settings" element={<RestaurantSettings />} />
        </Routes>
      </div>
    </div>
  );
};

export default RestaurantDashboard;
