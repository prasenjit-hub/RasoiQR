import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  TrendingUp,
  ShoppingBag,
  XCircle,
  IndianRupee,
  ArrowUpDown,
  AlertCircle,
} from "lucide-react";
import {
  ComposedChart,
  Bar,
  BarChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Alert, Button, Card, Skeleton } from "../../components/ui";
import {
  getAnalyticsDaily,
  getPeakHours,
  getRestaurantLeaderboard,
  getOrderFunnel,
  getWaiterCallStats,
  type AnalyticsDay,
  type PeakHourBucket,
  type RestaurantLeaderboardRow,
  type OrderFunnel,
  type WaiterCallStats,
} from "../../services/adminService";
import { formatCurrency } from "../../utils/helpers";

type Range = 7 | 30 | 90;
type SortKey = "gmv" | "orders" | "cancelled" | "menu_items" | "last_order_at";

const RANGE_OPTIONS: Range[] = [7, 30, 90];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "45s" / "2.4m" / "3.1h" / "2.5d" — null (no data) renders an em dash. */
const formatSeconds = (seconds: number | null): string => {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
};

const lastOrderTime = (iso: string | null): number =>
  iso ? new Date(iso).getTime() : 0;

/** "Today" / "Yesterday" / "12d ago" / "Never" for the last-order column. */
const daysSinceLabel = (iso: string | null): string => {
  if (!iso) return "Never";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days}d ago`;
};

const planBadgeClass = (plan: string): string => {
  switch (plan) {
    case "starter":
      return "bg-success/10 text-success";
    case "pro":
      return "bg-accent-secondary/10 text-accent-secondary";
    case "enterprise":
      return "bg-gray-100 text-gray-700";
    default:
      return "bg-warning/10 text-warning";
  }
};

const statusLabel = (row: RestaurantLeaderboardRow): string => {
  if (row.status === "blocked" || !row.is_active) return "Blocked";
  if (row.status === "trial") return "Trial";
  return "Active";
};

const Analytics: React.FC = () => {
  const [range, setRange] = useState<Range>(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [allFailed, setAllFailed] = useState(false);
  const [daily, setDaily] = useState<AnalyticsDay[]>([]);
  const [peak, setPeak] = useState<PeakHourBucket[]>([]);
  const [leaderboard, setLeaderboard] = useState<RestaurantLeaderboardRow[]>([]);
  const [funnel, setFunnel] = useState<OrderFunnel | null>(null);
  const [waiterStats, setWaiterStats] = useState<WaiterCallStats | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("gmv");
  // Captured when data arrives, not during render: the purity rule forbids
  // Date.now() in render, and "trials ending soon" only needs the moment the
  // page was loaded.
  const [loadedAt, setLoadedAt] = useState(0);

  // Apply the five fetched reports. The state updates live in a callback on
  // purpose: they then happen inside `.then` / event handlers, never
  // synchronously in an effect body (react-hooks/set-state-in-effect).
  const applyResults = useCallback(
    (
      dailyRes: Awaited<ReturnType<typeof getAnalyticsDaily>>,
      peakRes: Awaited<ReturnType<typeof getPeakHours>>,
      boardRes: Awaited<ReturnType<typeof getRestaurantLeaderboard>>,
      funnelRes: Awaited<ReturnType<typeof getOrderFunnel>>,
      waiterRes: Awaited<ReturnType<typeof getWaiterCallStats>>
    ) => {
      const failed: string[] = [];

      if (dailyRes.success) setDaily(dailyRes.data);
      else failed.push("daily trend");
      if (peakRes.success) setPeak(peakRes.data);
      else failed.push("peak hours");
      if (boardRes.success) setLeaderboard(boardRes.data);
      else failed.push("restaurant leaderboard");
      if (funnelRes.success) setFunnel(funnelRes.data);
      else failed.push("order funnel");
      if (waiterRes.success) setWaiterStats(waiterRes.data);
      else failed.push("waiter calls");

      setLoadedAt(Date.now());
      setAllFailed(failed.length === 5);
      setError(
        failed.length === 0
          ? null
          : failed.length === 5
          ? "Couldn't load the analytics. Check your connection and try again."
          : `Some sections could not be loaded: ${failed.join(", ")}.`
      );
      setLoading(false);
    },
    []
  );

  // Initial load / range change, with a cancellation guard so a fast remount
  // or a quick range switch cannot apply a stale result.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      getAnalyticsDaily(range),
      getPeakHours(range),
      getRestaurantLeaderboard(range),
      getOrderFunnel(range),
      getWaiterCallStats(range),
    ]).then(([dailyRes, peakRes, boardRes, funnelRes, waiterRes]) => {
      if (!cancelled) {
        applyResults(dailyRes, peakRes, boardRes, funnelRes, waiterRes);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [range, applyResults]);

  // Retry: shows the skeleton again, then applies the fresh result.
  const loadAll = useCallback(async () => {
    setLoading(true);
    const [dailyRes, peakRes, boardRes, funnelRes, waiterRes] =
      await Promise.all([
        getAnalyticsDaily(range),
        getPeakHours(range),
        getRestaurantLeaderboard(range),
        getOrderFunnel(range),
        getWaiterCallStats(range),
      ]);
    applyResults(dailyRes, peakRes, boardRes, funnelRes, waiterRes);
  }, [range, applyResults]);

  const changeRange = (next: Range) => {
    if (next === range) return;
    setRange(next);
    setLoading(true);
  };

  // ── Derived numbers ───────────────────────────────────────────────────────

  const totals = useMemo(
    () => ({
      orders: daily.reduce((sum, d) => sum + d.orders, 0),
      gmv: daily.reduce((sum, d) => sum + d.gmv, 0),
      cancelled: daily.reduce((sum, d) => sum + d.cancelled, 0),
    }),
    [daily]
  );
  const aov = totals.orders > 0 ? totals.gmv / totals.orders : 0;

  const trendData = useMemo(
    () =>
      daily.map((d) => ({
        label: new Date(`${d.day}T00:00:00`).toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
        }),
        orders: d.orders,
        gmv: d.gmv,
      })),
    [daily]
  );

  const hourTotals = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, h) => ({
      label: h.toString().padStart(2, "0"),
      orders: 0,
    }));
    peak.forEach((b) => {
      if (b.hour >= 0 && b.hour < 24) buckets[b.hour].orders += b.orders;
    });
    return buckets;
  }, [peak]);

  const dowTotals = useMemo(() => {
    const buckets = WEEKDAY_LABELS.map((label) => ({ label, orders: 0 }));
    peak.forEach((b) => {
      if (b.dow >= 0 && b.dow < 7) buckets[b.dow].orders += b.orders;
    });
    return buckets;
  }, [peak]);

  const busiestHour = useMemo(() => {
    const best = hourTotals.reduce(
      (top, cur) => (cur.orders > top.orders ? cur : top),
      hourTotals[0]
    );
    return best.orders > 0 ? best.label : null;
  }, [hourTotals]);

  const statusMix = useMemo(() => {
    if (!funnel) return [];
    return [
      { name: "Pending", value: funnel.pending, color: "#f59e0b" },
      { name: "Accepted", value: funnel.accepted, color: "#0ea5e9" },
      { name: "Preparing", value: funnel.preparing, color: "#8b5cf6" },
      { name: "Ready", value: funnel.ready, color: "#22c55e" },
      { name: "Completed", value: funnel.completed, color: "#16a34a" },
      { name: "Cancelled", value: funnel.cancelled, color: "#ef4444" },
      { name: "Rejected", value: funnel.rejected, color: "#991b1b" },
    ].filter((entry) => entry.value > 0);
  }, [funnel]);

  const funnelRows = useMemo(() => {
    if (!funnel) return [];
    const cancelledAll = funnel.cancelled + funnel.rejected;
    const allOrders = funnel.placed + cancelledAll;
    return [
      { label: "Placed", value: funnel.placed, color: "#0ea5e9", note: "" },
      {
        label: "Completed",
        value: funnel.completed,
        color: "#16a34a",
        note:
          funnel.placed > 0
            ? `${Math.round((funnel.completed / funnel.placed) * 100)}% of placed`
            : "",
      },
      {
        label: "Cancelled / rejected",
        value: cancelledAll,
        color: "#ef4444",
        note:
          allOrders > 0
            ? `${Math.round((cancelledAll / allOrders) * 100)}% of all`
            : "",
      },
    ];
  }, [funnel]);

  const sortedBoard = useMemo(() => {
    const copy = [...leaderboard];
    copy.sort((a, b) => {
      if (sortKey === "last_order_at") {
        return lastOrderTime(b.last_order_at) - lastOrderTime(a.last_order_at);
      }
      return Number(b[sortKey]) - Number(a[sortKey]);
    });
    return copy;
  }, [leaderboard, sortKey]);

  const activation = useMemo(() => {
    const soon = loadedAt + 7 * 86400000;
    return {
      noMenu: leaderboard.filter((r) => r.menu_items === 0),
      noOrders: leaderboard.filter((r) => r.orders === 0 && r.cancelled === 0),
      neverOrdered: leaderboard.filter((r) => !r.last_order_at),
      trialsEnding: leaderboard.filter(
        (r) =>
          r.subscription_plan === "free_trial" &&
          r.is_active &&
          r.trial_ends_at !== null &&
          new Date(r.trial_ends_at).getTime() <= soon
      ),
    };
  }, [leaderboard, loadedAt]);

  // ── States ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-10 w-64 rounded-lg" />
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-24 mb-3" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-28 mt-2" />
            </Card>
          ))}
        </div>
        <Card>
          <Skeleton className="h-6 w-48 mb-4" />
          <Skeleton className="h-[300px] w-full" />
        </Card>
        <div className="grid lg:grid-cols-2 gap-6">
          <Card>
            <Skeleton className="h-6 w-40 mb-4" />
            <Skeleton className="h-[220px] w-full" />
          </Card>
          <Card>
            <Skeleton className="h-6 w-40 mb-4" />
            <Skeleton className="h-[220px] w-full" />
          </Card>
        </div>
      </div>
    );
  }

  if (allFailed) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-text mb-2">Analytics</h2>
          <p className="text-text-secondary">
            Platform performance and insights
          </p>
        </div>
        <Alert
          type="error"
          title="Couldn't load the analytics"
          message={error ?? "The analytics RPCs returned no data."}
        />
        <Button
          variant="outline"
          onClick={() => void loadAll()}
          icon={<AlertCircle className="w-5 h-5" />}
        >
          Try again
        </Button>
      </div>
    );
  }

  // ── Page ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header + range selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-text mb-2">Analytics</h2>
          <p className="text-text-secondary">
            Platform performance and insights — every day boundary is IST
          </p>
        </div>
        <div className="flex gap-2">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              onClick={() => changeRange(option)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                range === option
                  ? "bg-gray-900 text-white"
                  : "bg-white border border-border text-text-secondary hover:text-text"
              }`}
            >
              {option} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <Alert
          type="warning"
          title="Some sections didn't load"
          message={error}
        />
      )}

      {/* KPI row — same definitions as admin_get_platform_overview (037) */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="p-3 bg-accent/10 rounded-lg">
              <ShoppingBag className="w-5 h-5 text-accent" />
            </div>
          </div>
          <div className="text-2xl font-bold text-text mb-1">
            {totals.orders}
          </div>
          <p className="text-text-secondary text-sm">
            Orders placed · last {range} days
          </p>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="p-3 bg-success/10 rounded-lg">
              <IndianRupee className="w-5 h-5 text-success" />
            </div>
          </div>
          <div className="text-2xl font-bold text-text mb-1">
            {formatCurrency(totals.gmv)}
          </div>
          <p className="text-text-secondary text-sm">
            GMV · completed + ready only
          </p>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="p-3 bg-accent-secondary/10 rounded-lg">
              <TrendingUp className="w-5 h-5 text-accent-secondary" />
            </div>
          </div>
          <div className="text-2xl font-bold text-text mb-1">
            {totals.orders > 0 ? formatCurrency(aov) : "—"}
          </div>
          <p className="text-text-secondary text-sm">Average order value</p>
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-3">
            <div className="p-3 bg-error/10 rounded-lg">
              <XCircle className="w-5 h-5 text-error" />
            </div>
          </div>
          <div className="text-2xl font-bold text-text mb-1">
            {totals.cancelled}
          </div>
          <p className="text-text-secondary text-sm">
            Cancelled / rejected · never in GMV
          </p>
        </Card>
      </div>

      {/* Trend */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-text">
            Orders &amp; GMV trend
          </h3>
          <span className="text-xs text-text-secondary">
            {range} IST days · zero days included
          </span>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="label"
              stroke="#6b7280"
              tick={{ fontSize: 12 }}
              minTickGap={24}
            />
            <YAxis
              yAxisId="left"
              stroke="#6b7280"
              allowDecimals={false}
              tick={{ fontSize: 12 }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#6b7280"
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
              }}
              formatter={(value, name) =>
                name === "GMV"
                  ? formatCurrency(Number(value ?? 0))
                  : String(value ?? 0)
              }
            />
            <Legend />
            <Bar
              yAxisId="left"
              dataKey="orders"
              name="Orders"
              fill="#4ECDC4"
              radius={[4, 4, 0, 0]}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="gmv"
              name="GMV"
              stroke="#FF6B6B"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
        {totals.orders === 0 && (
          <p className="text-sm text-text-secondary text-center mt-2">
            No placed orders in this range yet.
          </p>
        )}
      </Card>

      {/* Peak hours + weekday mix */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-bold text-text">Peak hours (IST)</h3>
              <p className="text-sm text-text-secondary">
                Placed orders by hour of day
              </p>
            </div>
            {busiestHour && (
              <span className="text-xs font-semibold bg-amber-50 text-amber-700 px-2 py-1 rounded-lg">
                Busiest: {busiestHour}:00
              </span>
            )}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={hourTotals}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey="label"
                stroke="#6b7280"
                tick={{ fontSize: 11 }}
                interval={2}
              />
              <YAxis stroke="#6b7280" allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                }}
              />
              <Bar
                dataKey="orders"
                name="Orders"
                fill="#FFA07A"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <div className="mb-4">
            <h3 className="text-lg font-bold text-text">Busiest days</h3>
            <p className="text-sm text-text-secondary">
              Placed orders by weekday
            </p>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dowTotals}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis dataKey="label" stroke="#6b7280" tick={{ fontSize: 12 }} />
              <YAxis stroke="#6b7280" allowDecimals={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#fff",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                }}
              />
              <Bar
                dataKey="orders"
                name="Orders"
                fill="#45B7D1"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Funnel + status mix */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <div className="mb-4">
            <h3 className="text-lg font-bold text-text">Order funnel</h3>
            <p className="text-sm text-text-secondary">
              Placed → completed, with service times
            </p>
          </div>

          <div className="space-y-3">
            {funnelRows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: row.color }}
                  />
                  <span className="text-sm text-text">{row.label}</span>
                </div>
                <div className="text-right">
                  <span className="font-semibold text-text">{row.value}</span>
                  {row.note && (
                    <span className="text-xs text-text-secondary ml-2">
                      {row.note}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-4 mt-5 pt-4 border-t border-border">
            <div>
              <p className="text-2xl font-bold text-text">
                {formatSeconds(funnel?.median_accept_seconds ?? null)}
              </p>
              <p className="text-sm text-text-secondary">
                Median time to accept
              </p>
            </div>
            <div>
              <p className="text-2xl font-bold text-text">
                {formatSeconds(funnel?.median_ready_seconds ?? null)}
              </p>
              <p className="text-sm text-text-secondary">
                Median time to ready
              </p>
            </div>
          </div>
        </Card>

        <Card>
          <div className="mb-4">
            <h3 className="text-lg font-bold text-text">Status mix</h3>
            <p className="text-sm text-text-secondary">
              Current status of orders in this range
            </p>
          </div>

          {statusMix.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-16">
              No orders in this range.
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={statusMix}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={2}
                  >
                    {statusMix.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "#fff",
                      border: "1px solid #e5e7eb",
                      borderRadius: "8px",
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap gap-x-4 gap-y-2 justify-center mt-2">
                {statusMix.map((entry) => (
                  <div
                    key={entry.name}
                    className="flex items-center gap-1.5 text-xs text-text-secondary"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: entry.color }}
                    />
                    {entry.name}: <span className="font-semibold">{entry.value}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Leaderboard */}
      <Card>
        <div className="mb-4">
          <h3 className="text-lg font-bold text-text">
            Restaurant leaderboard
          </h3>
          <p className="text-sm text-text-secondary">
            All {leaderboard.length} restaurants · activity over the selected
            range
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-secondary border-b border-border">
                <th className="py-2 pr-4 font-medium">Restaurant</th>
                <th className="py-2 pr-4 font-medium">
                  <button
                    type="button"
                    onClick={() => setSortKey("orders")}
                    className={`inline-flex items-center gap-1 ${
                      sortKey === "orders"
                        ? "text-text font-semibold"
                        : "hover:text-text"
                    }`}
                  >
                    Orders <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="py-2 pr-4 font-medium">
                  <button
                    type="button"
                    onClick={() => setSortKey("gmv")}
                    className={`inline-flex items-center gap-1 ${
                      sortKey === "gmv"
                        ? "text-text font-semibold"
                        : "hover:text-text"
                    }`}
                  >
                    GMV <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="py-2 pr-4 font-medium">AOV</th>
                <th className="py-2 pr-4 font-medium">
                  <button
                    type="button"
                    onClick={() => setSortKey("cancelled")}
                    className={`inline-flex items-center gap-1 ${
                      sortKey === "cancelled"
                        ? "text-text font-semibold"
                        : "hover:text-text"
                    }`}
                  >
                    Cancelled <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="py-2 pr-4 font-medium">
                  <button
                    type="button"
                    onClick={() => setSortKey("menu_items")}
                    className={`inline-flex items-center gap-1 ${
                      sortKey === "menu_items"
                        ? "text-text font-semibold"
                        : "hover:text-text"
                    }`}
                  >
                    Menu items <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
                <th className="py-2 font-medium">
                  <button
                    type="button"
                    onClick={() => setSortKey("last_order_at")}
                    className={`inline-flex items-center gap-1 ${
                      sortKey === "last_order_at"
                        ? "text-text font-semibold"
                        : "hover:text-text"
                    }`}
                  >
                    Last order <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedBoard.map((row) => (
                <tr
                  key={row.restaurant_id}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="py-3 pr-4">
                    <div className="font-semibold text-text">{row.name}</div>
                    <div className="flex items-center gap-1.5 text-xs text-text-secondary mt-0.5">
                      <span
                        className={`px-1.5 py-0.5 rounded font-semibold ${planBadgeClass(
                          row.subscription_plan
                        )}`}
                      >
                        {row.subscription_plan === "free_trial"
                          ? "Trial"
                          : row.subscription_plan}
                      </span>
                      <span
                        className={
                          row.is_active && row.status !== "blocked"
                            ? ""
                            : "text-error font-semibold"
                        }
                      >
                        {statusLabel(row)}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 pr-4">{row.orders}</td>
                  <td className="py-3 pr-4">{formatCurrency(row.gmv)}</td>
                  <td className="py-3 pr-4">
                    {row.avg_order_value > 0
                      ? formatCurrency(row.avg_order_value)
                      : "—"}
                  </td>
                  <td className="py-3 pr-4">{row.cancelled}</td>
                  <td className="py-3 pr-4">{row.menu_items}</td>
                  <td className="py-3">
                    <span
                      className={
                        row.last_order_at ? "text-text" : "text-error"
                      }
                    >
                      {daysSinceLabel(row.last_order_at)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Waiter calls + activation */}
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <div className="mb-4">
            <h3 className="text-lg font-bold text-text">Waiter calls</h3>
            <p className="text-sm text-text-secondary">
              Customer "Call Waiter" taps in this range
            </p>
          </div>

          {waiterStats && waiterStats.total > 0 ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-2xl font-bold text-text">
                    {waiterStats.total}
                  </p>
                  <p className="text-sm text-text-secondary">Calls</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-text">
                    {waiterStats.pending_open}
                  </p>
                  <p className="text-sm text-text-secondary">Open right now</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-text">
                    {formatSeconds(waiterStats.median_ack_seconds)}
                  </p>
                  <p className="text-sm text-text-secondary">
                    Median acknowledge
                  </p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-text">
                    {waiterStats.resolved}
                  </p>
                  <p className="text-sm text-text-secondary">Resolved</p>
                </div>
              </div>
              {waiterStats.pending_open > 0 && (
                <p className="text-sm text-warning mt-4">
                  {waiterStats.pending_open} call
                  {waiterStats.pending_open > 1 ? "s" : ""} still waiting for an
                  acknowledgement.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-text-secondary text-center py-8">
              No waiter calls in this range.
            </p>
          )}
        </Card>

        <Card>
          <div className="mb-4">
            <h3 className="text-lg font-bold text-text">Activation</h3>
            <p className="text-sm text-text-secondary">
              Setup gaps across all restaurants
            </p>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-text">No menu items yet</span>
              <span className="font-semibold text-text">
                {activation.noMenu.length}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text">
                No orders in this range
              </span>
              <span className="font-semibold text-text">
                {activation.noOrders.length}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text">Never ordered at all</span>
              <span className="font-semibold text-text">
                {activation.neverOrdered.length}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text">
                Trials ending within 7 days
              </span>
              <span className="font-semibold text-text">
                {activation.trialsEnding.length}
              </span>
            </div>
          </div>

          {activation.noMenu.length > 0 && (
            <p className="text-xs text-text-secondary mt-4">
              No menu:{" "}
              {activation.noMenu
                .slice(0, 3)
                .map((r) => r.name)
                .join(", ")}
              {activation.noMenu.length > 3
                ? ` +${activation.noMenu.length - 3} more`
                : ""}
            </p>
          )}
          {activation.trialsEnding.length > 0 && (
            <p className="text-xs text-warning mt-1">
              Trials ending soon:{" "}
              {activation.trialsEnding
                .slice(0, 3)
                .map((r) => r.name)
                .join(", ")}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
};

export default Analytics;
