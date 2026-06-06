import React from "react";
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

const RestaurantDashboard: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, restaurant, ready, signOut } = useAuth();

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

  const handleLogout = async () => {
    await signOut();
    navigate("/login");
  };

  const navItems = [
    { path: "/restaurant", icon: LayoutDashboard, label: "Dashboard" },
    { path: "/restaurant/orders", icon: ShoppingBag, label: "Orders" },
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
            <div className="flex items-center space-x-3">
              <IconLogo className="w-8 h-8 text-accent" />
              <div>
                <h1 className="text-lg font-bold text-text">
                  {restaurant.name}
                </h1>
                <p className="text-xs text-text-secondary">{user.email}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center space-x-2 text-text-secondary hover:text-error transition-colors"
            >
              <LogOut className="w-5 h-5" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Secondary Navigation */}
      <div className="bg-white border-b border-border">
        <div className="container-custom">
          <div className="flex space-x-1 overflow-x-auto">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`flex items-center space-x-2 px-4 py-3 border-b-2 transition-colors whitespace-nowrap ${
                    isActive
                      ? "border-accent text-accent font-medium"
                      : "border-transparent text-text-secondary hover:text-text"
                  }`}
                >
                  <item.icon className="w-5 h-5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="container-custom py-8">
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
