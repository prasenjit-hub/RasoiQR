import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ShoppingCart,
  Plus,
  Minus,
  X,
  Search,
  CheckCircle,
  Package,
  Clock,
  MapPin,
  ChevronRight,
} from "lucide-react";
import {
  Card,
  Button,
  Input,
  Loading,
  Alert,
} from "../../components/ui";
import {
  subscribeToMenuForCustomer,
  createOrderAsCustomer,
} from "../../services/restaurantService";
import type { MenuItem } from "../../config/supabase";
import { formatCurrency, isValidPhone } from "../../utils/helpers";
import { supabase } from "../../config/supabase";

interface CartItem extends MenuItem {
  quantity: number;
  selectedSize?: { name: string; price: number };
  selectedAddons: { name: string; price: number }[];
  itemTotal: number;
}

const CustomerMenu: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const [restaurant, setRestaurant] = useState<any>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  
  // Custom Toggles for Veg / Non-Veg
  const [vegOnly, setVegOnly] = useState(false);
  const [nonVegOnly, setNonVegOnly] = useState(false);

  const [showCart, setShowCart] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [showItemModal, setShowItemModal] = useState(false);

  // Load restaurant and menu
  useEffect(() => {
    loadRestaurant();
  }, [slug]);

  useEffect(() => {
    if (restaurant?.id) {
      const subscription = subscribeToMenuForCustomer(restaurant.id, (data) => {
        setMenuItems(data);
        setLoading(false);
      });

      return () => {
        subscription.unsubscribe();
      };
    }
  }, [restaurant]);

  const loadRestaurant = async () => {
    if (!slug) return;

    const { data, error } = await supabase.rpc("get_restaurant_by_slug", {
      p_slug: slug,
    });

    if (error || !data || !Array.isArray(data) || data.length === 0) {
      console.error("Restaurant not found");
      setLoading(false);
      return;
    }

    setRestaurant(data[0]);
  };

  // Helper to dynamically detect if an item is vegetarian
  const isItemVeg = (item: MenuItem): boolean => {
    const text = (`${item.name} ${item.category || ""} ${item.description || ""}`).toLowerCase();
    const nonVegKeywords = [
      "chicken", "egg", "fish", "mutton", "beef", "pork", "meat", "prawn", 
      "non-veg", "non veg", "kebab", "tikka", "wings", "pepperoni", "bacon", 
      "salame", "salami"
    ];
    return !nonVegKeywords.some(keyword => text.includes(keyword));
  };

  // Helper to dynamically match icons/emojis with categories
  const getCategoryEmoji = (category: string | undefined): string => {
    const cat = (category || "").toLowerCase();
    if (cat.includes("burger")) return "🍔";
    if (cat.includes("pizza")) return "🍕";
    if (cat.includes("drink") || cat.includes("beverage")) return "🍹";
    if (cat.includes("dessert") || cat.includes("sweet") || cat.includes("cake")) return "🍰";
    if (cat.includes("pasta") || cat.includes("noodle") || cat.includes("chinese")) return "🍝";
    if (cat.includes("biryani") || cat.includes("rice")) return "🍛";
    if (cat.includes("starter") || cat.includes("appetizer") || cat.includes("salad")) return "🥗";
    if (cat.includes("soup")) return "🥣";
    if (cat.includes("bread") || cat.includes("roti") || cat.includes("nan")) return "🫓";
    if (cat.includes("chicken") || cat.includes("meat")) return "🍗";
    return "🍽️";
  };

  const categories = [
    "all",
    ...Array.from(new Set(menuItems.map((item) => item.category).filter(Boolean))),
  ];

  const filteredItems = menuItems.filter((item) => {
    const matchesSearch = item.name
      .toLowerCase()
      .includes(searchTerm.toLowerCase()) || 
      (item.description || "").toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesCategory =
      categoryFilter === "all" || item.category === categoryFilter;

    const itemIsVeg = isItemVeg(item);

    if (vegOnly && !itemIsVeg) return false;
    if (nonVegOnly && itemIsVeg) return false;

    return matchesSearch && matchesCategory && item.is_available;
  });

  const addToCart = (
    item: MenuItem,
    selectedSize?: any,
    selectedAddons: any[] = []
  ) => {
    const basePrice = selectedSize ? selectedSize.price : item.base_price;
    const addonsTotal = selectedAddons.reduce(
      (sum, addon) => sum + addon.price,
      0
    );
    const itemTotal = basePrice + addonsTotal;

    const cartItem: CartItem = {
      ...item,
      quantity: 1,
      selectedSize,
      selectedAddons,
      itemTotal,
    };

    const existingIndex = cart.findIndex(
      (ci) =>
        ci.id === item.id &&
        ci.selectedSize?.name === selectedSize?.name &&
        JSON.stringify(ci.selectedAddons) === JSON.stringify(selectedAddons)
    );

    if (existingIndex >= 0) {
      const newCart = [...cart];
      newCart[existingIndex].quantity += 1;
      setCart(newCart);
    } else {
      setCart([...cart, cartItem]);
    }

    setShowItemModal(false);
  };

  const updateQuantity = (index: number, delta: number) => {
    const newCart = [...cart];
    newCart[index].quantity += delta;
    if (newCart[index].quantity <= 0) {
      newCart.splice(index, 1);
    }
    setCart(newCart);
  };

  const removeFromCart = (index: number) => {
    const newCart = [...cart];
    newCart.splice(index, 1);
    setCart(newCart);
  };

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  const handleItemClick = (item: MenuItem) => {
    if ((item.sizes && item.sizes.length > 0) || (item.addons && item.addons.length > 0)) {
      setSelectedItem(item);
      setShowItemModal(true);
    } else {
      addToCart(item);
    }
  };

  if (loading) {
    return <Loading text="Loading divine flavors..." />;
  }

  if (!restaurant) {
    return (
      <div className="min-h-screen bg-neutral-50 flex items-center justify-center p-4">
        <Card className="text-center p-8 max-w-md shadow-2xl rounded-3xl border border-neutral-100 bg-white">
          <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-6">
            <Package className="w-10 h-10 text-amber-500" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2">
            Restaurant Not Found
          </h2>
          <p className="text-gray-500 mb-6">
            The dining space you are looking for doesn't exist or is offline at the moment.
          </p>
          <Button onClick={() => window.location.reload()} variant="outline" className="rounded-xl w-full">
            Refresh Page
          </Button>
        </Card>
      </div>
    );
  }

  const getItemQuantity = (itemId: string) => {
    return cart.reduce((sum, cartItem) => {
      if (cartItem.id === itemId) {
        return sum + cartItem.quantity;
      }
      return sum;
    }, 0);
  };

  const handleAddSimple = (item: MenuItem) => {
    addToCart(item);
  };

  const handleRemoveItem = (itemId: string) => {
    const index = cart.findIndex((ci) => ci.id === itemId);
    if (index >= 0) {
      updateQuantity(index, -1);
    }
  };

  return (
    <div id="customer-ordering-root" className="min-h-screen bg-gray-50/50 pb-28">
      
      {/* 🚀 Dynamic Premium Cover Photo Banner */}
      <div className="relative h-48 md:h-64 overflow-hidden w-full bg-slate-900">
        <img
          src="https://images.unsplash.com/photo-1543353071-10c8ba85a904?auto=format&fit=crop&q=80&w=1200"
          alt="Delicious Food Header"
          className="w-full h-full object-cover transform scale-105 filter brightness-[0.45] blur-[1px]"
        />
        <div className="absolute top-4 left-4 z-10 flex gap-2">
          <span className="backdrop-blur-md bg-black/40 text-emerald-400 text-xs px-3 py-1.5 rounded-full font-bold flex items-center gap-1.5 border border-emerald-400/30 shadow-sm animate-pulse">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Kitchen Active
          </span>
        </div>
      </div>

      {/* 🏡 Restaurant Floating Premium Info Card */}
      <div className="max-w-xl mx-auto px-4 -mt-20 relative z-20">
        <div className="bg-white rounded-3xl p-5 shadow-[0_15px_35px_rgba(0,0,0,0.06)] border border-gray-100">
          <div className="flex items-start gap-4">
            {restaurant.logo_url ? (
              <img
                src={restaurant.logo_url}
                alt={restaurant.name}
                className="w-16 h-16 rounded-2xl object-cover shadow-md border-2 border-white flex-shrink-0"
              />
            ) : (
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-amber-400 to-orange-500 text-white font-extrabold text-2xl flex items-center justify-center shadow-md border-2 border-white flex-shrink-0">
                {restaurant.name.charAt(0)}
              </div>
            )}
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-extrabold text-2xl text-gray-900 tracking-tight">
                  {restaurant.name}
                </h1>
              </div>
              <p className="text-xs font-semibold text-amber-600 mt-0.5 tracking-wider uppercase">
                {restaurant.restaurant_type || "Fine Dining / Multi-Cuisine"}
              </p>

              <div className="flex flex-wrap items-center gap-y-1.5 gap-x-3.5 mt-3 text-xs text-gray-500 font-medium border-t border-gray-50 pt-3">
                <span className="flex items-center gap-1.5 text-gray-600 font-bold bg-amber-50 text-amber-700 px-2.5 py-1 rounded-lg">
                  ★ 4.9 <span className="text-gray-300 font-light">|</span> 100+ Ratings
                </span>
                <span className="flex items-center gap-1.5 text-gray-700">
                  <Clock className="w-3.5 h-3.5 text-amber-500" /> 15-20 mins
                </span>
                <span className="flex items-center gap-1.5 text-gray-700">
                  <MapPin className="w-3.5 h-3.5 text-red-400" /> QR Table Dining
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 🔍 Search & Cool Veg/Non-Veg Quick Filters */}
      <div className="max-w-xl mx-auto px-4 mt-6">
        <div className="relative mb-4 group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 group-focus-within:text-amber-500 transition-colors" />
          <input
            type="text"
            placeholder="Search for dynamic dishes, starters, desserts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-12 pr-4 py-3.5 bg-white border border-gray-100 rounded-2xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 shadow-sm transition-all text-gray-800 placeholder-gray-400"
          />
        </div>

        {/* Veg / Non-veg Slider Toggles */}
        <div className="flex items-center gap-3 bg-white p-2.5 rounded-2xl border border-gray-50 shadow-sm">
          <span className="text-xs font-extrabold text-gray-400 uppercase tracking-wider pl-1.5">Filters:</span>
          
          <button
            onClick={() => {
              setVegOnly(!vegOnly);
              if (!vegOnly) setNonVegOnly(false);
            }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all border ${
              vegOnly
                ? "bg-emerald-50 border-emerald-200 text-emerald-700 shadow-sm"
                : "bg-gray-50/50 border-gray-100 text-gray-500 hover:bg-gray-50"
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 border border-emerald-600 flex-shrink-0" />
            Veg Only
          </button>

          <button
            onClick={() => {
              setNonVegOnly(!nonVegOnly);
              if (!nonVegOnly) setVegOnly(false);
            }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all border ${
              nonVegOnly
                ? "bg-red-50 border-red-200 text-red-700 shadow-sm"
                : "bg-gray-50/50 border-gray-100 text-gray-500 hover:bg-gray-50"
            }`}
          >
            <span className="w-0.5 h-0.5 border-[5px] border-transparent border-b-[9px] border-b-red-600 mb-1 flex-shrink-0" />
            Non-Veg Only
          </button>
        </div>
      </div>

      {/* 🏷️ Horizontal Category Scroll Slider */}
      <div className="bg-white border-b border-gray-100 sticky top-0 z-30 shadow-sm mt-5">
        <div className="max-w-xl mx-auto px-4">
          <div className="flex gap-2 overflow-x-auto py-3.5 scrollbar-hide">
            {categories.map((category) => (
              <button
                key={category}
                onClick={() => setCategoryFilter(category || "all")}
                className={`px-4 py-2 rounded-xl text-xs font-extrabold whitespace-nowrap transition-all flex items-center gap-1.5 ${
                  categoryFilter === category
                    ? "bg-gray-900 text-white shadow-md shadow-gray-900/10 scale-[1.03]"
                    : "bg-gray-50 text-gray-600 border border-gray-100/80 hover:bg-gray-100"
                }`}
              >
                <span>{category === "all" ? "🔥" : getCategoryEmoji(category)}</span>
                <span>{category === "all" ? "Top Picks" : category}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 🍽️ Food Items List Grid */}
      <div className="max-w-xl mx-auto px-4 py-6">
        {filteredItems.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-3xl border border-gray-50 p-8 shadow-sm">
            <div className="w-16 h-16 bg-neutral-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Package className="w-8 h-8 text-neutral-300" />
            </div>
            <p className="text-gray-400 text-sm font-semibold">No tasty items found matching filters</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredItems.map((item) => {
              const quantity = getItemQuantity(item.id);
              const isVeg = isItemVeg(item);
              const hasVariations =
                (item.sizes && item.sizes.length > 0) ||
                (item.addons && item.addons.length > 0);

              return (
                <div
                  key={item.id}
                  className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm hover:shadow-md transition-all duration-200 flex gap-4 relative overflow-hidden"
                >
                  {/* Left Column: Food Specs & Details */}
                  <div className="flex-1 min-w-0 flex flex-col justify-between">
                    <div>
                      {/* Veg / Non-Veg Tag Dot */}
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <div className={`w-4 h-4 p-[2px] border ${isVeg ? "border-emerald-500" : "border-red-500"} flex items-center justify-center flex-shrink-0 rounded-sm bg-white`}>
                          <span className={`w-2 h-2 rounded-full ${isVeg ? "bg-emerald-500 animate-pulse" : "bg-red-50"}`} style={!isVeg ? {
                            borderWidth: "4px",
                            borderStyle: "solid",
                            borderColor: "transparent transparent rgb(239, 68, 68) transparent",
                            borderRadius: "0px",
                            marginBottom: "2px"
                          } : {}} />
                        </div>
                        {isVeg ? (
                          <span className="text-[9px] font-extrabold text-emerald-600 tracking-wide uppercase">Pure Veg</span>
                        ) : (
                          <span className="text-[9px] font-extrabold text-red-600 tracking-wide uppercase">Non Veg</span>
                        )}
                      </div>

                      {/* Name & Desc */}
                      <h3 className="font-extrabold text-base text-gray-800 tracking-tight leading-tight mb-1">
                        {item.name}
                      </h3>
                      {item.description && (
                        <p className="text-xs text-gray-400 font-medium line-clamp-2 leading-relaxed mb-2.5">
                          {item.description}
                        </p>
                      )}
                    </div>

                    {/* Price and Add button */}
                    <div className="flex items-center gap-3">
                      <span className="font-black text-lg text-gray-900">
                        {item.sizes && item.sizes.length > 0
                          ? formatCurrency(Math.min(...item.sizes.map((s) => s.price)))
                          : formatCurrency(item.base_price)}
                      </span>
                      {hasVariations && (
                        <span className="text-[10px] text-amber-500 font-bold bg-amber-50 px-2 py-0.5 rounded-full border border-amber-100">
                          Customizable
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Right Column: Beautifully Rounded Food Image & Overlapped ADD controller */}
                  <div className="relative w-28 h-28 md:w-32 md:h-32 flex-shrink-0 self-center">
                    {item.image_url ? (
                      <img
                        src={item.image_url}
                        alt={item.name}
                        className="w-full h-full object-cover rounded-2xl shadow-sm border border-gray-100"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full bg-orange-50/60 rounded-2xl flex flex-col items-center justify-center border border-orange-100/50">
                        <span className="text-3xl mb-1">{getCategoryEmoji(item.category || "")}</span>
                        <span className="text-[9px] text-orange-400/80 font-bold tracking-tight">Crave Worthy</span>
                      </div>
                    )}

                    {/* Elite ADD/Minus overlap widget */}
                    {item.is_available ? (
                      <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-24">
                        {quantity === 0 ? (
                          <button
                            onClick={() => handleItemClick(item)}
                            className="w-full bg-white text-neutral-900 border border-neutral-200 hover:border-neutral-400 font-extrabold text-center py-2.5 rounded-xl shadow-[0_4px_10px_rgba(0,0,0,0.06)] hover:shadow-md transition-all uppercase text-xs tracking-wider"
                          >
                            ADD
                          </button>
                        ) : (
                          <div className="w-full flex items-center justify-between bg-neutral-900 text-white rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.15)] border border-neutral-800 overflow-hidden">
                            <button
                              onClick={() => handleRemoveItem(item.id)}
                              className="px-2.5 py-2 hover:bg-neutral-800 active:scale-90 transition-all"
                            >
                              <Minus className="w-4 h-4 stroke-[3]" />
                            </button>
                            <span className="font-extrabold text-sm select-none">
                              {quantity}
                            </span>
                            <button
                              onClick={() =>
                                hasVariations
                                  ? handleItemClick(item)
                                  : handleAddSimple(item)
                              }
                              className="px-2.5 py-2 hover:bg-neutral-800 active:scale-90 transition-all"
                            >
                              <Plus className="w-4 h-4 stroke-[3]" />
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="absolute inset-0 bg-white/85 flex items-center justify-center rounded-2xl">
                        <span className="bg-neutral-800 text-white text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider">
                          Sold Out
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 🍔 Premium Custom Slide-up bottom Sheet for Cart Drawer */}
      <div
        className={`fixed inset-0 bg-neutral-950/70 backdrop-blur-sm z-50 transition-opacity duration-300 ${
          showCart ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setShowCart(false)}
      />
      <div
        className={`fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-white rounded-t-[32px] z-50 transition-transform duration-300 ease-out shadow-2xl max-h-[85vh] flex flex-col ${
          showCart ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="w-12 h-1.5 bg-neutral-200 rounded-full mx-auto my-3.5" />
        
        <div className="px-6 pb-4 border-b border-neutral-50 flex justify-between items-center">
          <div>
            <h3 className="font-extrabold text-xl text-neutral-800">Your Crave-box</h3>
            <p className="text-xs font-semibold text-neutral-400 mt-0.5">
              {cartCount} {cartCount === 1 ? "item" : "items"} selected
            </p>
          </div>
          <button
            onClick={() => setShowCart(false)}
            className="w-9 h-9 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500 hover:bg-neutral-200/80 transition-colors"
          >
            <X className="w-5 h-5 stroke-[2.5]" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {cart.length === 0 ? (
            <div className="text-center py-12">
              <ShoppingCart className="w-16 h-16 text-neutral-300 mx-auto mb-4" />
              <p className="text-neutral-400 text-sm font-bold">Your tray is currently empty</p>
            </div>
          ) : (
            cart.map((item, index) => (
              <div
                key={index}
                className="flex items-center gap-4 p-3 border border-neutral-50 rounded-2xl bg-neutral-50/50"
              >
                {/* Visual miniature */}
                {item.image_url ? (
                  <img
                    src={item.image_url}
                    alt={item.name}
                    className="w-14 h-14 object-cover rounded-xl border border-neutral-100"
                  />
                ) : (
                  <div className="w-14 h-14 bg-amber-50 rounded-xl flex items-center justify-center text-xl font-bold border border-amber-100/40">
                    {getCategoryEmoji(item.category || "")}
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <h4 className="font-extrabold text-sm text-neutral-800 truncate">{item.name}</h4>
                  
                  {/* Selected modifiers */}
                  {item.selectedSize && (
                    <span className="text-[10px] text-neutral-400 font-bold bg-neutral-100/80 px-2 py-0.5 rounded mt-1 inline-block mr-1.5">
                      Size: {item.selectedSize.name}
                    </span>
                  )}
                  {item.selectedAddons.length > 0 && (
                    <div className="text-[9px] text-neutral-400 font-medium leading-tight truncate mt-1">
                      + {item.selectedAddons.map((a) => a.name).join(", ")}
                    </div>
                  )}

                  <p className="text-amber-600 font-black text-sm mt-1">
                    {formatCurrency(item.itemTotal * item.quantity)}
                  </p>
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className="flex items-center bg-white border border-neutral-100 rounded-xl shadow-sm bg-white">
                    <button
                      onClick={() => updateQuantity(index, -1)}
                      className="p-2 hover:bg-neutral-50 rounded-l-xl text-neutral-500"
                    >
                      <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
                    </button>
                    <span className="w-7 text-center font-extrabold text-xs text-neutral-800 select-none">
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => updateQuantity(index, 1)}
                      className="p-2 hover:bg-neutral-50 rounded-r-xl text-neutral-500"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                    </button>
                  </div>
                  <button
                    onClick={() => removeFromCart(index)}
                    className="p-2 text-red-500 hover:bg-red-50 rounded-xl transition-all"
                    title="Remove plate"
                  >
                    <X className="w-4 h-4 stroke-[2.5]" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {cart.length > 0 && (
          <div className="bg-neutral-50/50 p-6 border-t border-neutral-100 rounded-t-3xl">
            <div className="flex justify-between items-center text-lg font-black text-neutral-800 mb-4">
              <span>Subtotal</span>
              <span className="text-xl">{formatCurrency(cart.reduce((sum, item) => sum + item.itemTotal * item.quantity, 0))}</span>
            </div>
            <button
              onClick={() => {
                setShowCart(false);
                setShowCheckout(true);
              }}
              className="w-full bg-neutral-900 text-white font-extrabold py-4 rounded-2xl shadow-xl shadow-neutral-900/10 hover:bg-neutral-800 active:scale-[0.99] transition-all text-sm uppercase tracking-wider"
            >
              Configure Dining & Place Order
            </button>
          </div>
        )}
      </div>

      {/* 📋 Item Customization Modal (Sleek Glassmorphism Drawer) */}
      <div
        className={`fixed inset-0 bg-neutral-950/70 backdrop-blur-sm z-50 transition-opacity duration-300 ${
          showItemModal ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setShowItemModal(false)}
      />
      <div
        className={`fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-white rounded-t-[32px] z-50 transition-transform duration-300 ease-out shadow-2xl max-h-[85vh] flex flex-col ${
          showItemModal ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="w-12 h-1.5 bg-neutral-200 rounded-full mx-auto my-3.5" />
        
        {selectedItem && (
          <ItemCustomizerContent
            item={selectedItem}
            onClose={() => setShowItemModal(false)}
            onAdd={addToCart}
          />
        )}
      </div>

      {/* 🍕 Sleek Checkout Sheet Overlay */}
      <div
        className={`fixed inset-0 bg-neutral-950/70 backdrop-blur-sm z-50 transition-opacity duration-300 ${
          showCheckout ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setShowCheckout(false)}
      />
      <div
        className={`fixed bottom-0 left-0 right-0 max-w-xl mx-auto bg-white rounded-t-[32px] z-50 transition-transform duration-300 ease-out shadow-2xl max-h-[90vh] flex flex-col ${
          showCheckout ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="w-12 h-1.5 bg-neutral-200 rounded-full mx-auto my-3.5" />
        
        {restaurant && (
          <CheckoutContent
            cart={cart}
            restaurantId={restaurant.id}
            onClose={() => setShowCheckout(false)}
            onSuccess={() => {
              setCart([]);
              setShowCheckout(false);
            }}
          />
        )}
      </div>

      {/* 🚀 Persistent Bottom Floating Cart Indicator */}
      {cartCount > 0 && !showCart && !showCheckout && !showItemModal && (
        <div className="fixed bottom-6 left-4 right-4 max-w-md mx-auto z-40 animate-bounce">
          <button
            onClick={() => setShowCart(true)}
            className="w-full bg-neutral-900 text-white rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.25)] px-5 py-4 flex items-center justify-between border border-neutral-800"
          >
            <div className="flex items-center gap-3">
              <div className="bg-white/10 text-white font-extrabold text-xs w-6 h-6 rounded-lg flex items-center justify-center backdrop-blur-md border border-white/10">
                {cartCount}
              </div>
              <div className="text-left">
                <p className="text-[10px] font-bold text-neutral-400 uppercase tracking-widest leading-none mb-0.5">Your Tray Total</p>
                <span className="font-black text-base text-white">
                  {formatCurrency(
                    cart.reduce(
                      (sum, item) => sum + item.itemTotal * item.quantity,
                      0
                    )
                  )}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 font-extrabold text-xs uppercase tracking-wider bg-white/10 text-white px-3 py-1.5 rounded-xl border border-white/5 hover:bg-white/20 transition-all">
              <span>View Order</span>
              <ChevronRight className="w-4 h-4 stroke-[3]" />
            </div>
          </button>
        </div>
      )}
    </div>
  );
};

// 🍕 Item Customizer Component (Separated for cleaner states)
interface ItemCustomizerContentProps {
  item: MenuItem;
  onClose: () => void;
  onAdd: (item: MenuItem, selectedSize?: any, selectedAddons?: any[]) => void;
}

const ItemCustomizerContent: React.FC<ItemCustomizerContentProps> = ({
  item,
  onClose,
  onAdd,
}) => {
  const [selectedSize, setSelectedSize] = useState<any>(null);
  const [selectedAddons, setSelectedAddons] = useState<any[]>([]);

  useEffect(() => {
    if (item.sizes && item.sizes.length > 0) {
      setSelectedSize(item.sizes[0]);
    }
  }, [item]);

  const toggleAddon = (addon: any) => {
    if (selectedAddons.find((a) => a.name === addon.name)) {
      setSelectedAddons(selectedAddons.filter((a) => a.name !== addon.name));
    } else {
      setSelectedAddons([...selectedAddons, addon]);
    }
  };

  const calculateTotal = () => {
    const basePrice = selectedSize ? selectedSize.price : item.base_price;
    const addonsTotal = selectedAddons.reduce(
      (sum, addon) => sum + addon.price,
      0
    );
    return basePrice + addonsTotal;
  };

  return (
    <>
      <div className="px-6 pb-3 border-b flex justify-between items-center">
        <div>
          <h3 className="font-extrabold text-lg text-neutral-800">Customize Item</h3>
          <p className="text-xs text-neutral-400 font-bold">{item.name}</p>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-5">
        {item.image_url && (
          <img
            src={item.image_url}
            alt={item.name}
            className="w-full h-44 object-cover rounded-2xl shadow-sm"
          />
        )}

        {item.description && (
          <p className="text-xs text-neutral-400 font-medium leading-relaxed bg-neutral-50 p-3.5 rounded-2xl border border-neutral-100">
            {item.description}
          </p>
        )}

        {/* Sizes */}
        {item.sizes && item.sizes.length > 0 && (
          <div>
            <h4 className="text-xs font-black text-neutral-400 uppercase tracking-widest mb-3">Select Variant</h4>
            <div className="grid grid-cols-2 gap-2.5">
              {item.sizes.map((size) => (
                <button
                  key={size.name}
                  onClick={() => setSelectedSize(size)}
                  className={`flex flex-col items-start p-3.5 rounded-2xl border-2 text-left transition-all ${
                    selectedSize?.name === size.name
                      ? "border-neutral-900 bg-neutral-50 text-neutral-900 font-extrabold shadow-sm"
                      : "border-neutral-100 hover:border-neutral-200 text-neutral-500 bg-white"
                  }`}
                >
                  <span className="font-extrabold text-sm">{size.name}</span>
                  <span className="text-xs font-black mt-1 text-amber-600">
                    {formatCurrency(size.price)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Addons */}
        {item.addons && item.addons.length > 0 && (
          <div>
            <h4 className="text-xs font-black text-neutral-400 uppercase tracking-widest mb-3">Optional Add-ons</h4>
            <div className="space-y-2">
              {item.addons.map((addon) => {
                const isSelected = !!selectedAddons.find((a) => a.name === addon.name);
                return (
                  <button
                    key={addon.name}
                    onClick={() => toggleAddon(addon)}
                    className={`w-full flex items-center justify-between p-3.5 rounded-2xl border-2 transition-all ${
                      isSelected
                        ? "border-neutral-900 bg-neutral-50 text-neutral-900 font-extrabold shadow-sm"
                        : "border-neutral-100 hover:border-neutral-200 text-neutral-500 bg-white"
                    }`}
                  >
                    <span className="font-extrabold text-xs">{addon.name}</span>
                    <span className="text-xs font-black text-amber-600">
                      +{formatCurrency(addon.price)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="bg-neutral-50/50 p-6 border-t border-neutral-100 rounded-t-3xl">
        <div className="flex justify-between items-center text-lg font-black text-neutral-800 mb-4">
          <span>Overall Cost</span>
          <span className="text-xl text-neutral-900">{formatCurrency(calculateTotal())}</span>
        </div>
        <button
          onClick={() => onAdd(item, selectedSize, selectedAddons)}
          className="w-full bg-neutral-900 hover:bg-neutral-800 text-white font-extrabold py-4 rounded-xl shadow-lg shadow-neutral-900/15 active:scale-[0.99] transition-all text-xs uppercase tracking-wider"
        >
          Add Customised Plate
        </button>
      </div>
    </>
  );
};


// 📋 Checkout Panel Component (Slide-up Content)
interface CheckoutContentProps {
  cart: CartItem[];
  restaurantId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const CheckoutContent: React.FC<CheckoutContentProps> = ({
  cart,
  restaurantId,
  onClose,
  onSuccess,
}) => {
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [orderType, setOrderType] = useState<"table" | "takeaway">("table");
  const [tableNumber, setTableNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);

  const subtotal = cart.reduce(
    (sum, item) => sum + item.itemTotal * item.quantity,
    0
  );
  const tax = subtotal * 0.05; // 5% GST
  const total = subtotal + tax;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!customerName.trim()) {
      setError("Please write down your name to identify your plates!");
      return;
    }

    if (!isValidPhone(customerPhone)) {
      setError("Please check you have entered a valid 10-digit mobile number");
      return;
    }

    if (orderType === "table" && !tableNumber.trim()) {
      setError("Please select/enter your designated table number");
      return;
    }

    setLoading(true);

    const { data, error: orderError } = await createOrderAsCustomer({
      restaurantId,
      orderType: orderType === "table" ? "qr" : "counter",
      tableNumber: orderType === "table" ? tableNumber : undefined,
      customerName,
      customerPhone,
      customerNotes: notes,
      items: cart.map((item) => ({
        menu_item_id: item.id,
        quantity: item.quantity,
        selected_size: item.selectedSize ?? null,
        selected_addons: item.selectedAddons,
      })),
    });
    setLoading(false);

    if (!orderError && data && Array.isArray(data) && data.length > 0) {
      setOrderNumber(data[0].order_number);
      setSuccess(true);
      setTimeout(() => {
        onSuccess();
        resetForm();
      }, 2500);
    } else {
      setError(orderError?.message || "Something went wrong. Let's try again.");
    }
  };

  const resetForm = () => {
    setCustomerName("");
    setCustomerPhone("");
    setTableNumber("");
    setNotes("");
    setOrderType("table");
    setSuccess(false);
    setOrderNumber(null);
  };

  if (success) {
    return (
      <div className="p-8 text-center bg-white rounded-t-[32px] flex flex-col items-center justify-center min-h-[50vh]">
        <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mb-6 animate-bounce">
          <CheckCircle className="w-12 h-12 text-emerald-500 stroke-[2.5]" />
        </div>
        <h3 className="text-2xl font-black text-neutral-800 leading-tight">Order Received!</h3>
        <p className="text-xs font-semibold text-neutral-400 mt-1 max-w-xs mx-auto">
          We have forwarded your order directly to the kitchen. Chef is on it!
        </p>

        {/* Short Order Stats Preview */}
        <div className="w-full bg-neutral-50 px-4 py-3 rounded-2xl border border-neutral-100 my-6 max-w-sm text-left">
          {orderNumber && (
            <div className="flex justify-between text-xs font-bold text-neutral-500 mb-1.5">
              <span>Order Number</span>
              <span className="text-neutral-800 font-extrabold">#{orderNumber}</span>
            </div>
          )}
          <div className="flex justify-between text-xs font-bold text-neutral-500 mb-1.5">
            <span>Customer</span>
            <span className="text-neutral-800 font-extrabold">{customerName}</span>
          </div>
          {orderType === "table" && (
            <div className="flex justify-between text-xs font-bold text-neutral-500">
              <span>Table Code</span>
              <span className="text-neutral-800 font-extrabold">Table #{tableNumber}</span>
            </div>
          )}
        </div>

        <Button onClick={onClose} fullWidth className="max-w-xs py-3.5 rounded-xl uppercase tracking-wider text-xs font-bold">
          Awesome, Close Tab
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="px-6 pb-3 border-b flex justify-between items-center">
        <div>
          <h3 className="font-extrabold text-lg text-neutral-800">Review Booking</h3>
          <p className="text-xs text-neutral-400 font-bold">Confirm location to deliver food</p>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full bg-neutral-100 flex items-center justify-center text-neutral-500"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
        {error && <Alert type="error" message={error} />}

        {/* Order Type */}
        <div>
          <label className="text-xs font-black text-neutral-400 uppercase tracking-widest mb-2 inline-block">Dine-in Method</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setOrderType("table")}
              className={`p-3.5 rounded-2xl border-2 font-bold transition-all text-xs flex flex-col items-center gap-1.5 ${
                orderType === "table"
                  ? "border-amber-500 bg-amber-50/40 text-amber-900 shadow-sm"
                  : "border-neutral-100 hover:border-neutral-200 text-neutral-500 bg-white"
              }`}
            >
              <span>🍽️</span>
              <span>Dine In (Table)</span>
            </button>
            <button
              type="button"
              onClick={() => setOrderType("takeaway")}
              className={`p-3.5 rounded-2xl border-2 font-bold transition-all text-xs flex flex-col items-center gap-1.5 ${
                orderType === "takeaway"
                  ? "border-amber-500 bg-amber-50/40 text-amber-900 shadow-sm"
                  : "border-neutral-100 hover:border-neutral-200 text-neutral-500 bg-white"
              }`}
            >
              <span>🛍️</span>
              <span>Takeaway / Parcel</span>
            </button>
          </div>
        </div>

        {/* Table Number */}
        {orderType === "table" && (
          <Input
            label="Your Table Number"
            value={tableNumber}
            onChange={(e) => setTableNumber(e.target.value)}
            placeholder="e.g. 4, 12, Upper Deck A"
            className="rounded-2xl py-3 border-neutral-100"
            required
          />
        )}

        {/* Customer Details */}
        <Input
          label="Your Call Name"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          placeholder="e.g. Rohit Sharma, John"
          className="rounded-2xl py-3 border-neutral-100"
          required
        />

        <Input
          label="10-Digit Mobile Number"
          type="tel"
          value={customerPhone}
          onChange={(e) => setCustomerPhone(e.target.value)}
          placeholder="e.g. 9876543210"
          className="rounded-2xl py-3 border-neutral-100"
          required
          helperText="Required by kitchen staff to contact or authenticate billing"
        />

        {/* Special Instructions */}
        <div>
          <label className="text-xs font-black text-neutral-400 uppercase tracking-widest mb-1.5 inline-block">Preparation Instructions</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Make it spicy! No onions, extra garlic, or specific food allergies."
            rows={2}
            className="w-full text-sm font-medium px-4 py-3 border border-neutral-200/80 rounded-2xl focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 bg-white/50 text-gray-800 placeholder-gray-400 leading-relaxed"
          />
        </div>

        {/* Order Cost summary */}
        <div className="bg-neutral-50 p-4 border border-neutral-100/55 rounded-2xl space-y-2 mt-4 text-xs font-bold text-neutral-500">
          <h4 className="text-neutral-800 font-extrabold mb-2 text-sm">Finances Summary</h4>
          
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span className="text-neutral-800">{formatCurrency(subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span>Tax GST (5%)</span>
            <span className="text-neutral-800">{formatCurrency(tax)}</span>
          </div>
          <div className="flex justify-between text-neutral-800 font-black pt-2 border-t border-neutral-100 text-sm">
            <span>Grand Total</span>
            <span className="text-amber-600 text-base">{formatCurrency(total)}</span>
          </div>
        </div>

        {/* Actions spacer */}
        <div className="flex gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose} fullWidth className="rounded-xl py-3 font-bold text-xs uppercase tracking-wider">
            Add More Dishes
          </Button>
          <Button type="submit" loading={loading} fullWidth className="rounded-xl py-3 font-bold text-xs uppercase tracking-wider">
            Place Order
          </Button>
        </div>
      </form>
    </>
  );
};

export default CustomerMenu;
