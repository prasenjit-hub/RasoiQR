import React from "react";
import { ShoppingBag, UtensilsCrossed, DollarSign, Clock } from "lucide-react";
import { Card, Badge, Skeleton } from "../../components/ui";
import { getRestaurantStats } from "../../services/restaurantService";
import { formatCurrency, formatDate } from "../../utils/helpers";
import { getBillingStatus } from "../../utils/subscription";
import WaiterCallsPanel from "./components/WaiterCallsPanel";
import { useAuth } from "../../contexts/AuthContext";

const RestaurantHome: React.FC = () => {
  const { restaurant } = useAuth();
  // Quiet, always-visible plan state (audit P2-1); the loud cases are the banner.
  const billing = getBillingStatus(restaurant);
  const [stats, setStats] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!restaurant) return;
    let cancelled = false;

    void (async () => {
      const data = await getRestaurantStats(restaurant.id);
      if (cancelled) return;
      setStats(data);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [restaurant]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-64 mb-2" />
          <Skeleton className="h-5 w-96" />
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="hover:shadow-md transition-shadow">
              <Skeleton className="w-10 h-10 rounded-lg mb-3" />
              <Skeleton className="h-4 w-24 mb-2" />
              <Skeleton className="h-8 w-16" />
            </Card>
          ))}
        </div>
        <div className="grid lg:grid-cols-2 gap-6">
          <Card>
            <Skeleton className="h-6 w-32 mb-4" />
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </Card>
          <Card>
            <Skeleton className="h-6 w-40 mb-4" />
            <div className="space-y-4">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="flex justify-between">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 w-32" />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const statCards = [
    {
      title: "Pending Orders",
      value: stats?.pendingOrders || 0,
      icon: Clock,
      color: "text-warning",
      bgColor: "bg-warning/10",
    },
    {
      title: "Today's Orders",
      value: stats?.completedToday || 0,
      icon: ShoppingBag,
      color: "text-accent",
      bgColor: "bg-accent/10",
    },
    {
      title: "Today's Revenue",
      value: formatCurrency(stats?.revenueToday || 0),
      icon: DollarSign,
      color: "text-success",
      bgColor: "bg-success/10",
    },
    {
      title: "Menu Items",
      value: stats?.totalMenuItems || 0,
      icon: UtensilsCrossed,
      color: "text-accent-secondary",
      bgColor: "bg-accent-secondary/10",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text mb-2 break-words">
          Welcome back, {restaurant?.name}
        </h2>
        <p className="text-text-secondary">
          Here's what's happening at your restaurant today.
        </p>
      </div>

      {/* 🛎️ Live waiter calls (migration 036). First on the page on purpose: a
          customer standing at a table waiting for someone is more urgent than
          any number below it. */}
      {restaurant && <WaiterCallsPanel restaurantId={restaurant.id} />}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <Card key={stat.title} className="hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className={`p-2 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
              </div>
            </div>
            <p className="text-text-secondary text-sm mb-1">{stat.title}</p>
            <p className="text-2xl font-bold text-text">{stat.value}</p>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <h3 className="text-lg font-semibold text-text mb-3">Quick Actions</h3>
          <div className="space-y-2">
            <a
              href="/restaurant/menu"
              className="block p-3 rounded-lg hover:bg-bg-subtle transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-text font-medium">Manage Menu</span>
                <Badge variant="accent-secondary">Go</Badge>
              </div>
            </a>
            <a
              href="/restaurant/orders"
              className="block p-3 rounded-lg hover:bg-bg-subtle transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-text font-medium">View Orders</span>
                <Badge variant="warning">Live</Badge>
              </div>
            </a>
            <a
              href="/restaurant/reports"
              className="block p-3 rounded-lg hover:bg-bg-subtle transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-text font-medium">View Reports</span>
                <Badge variant="success">New</Badge>
              </div>
            </a>
          </div>
        </Card>

        <Card>
          <h3 className="text-lg font-semibold text-text mb-3">Restaurant Info</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <span className="text-text-secondary flex-shrink-0">Name</span>
              <span className="text-text font-medium min-w-0 truncate text-right">{restaurant?.name}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-text-secondary flex-shrink-0">Slug</span>
              <span className="text-text font-medium min-w-0 truncate text-right">{restaurant?.slug}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-text-secondary flex-shrink-0">Email</span>
              <span className="text-text font-medium min-w-0 truncate text-right">{restaurant?.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Plan</span>
              <Badge variant="accent-secondary">
                {restaurant?.subscription_plan || "—"}
              </Badge>
            </div>
            {billing.endsAt && (
              <div className="flex justify-between">
                <span className="text-text-secondary">
                  {billing.level === "expired"
                    ? "Trial ended"
                    : billing.viaAccessWindow
                    ? "Access until"
                    : "Trial ends"}
                </span>
                <span className="text-text font-medium">
                  {formatDate(billing.endsAt.toISOString())}
                  {billing.level !== "expired" &&
                    billing.daysLeft !== null &&
                    ` · ${billing.daysLeft <= 0 ? "today" : `${billing.daysLeft} day${billing.daysLeft > 1 ? "s" : ""} left`}`}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-text-secondary">Menu URL</span>
              <a
                href={`/menu/${restaurant?.slug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline text-xs"
              >
                /menu/{restaurant?.slug}
              </a>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default RestaurantHome;
