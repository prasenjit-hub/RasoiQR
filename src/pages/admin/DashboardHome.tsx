import React, { useCallback, useEffect, useState } from "react";
import {
  Store as StoreIcon,
  FileText,
  ShoppingBag,
  TrendingUp,
  AlertCircle,
} from "lucide-react";
import { Alert, Button, Card, Skeleton } from "../../components/ui";
import {
  computeMRR,
  getOrderBurstAlerts,
  getPlatformOverview,
  type OrderBurstAlert,
  type PlatformOverview,
} from "../../services/adminService";
import { formatCurrency, formatDateTime } from "../../utils/helpers";
import { Link } from "react-router-dom";

const DashboardHome: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [burstAlerts, setBurstAlerts] = useState<OrderBurstAlert[]>([]);

  // Apply a fetched overview. The state updates live in a callback on purpose:
  // they then happen inside `.then` / event handlers, never synchronously in an
  // effect body (react-hooks/set-state-in-effect).
  const applyOverview = useCallback(
    (result: Awaited<ReturnType<typeof getPlatformOverview>>) => {
      if (result.success) {
        setOverview(result.data);
        setError(null);
      } else {
        setOverview(null);
        setError(result.message);
      }

      setLoading(false);
    },
    []
  );

  // Initial load, with a cancellation guard so a fast unmount cannot apply a
  // stale result.
  useEffect(() => {
    let cancelled = false;

    getPlatformOverview().then((result) => {
      if (!cancelled) applyOverview(result);
    });

    return () => {
      cancelled = true;
    };
  }, [applyOverview]);

  // Burst alerts (migrations 042 + 049) load separately on purpose: they are
  // additive telemetry, so a failure here must never take the dashboard's real
  // numbers down with it — the error is logged and the card simply disappears.
  // The state update sits inside `.then`, never in the effect body
  // (react-hooks/set-state-in-effect, same reason as applyOverview above).
  useEffect(() => {
    let cancelled = false;

    getOrderBurstAlerts().then((result) => {
      if (cancelled) return;
      if (result.success) {
        setBurstAlerts(result.data);
      } else {
        console.warn(
          "Could not load order burst alerts:",
          result.message
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Retry: shows the skeleton again, then applies the fresh result.
  const loadStats = useCallback(async () => {
    setLoading(true);
    applyOverview(await getPlatformOverview());
  }, [applyOverview]);

  if (loading) {
    return (
      <div className="space-y-8">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-5 w-96" />
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <div className="flex items-start justify-between">
                <div>
                  <Skeleton className="h-4 w-32 mb-1" />
                  <Skeleton className="h-8 w-16" />
                </div>
                <Skeleton className="w-12 h-12 rounded-lg" />
              </div>
            </Card>
          ))}
        </div>
        <Card>
          <Skeleton className="h-6 w-32 mb-4" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="p-4 border border-border rounded-lg">
                <Skeleton className="w-8 h-8 mb-2" />
                <Skeleton className="h-5 w-32 mb-1" />
                <Skeleton className="h-4 w-48" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // A failed load must never masquerade as a row of zeros (the old
  // implementation swallowed every error and rendered 0 everywhere).
  if (error || !overview) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-text mb-2">
            Platform Overview
          </h2>
          <p className="text-text-secondary">
            Monitor your restaurant network performance
          </p>
        </div>
        <Alert
          type="error"
          title="Couldn't load the platform overview"
          message={error ?? "The overview returned no data."}
        />
        <Button
          variant="outline"
          onClick={() => void loadStats()}
          icon={<AlertCircle className="w-5 h-5" />}
        >
          Try again
        </Button>
      </div>
    );
  }

  const mrrResult = computeMRR(overview.paying_by_plan);

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div>
        <h2 className="text-2xl font-bold text-text mb-2">Platform Overview</h2>
        <p className="text-text-secondary">
          Monitor your restaurant network performance
        </p>
      </div>

      {/* Stats Grid — every number comes from admin_get_platform_overview
          (migration 037): GMV counts completed+ready only, cancelled orders
          are shown beside it, and "today" is the IST day. */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card className="hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-text-secondary text-sm mb-1">
                Paying Restaurants
              </p>
              <p className="text-3xl font-bold text-text">
                {overview.paying_restaurants}
              </p>
              <p className="text-sm text-text-secondary mt-1">
                MRR {formatCurrency(mrrResult.mrr)}
                {mrrResult.unpricedRestaurants > 0
                  ? ` · ${mrrResult.unpricedRestaurants} custom-priced`
                  : ""}{" "}
                · {overview.trialing_restaurants} on trial
              </p>
            </div>
            <div className="p-3 bg-success/10 rounded-lg">
              <StoreIcon className="w-6 h-6 text-success" />
            </div>
          </div>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-text-secondary text-sm mb-1">
                Orders Today (IST)
              </p>
              <p className="text-3xl font-bold text-text">
                {overview.orders_today}
              </p>
              <p className="text-sm text-text-secondary mt-1">
                {formatCurrency(overview.gmv_today)} GMV ·{" "}
                {overview.cancelled_today} cancelled
              </p>
            </div>
            <div className="p-3 bg-accent-secondary/10 rounded-lg">
              <ShoppingBag className="w-6 h-6 text-accent-secondary" />
            </div>
          </div>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-text-secondary text-sm mb-1">
                Orders (30 days)
              </p>
              <p className="text-3xl font-bold text-text">
                {overview.orders_30d}
              </p>
              <p className="text-sm text-text-secondary mt-1">
                {formatCurrency(overview.gmv_30d)} GMV ·{" "}
                {overview.cancelled_30d} cancelled
              </p>
            </div>
            <div className="p-3 bg-accent-secondary/10 rounded-lg">
              <TrendingUp className="w-6 h-6 text-accent-secondary" />
            </div>
          </div>
        </Card>

        <Card className="hover:shadow-md transition-shadow">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-text-secondary text-sm mb-1">
                Pending Requests
              </p>
              <p className="text-3xl font-bold text-text">
                {overview.pending_requests}
              </p>
              {overview.pending_requests > 0 && (
                <Link
                  to="/admin/requests"
                  className="text-sm text-accent hover:underline mt-2 inline-block"
                >
                  Review now →
                </Link>
              )}
            </div>
            <div className="p-3 bg-warning/10 rounded-lg">
              <FileText className="w-6 h-6 text-warning" />
            </div>
          </div>
        </Card>
      </div>

      {/* Platform health — network size plus the three signals an admin acts
          on: recent activity, trials about to lapse, blocked accounts. */}
      <Card>
        <h3 className="text-lg font-semibold text-text mb-4">
          Platform Health
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold text-text">
              {overview.active_restaurants_7d}
            </p>
            <p className="text-sm text-text-secondary">
              Ordered in the last 7 days
            </p>
          </div>
          <div>
            <p className="text-2xl font-bold text-text">
              {overview.trials_ending_7d}
            </p>
            <p className="text-sm text-text-secondary">
              Trials ending within 7 days
            </p>
          </div>
          <div>
            <p className="text-2xl font-bold text-text">
              {overview.blocked_restaurants}
            </p>
            <p className="text-sm text-text-secondary">Blocked</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-text">
              {overview.restaurants_total}
            </p>
            <p className="text-sm text-text-secondary">Restaurants total</p>
          </div>
        </div>
      </Card>

      {/* Quick Actions */}
      <Card>
        <h3 className="text-lg font-semibold text-text mb-4">Quick Actions</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <Link
            to="/admin/requests"
            className="p-4 border border-border rounded-lg hover:border-accent hover:bg-bg-subtle transition-all"
          >
            <FileText className="w-8 h-8 text-accent mb-2" />
            <h4 className="font-semibold text-text mb-1">Review Requests</h4>
            <p className="text-sm text-text-secondary">
              {overview.pending_requests} pending verification
            </p>
          </Link>

          <Link
            to="/admin/restaurants"
            className="p-4 border border-border rounded-lg hover:border-accent hover:bg-bg-subtle transition-all"
          >
            <StoreIcon className="w-8 h-8 text-accent mb-2" />
            <h4 className="font-semibold text-text mb-1">Manage Restaurants</h4>
            <p className="text-sm text-text-secondary">
              {overview.active_restaurants_7d} active in the last 7 days
            </p>
          </Link>

          <Link
            to="/admin/analytics"
            className="p-4 border border-border rounded-lg hover:border-accent hover:bg-bg-subtle transition-all"
          >
            <TrendingUp className="w-8 h-8 text-accent mb-2" />
            <h4 className="font-semibold text-text mb-1">View Analytics</h4>
            <p className="text-sm text-text-secondary">
              Platform performance metrics
            </p>
          </Link>
        </div>
      </Card>

      {/* Alert if pending requests */}
      {overview.pending_requests > 0 && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-4 flex items-start">
          <AlertCircle className="w-5 h-5 text-warning mr-3 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-text mb-1">Action Required</h4>
            <p className="text-text-secondary text-sm">
              You have {overview.pending_requests} pending registration request
              {overview.pending_requests > 1 ? "s" : ""} waiting for review.{" "}
              <Link
                to="/admin/requests"
                className="text-accent hover:underline font-medium"
              >
                Review now
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Trials about to lapse — the admin's queue for a nudge or a plan
          change before expiry blocks the owner. */}
      {overview.trials_ending_7d > 0 && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-4 flex items-start">
          <AlertCircle className="w-5 h-5 text-warning mr-3 flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-text mb-1">Trials Ending Soon</h4>
            <p className="text-text-secondary text-sm">
              {overview.trials_ending_7d} free trial
              {overview.trials_ending_7d > 1 ? "s" : ""} end within 7 days.{" "}
              <Link
                to="/admin/restaurants"
                className="text-accent hover:underline font-medium"
              >
                Review restaurants
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Order-burst tripwire — 042 (alert-only: the guest's order is never
          refused) and 049 (the reader). Before 049 this row had no consumer at
          all, so the signal existed only in the Postgres log. */}
      {burstAlerts.length > 0 && (
        <div className="bg-warning/10 border border-warning/20 rounded-lg p-4">
          <div className="flex items-start">
            <AlertCircle className="w-5 h-5 text-warning mr-3 flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h4 className="font-semibold text-text mb-1">
                Unusual Order Activity
              </h4>
              <p className="text-text-secondary text-sm">
                {burstAlerts.length} burst alert
                {burstAlerts.length > 1 ? "s" : ""} in the last 7 days.{" "}
                <strong>No orders were refused</strong> — this is a tripwire,
                not a cap. Check whether these were real rushes or abuse.
              </p>
              <ul className="mt-3 space-y-1.5">
                {burstAlerts.map((alert) => (
                  <li
                    key={alert.id}
                    className="text-sm text-text-secondary flex flex-wrap items-center gap-x-2"
                  >
                    <span className="font-medium text-text">
                      {alert.restaurant_name}
                    </span>
                    <span>
                      · {alert.orders_in_window} orders in{" "}
                      {alert.window_minutes} min
                    </span>
                    <span>· {formatDateTime(alert.created_at)}</span>
                    {alert.restaurant_slug && (
                      <Link
                        to={`/menu/${alert.restaurant_slug}`}
                        className="text-accent hover:underline"
                      >
                        open menu
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-text-secondary mt-3">
                Deduplicated to one alert per restaurant per 5 minutes, so a
                long rush still produces a short list.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DashboardHome;
