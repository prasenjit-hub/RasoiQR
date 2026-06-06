import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// Public pages
import LandingPage from "./pages/public/LandingPage";
import RegisterPage from "./pages/public/RegisterPage";
import LoginPage from "./pages/public/LoginPage";
import PublicResetPasswordPage from "./pages/public/ResetPasswordPage";
import PrivacyPolicyPage from "./pages/public/PrivacyPolicyPage";
import TermsOfServicePage from "./pages/public/TermsOfServicePage";

// Restaurant dashboard
import RestaurantDashboard from "./pages/restaurant/Dashboard";

// Admin panel
import AdminLogin from "./pages/admin/LoginPage";
import AdminDashboard from "./pages/admin/Dashboard";
import ResetPasswordPage from "./pages/admin/ResetPasswordPage";

// Customer ordering
import CustomerMenu from "./pages/customer/CustomerMenu";
import CustomerOrderTracking from "./pages/customer/CustomerOrderTracking";
import CustomerOrderHistory from "./pages/customer/CustomerOrderHistory";

// 404
import NotFoundPage from "./pages/NotFoundPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public Routes */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<PublicResetPasswordPage />} />
        <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
        <Route path="/terms-of-service" element={<TermsOfServicePage />} />

        {/* Restaurant Dashboard Routes */}
        <Route path="/restaurant/*" element={<RestaurantDashboard />} />

        {/* Admin Panel Routes */}
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin/reset-password" element={<ResetPasswordPage />} />
        <Route path="/admin/*" element={<AdminDashboard />} />

        {/* Customer Routing */}
        <Route path="/menu/:slug" element={<CustomerMenu />} />
        <Route path="/order/:id" element={<CustomerOrderTracking />} />
        <Route path="/tracking/:slug" element={<CustomerOrderHistory />} />

        {/* 404 */}
        <Route path="/404" element={<NotFoundPage />} />
        <Route path="*" element={<Navigate to="/404" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
