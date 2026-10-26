import React from "react";
import { Link } from "react-router-dom";
import { Card, Alert } from "../../components/ui";
import { useAuth } from "../../contexts/AuthContext";
import QRCodeManager from "./components/QRCodeManager";
import RestaurantProfileCard from "./components/RestaurantProfileCard";

const RestaurantSettings: React.FC = () => {
  const { restaurant } = useAuth();

  if (!restaurant) {
    return <Alert type="error" message="Restaurant not found" />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-text mb-2">Settings</h2>
        <p className="text-text-secondary">
          Manage your restaurant profile, QR codes and menu access
        </p>
      </div>

      {/* Profile & branding — the owner's own write path (migration 034) */}
      <RestaurantProfileCard />

      {/* QR Codes — master menu QR + one per table, in a single card. The table
          count comes from the owner's declaration (migration 044) so a printed
          QR can never point at a table the server refuses at checkout. */}
      <QRCodeManager
        slug={restaurant.slug}
        restaurantName={restaurant.name}
        tableCount={restaurant.table_count ?? null}
      />

      {/* Still to come — kept short so it does not read like a to-do list. */}
      <Card className="bg-bg-subtle">
        <h3 className="text-lg font-bold text-text mb-3">Coming soon</h3>
        <ul className="space-y-2 text-text-secondary text-sm">
          <li>• Customize ordering page theme</li>
          <li>• Set business hours and holidays</li>
          <li>• Configure payment methods</li>
        </ul>
        <p className="mt-4 text-sm text-text-secondary">
          Want to change your password?{" "}
          <Link to="/change-password" className="font-medium text-accent hover:underline">
            Change password
          </Link>
        </p>
      </Card>
    </div>
  );
};

export default RestaurantSettings;
