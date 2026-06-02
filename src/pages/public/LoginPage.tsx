import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Store, ArrowLeft, Mail, Lock, AlertCircle } from "lucide-react";
import { Button, Input, Alert, Card } from "../../components/ui";
import { APP_CONFIG, SUPABASE_URL } from "../../config/config";
import { supabase } from "../../config/supabase";
import { isValidEmail } from "../../utils/helpers";

const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!formData.email || !formData.password) {
      setError("Please enter both email and password");
      return;
    }

    if (!isValidEmail(formData.email)) {
      setError("Please enter a valid email address");
      return;
    }

    setLoading(true);

    try {
      const isDemoMode = import.meta.env.VITE_DEMO_MODE === "true";
      const isDemo =
        isDemoMode &&
        formData.email.toLowerCase() === "demorestaurant@gmail.com" &&
        formData.password === "ATVSW679";
      let userData = null;

      if (isDemo) {
        userData = {
          id: "demo-restaurant-owner-id",
          email: "demorestaurant@gmail.com",
          role: "owner",
          restaurant_id: "demo-restaurant-id",
          restaurant_name: "The Royal Rasoi",
          restaurant_slug: "royal-rasoi",
          restaurant_is_active: true,
          temp_password: false
        };
      } else {
        // Approach 2: Authenticate using standard Supabase Auth
        let authData = null;
        let authError: any = null;

        try {
          const res = await supabase.auth.signInWithPassword({
            email: formData.email.toLowerCase(),
            password: formData.password,
          });
          authData = res.data;
          authError = res.error;
        } catch (authErr) {
          console.error("Supabase Auth failed or connection issue:", authErr);
          authError = authErr;
        }

        if (authError || !authData || !authData.user) {
          const isPlaceholderSupabase = !SUPABASE_URL || SUPABASE_URL === "YOUR_SUPABASE_URL" || SUPABASE_URL === "";
          
          if (isPlaceholderSupabase || (authError && (authError.message?.includes("fetch") || authError.status === 404))) {
            console.warn("Using offline demo fallback since database is unconfigured or unavailable.");
            userData = {
              id: "demo-restaurant-owner-id",
              email: "demorestaurant@gmail.com",
              role: "owner",
              restaurant_id: "demo-restaurant-id",
              restaurant_name: "The Royal Rasoi",
              restaurant_slug: "royal-rasoi",
              restaurant_is_active: true,
              temp_password: false
            };
          } else {
            if (authError) {
              console.error("Login Auth error:", authError);
              
              // Check if registration is still pending
              const { data: registrationData } = await supabase
                .from("registration_requests")
                .select("status")
                .eq("email", formData.email.toLowerCase())
                .single();

              if (registrationData && registrationData.status === "pending") {
                setError("pending");
                setLoading(false);
                return;
              }

              setError(`Login failed: ${authError.message}`);
              setLoading(false);
              return;
            }
          }
        } else {
          // Retrieve profile from public.users with joined restaurant
          const { data: profile, error: dbError } = await supabase
            .from("users")
            .select(`
              id,
              email,
              role,
              temp_password,
              restaurant_id,
              restaurants (
                name,
                slug,
                is_active
              )
            `)
            .eq("id", authData.user.id)
            .single();

          if (dbError || !profile) {
            console.error("Database profile fetch failed:", dbError);
            setError("Unable to retrieve restaurant profile. Please make sure database setup is complete.");
            setLoading(false);
            return;
          }

          const restaurant = Array.isArray(profile.restaurants) 
            ? profile.restaurants[0] 
            : profile.restaurants;

          if (!restaurant) {
            setError("No restaurant is associated with this administrator account.");
            setLoading(false);
            return;
          }

          userData = {
            id: profile.id,
            email: profile.email,
            role: profile.role,
            restaurant_id: profile.restaurant_id,
            restaurant_name: restaurant.name,
            restaurant_slug: restaurant.slug,
            restaurant_is_active: restaurant.is_active,
            temp_password: profile.temp_password
          };
        }
      }

      if (!userData) {
        throw new Error("Unable to establish standard user profile");
      }

      // Check if restaurant is active
      if (!userData.restaurant_is_active) {
        setError(
          "Your restaurant account has been deactivated. Please contact support."
        );
        setLoading(false);
        return;
      }

      // Login successful - store user data in localStorage
      localStorage.setItem(
        "user",
        JSON.stringify({
          id: userData.id,
          email: userData.email,
          role: userData.role,
          restaurant_id: userData.restaurant_id,
          restaurant: {
            name: userData.restaurant_name,
            slug: userData.restaurant_slug,
            is_active: userData.restaurant_is_active,
          },
          temp_password: userData.temp_password,
        })
      );

      // Redirect to restaurant dashboard
      navigate("/restaurant");
    } catch (err: any) {
      console.error("Login error:", err);
      // Show detailed error for debugging
      const errorMsg =
        err?.message ||
        err?.toString() ||
        "Network error. Please check your connection.";
      setError(`Error: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    setError("");
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Back to Home */}
        <Link
          to="/"
          className="inline-flex items-center text-text-secondary hover:text-text mb-8"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Home
        </Link>

        {/* Login Card */}
        <Card>
          {/* Logo and Title */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/5 mb-4">
              <Store className="w-10 h-10 text-accent" />
            </div>
            <h1 className="text-2xl font-bold text-text mb-2">Welcome Back</h1>
            <p className="text-text-secondary">
              Login to your restaurant dashboard
            </p>
          </div>

          {/* Pending Registration Alert */}
          {error === "pending" && (
            <Alert
              type="warning"
              title="Account Pending Verification"
              message="Your registration is under review. Our team will contact you within 24 hours to complete the setup."
              className="mb-6"
            />
          )}

          {/* Error Alert */}
          {error && error !== "pending" && (
            <Alert type="error" message={error} className="mb-6" />
          )}

          {/* Demo Credentials — only shown in demo mode */}
          {import.meta.env.VITE_DEMO_MODE === "true" && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <p className="text-sm font-semibold text-blue-800 mb-2">
                🎯 Demo Account - Try it out!
              </p>
              <div className="text-sm text-blue-700 space-y-1">
                <p>
                  <span className="font-medium">Email:</span>{" "}
                  demorestaurant@gmail.com
                </p>
                <p>
                  <span className="font-medium">Password:</span> ATVSW679
                </p>
              </div>
            </div>
          )}

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Email Address"
              name="email"
              type="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="your@email.com"
              icon={<Mail className="w-5 h-5" />}
              required
              autoComplete="email"
            />

            <Input
              label="Password"
              name="password"
              type="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter your password"
              icon={<Lock className="w-5 h-5" />}
              required
              autoComplete="current-password"
            />

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center text-text-secondary">
                <input type="checkbox" className="mr-2 rounded border-border" />
                Remember me
              </label>
              <a href="#" className="text-accent hover:underline">
                Forgot password?
              </a>
            </div>

            <Button type="submit" loading={loading} fullWidth size="lg">
              Login
            </Button>
          </form>

          {/* Register Link */}
          <div className="mt-6 text-center text-sm text-text-secondary">
            Don't have an account?{" "}
            <Link
              to="/register"
              className="text-accent font-medium hover:underline"
            >
              Register your restaurant
            </Link>
          </div>

          {/* Admin Login */}
          <div className="mt-6 pt-6 border-t border-border text-center">
            <Link
              to="/admin/login"
              className="text-sm text-text-secondary hover:text-text flex items-center justify-center"
            >
              <AlertCircle className="w-4 h-4 mr-2" />
              Admin Login
            </Link>
          </div>
        </Card>

        {/* Help Text */}
        <p className="mt-6 text-center text-sm text-text-secondary">
          Need help? Contact us at support@{APP_CONFIG.appName.toLowerCase()}
          .com
        </p>
      </div>
    </div>
  );
};

export default LoginPage;
