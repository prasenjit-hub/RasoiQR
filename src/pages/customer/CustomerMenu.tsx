import React, { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ShoppingCart,
  Plus,
  Minus,
  Search,
  Package,
  Pencil,
} from "lucide-react";
import { Alert, BottomSheet, Button, Card, Skeleton } from "../../components/ui";
import { DEFAULT_MENU_BANNER_URL } from "../../config/config";
import {
  getMenuForRestaurant,
  getMenuVersion,
  callWaiter,
  resolveTableCode,
} from "../../services/restaurantService";
import type { MenuItem } from "../../config/supabase";
import {
  formatCurrency,
  MAX_ITEM_QUANTITY,
  withTableCode,
} from "../../utils/helpers";
import { supabase } from "../../config/supabase";
import { persistentStorage } from "../../utils/persistentStorage";
import { usePollWhenVisible } from "../../utils/usePollWhenVisible";
import { useIdleShake } from "../../utils/useIdleShake";
import CustomerNavbar from "./components/CustomerNavbar";
import RestaurantHeader from "./components/RestaurantHeader";
import MenuItemCard from "./components/MenuItemCard";
import FloatingCartBar from "./components/FloatingCartBar";
import ItemCustomizerContent from "./components/ItemCustomizerContent";
import CheckoutContent from "./components/CheckoutContent";
import type { PlacedOrderInfo } from "./components/CheckoutContent";
import PaymentSheet from "./components/PaymentSheet";
import OrderSuccessToast from "./components/OrderSuccessToast";
import UndoToast from "./components/UndoToast";

export interface CartItem extends MenuItem {
  quantity: number;
  selectedSize?: { name: string; price: number };
  selectedAddons: { name: string; price: number }[];
  itemTotal: number;
}

// 🧬 One identity rule for a cart line: same dish + same size name + same
// add-ons. Adding and saving an edit both use it, so the two paths can never
// drift and produce visually identical rows that live separately.
const isSameCartLine = (
  a: CartItem,
  b: {
    id: string;
    selectedSize?: { name: string } | null;
    selectedAddons: { name: string }[];
  }
) =>
  a.id === b.id &&
  a.selectedSize?.name === b.selectedSize?.name &&
  JSON.stringify(a.selectedAddons) === JSON.stringify(b.selectedAddons);

/**
 * How often the guest's menu is re-checked for availability changes.
 *
 * The check is a ~35-byte version token (`get_menu_version`, migration 046); the
 * menu itself (659 bytes per item on the live database) is downloaded only when
 * that token moves, which is why this can be once a minute rather than the 20
 * seconds the order list uses — an order's status is what a guest is actively
 * waiting on, while a dish runs out at most a few times a day. It only runs
 * while the tab is visible (see usePollWhenVisible), so a phone in a pocket
 * costs nothing.
 */
const MENU_POLL_MS = 60_000;

/**
 * The menu this browser tab already has, kept OUTSIDE the component on purpose.
 *
 * Tapping Orders unmounts this page, and coming back used to start from nothing:
 * the guest watched a full-screen skeleton while the whole menu downloaded again
 * (~4 KB, plus a version check) — AND their cart was thrown away with it. The
 * cart is the half a guest notices: they wandered off to check their order and
 * came back to an empty tray.
 *
 * A module-level snapshot survives that unmount, so returning paints the dishes
 * and the cart the guest already had — instantly, no spinner — and only then
 * asks the ~35-byte version token whether anything actually needs re-downloading.
 *
 * Deliberately per tab and in memory only, exactly like the orders list:
 *  · a reload starts clean, which is the right lifetime for data the server
 *    re-validates on every fetch anyway;
 *  · NOT `persistentStorage`, which mirrors every value into a cookie as well. A
 *    menu plus a cart is kilobytes, cookies ride on every single request, and
 *    crossing the ~4 KB per-cookie limit would make the save fail silently on
 *    some browsers. Wedging the order flow to save one round trip is not a trade
 *    worth making.
 */
interface MenuSnapshot {
  restaurant: unknown;
  menuItems: MenuItem[];
  /** The version token that belongs to `menuItems` (migration 046). */
  version: string | null;
  /** The guest's tray — the part they would most notice losing. */
  cart: CartItem[];
}

const menuSnapshots = new Map<string, MenuSnapshot>();

const CustomerMenu: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();

  // Paint what this tab already has. A cache hit means the guest sees their menu
  // and their cart immediately, with no skeleton at all.
  const cached = slug ? menuSnapshots.get(slug) : undefined;

  const [restaurant, setRestaurant] = useState<any>(
    () => cached?.restaurant ?? null
  );
  const [menuItems, setMenuItems] = useState<MenuItem[]>(
    () => cached?.menuItems ?? []
  );
  const [cart, setCart] = useState<CartItem[]>(() => cached?.cart ?? []);
  const [loading, setLoading] = useState(!cached);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const [showCart, setShowCart] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const [placedOrder, setPlacedOrder] = useState<PlacedOrderInfo | null>(null);
  // 💸 A UPI order whose money has not been sent yet. The checkout stores the
  // choice; this sheet is where the guest actually pays, and it opens before
  // the success toast so nobody reads "Order placed" and walks away unpaid.
  const [paymentOrder, setPaymentOrder] = useState<PlacedOrderInfo | null>(null);
  const [selectedItem, setSelectedItem] = useState<MenuItem | null>(null);
  const [showItemModal, setShowItemModal] = useState(false);

  // ✏️ Cart-row edit: set while the customizer is editing an existing cart
  // line; its seed is the line's own selection, so the sheet never opens
  // pre-filled from the size default. Every close path clears it through
  // closeItemSheet — otherwise the next fresh add would inherit an edit seed.
  const [editContext, setEditContext] = useState<{
    index: number;
    seed: {
      size?: { name: string; price: number } | null;
      addons?: { name: string; price: number }[];
      quantity?: number;
    };
  } | null>(null);

  const closeItemSheet = () => {
    setShowItemModal(false);
    setEditContext(null);
  };

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // 👋 The Crave-box CTA nudges every 10s of stillness while its sheet is up,
  // so a guest who added items but stopped short of ordering is reminded.
  const cartCtaNudging = useIdleShake(showCart);

  // Each sheet now owns its own chrome (backdrop, drag, scroll lock) through
  // the shared BottomSheet, so there is nothing to wire up here.

  // Migration 045: a table QR now carries a per-table CODE (`?t=<code>`), never a
  // table number. The number a guest reads ("Table 5") comes back from the
  // SERVER, which is what makes a table impossible to invent — and an unknown
  // code (rotated standee, a typed URL, a stopped table) leaves the page in
  // takeaway mode with a banner instead of a form the order RPC would refuse.
  const tableCode = (searchParams.get("t") || "").trim().toLowerCase();
  const [tableLabel, setTableLabel] = useState<string | undefined>(undefined);
  const [tableCodeInvalid, setTableCodeInvalid] = useState(false);

  useEffect(() => {
    if (!slug || !tableCode) {
      setTableLabel(undefined);
      setTableCodeInvalid(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const found = await resolveTableCode(slug, tableCode);
      if (cancelled) return;
      setTableLabel(found?.label);
      setTableCodeInvalid(!found);
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, tableCode]);

  /**
   * The restaurant id every menu call needs.
   *
   * Held in a ref rather than read off `restaurant` state so the two loaders
   * below stay stable. While they depended on `restaurant?.id` the effects
   * calling them re-ran the moment the restaurant row arrived — which is how one
   * visit ended up asking for the menu twice. A snapshot seeds it, so a guest
   * returning from Orders never waits on the restaurant row at all.
   */
  const restaurantIdRef = useRef<string | null>(
    (cached?.restaurant as { id?: string } | undefined)?.id ?? null
  );

  /** The version token that describes the menu currently on screen (046). */
  const menuVersionRef = useRef<string | null>(cached?.version ?? null);

  /**
   * The restaurant row for this slug: the header, the banner, and whether the
   * restaurant is still open for orders at all. Nothing happens without it on a
   * cold visit, because the menu RPC is keyed by the id it carries.
   */
  const loadRestaurant = useCallback(async () => {
    if (!slug) return;

    const { data, error } = await supabase.rpc("get_restaurant_by_slug", {
      p_slug: slug,
    });

    if (error || !data || !Array.isArray(data) || data.length === 0) {
      console.error("Restaurant not found");
      setLoading(false);
      return;
    }

    restaurantIdRef.current = data[0].id;
    setRestaurant(data[0]);
  }, [slug]);

  /**
   * Load, or re-load, the guest's menu — together with the token that
   * identifies it.
   *
   * The two are asked for together on purpose: the stored token has to describe
   * the menu that was stored with it, or the next check would compare against a
   * state this screen never showed. They are independent requests, so the pair
   * costs no more waiting than the menu alone did.
   *
   * Reads the restaurant id from `restaurantIdRef` so it needs no dependencies
   * and never changes identity — see the ref above for why that matters.
   *
   * Never rejects: a failed fetch returns null and the menu already on screen
   * stays put, because an empty menu is a worse answer than a slightly old dish
   * list.
   */
  const loadMenu = useCallback(async () => {
    const restaurantId = restaurantIdRef.current;
    if (!restaurantId) return;

    const [items, version] = await Promise.all([
      getMenuForRestaurant(restaurantId),
      getMenuVersion(restaurantId),
    ]);

    if (items === null) {
      // The first load has nothing to keep, so stop the skeleton rather than
      // hang on it forever — the next poll, or coming back to the tab, fills
      // the menu in.
      setLoading(false);
      return;
    }

    if (version !== null) menuVersionRef.current = version;

    setMenuItems(items);
    setLoading(false);
  }, []);

  /**
   * The 60-second tick: ask the ~35-byte token first, and pay for the whole menu
   * only when it says something changed (migration 046).
   *
   * A failed check is deliberately NOT treated as "no change". A failure means
   * the answer is unknown, and the safe direction is the full refresh the app did
   * before this token existed — guessing "no change" on an error would let a menu
   * go stale silently, which is the exact bug this replaced. The extra cost is
   * paid only while checks are failing, and it degrades to the previous behaviour
   * (which was also correct, just wasteful) rather than to no refresh at all.
   */
  const refreshMenuIfChanged = useCallback(async () => {
    const restaurantId = restaurantIdRef.current;
    if (!restaurantId) return;

    const version = await getMenuVersion(restaurantId);

    // Same token means nothing moved, so the menu on screen is still current.
    if (version !== null && version === menuVersionRef.current) return;

    await loadMenu();
  }, [loadMenu]);

  /**
   * Opening the page. Keyed on the slug alone — the loaders are stable now, so
   * this runs once per visit instead of again every time the restaurant row
   * landed.
   *
   * A snapshot changes what "open" means. With one, the dishes and the cart are
   * already on screen, so the restaurant row and the ~35-byte version check are
   * asked for at the same time, and the whole menu is downloaded only if that
   * check says it moved. Without one, the restaurant row still has to land first,
   * because the menu RPC is keyed by its id.
   */
  useEffect(() => {
    void (async () => {
      if (menuSnapshots.has(slug ?? "")) {
        await Promise.all([loadRestaurant(), refreshMenuIfChanged()]);
        return;
      }

      await loadRestaurant();
      await loadMenu();
    })();
  }, [slug, loadRestaurant, loadMenu, refreshMenuIfChanged]);

  /**
   * Keep the snapshot in step with what is on screen — the cart most of all,
   * since that is the part a guest notices losing. Written after every change
   * rather than on the way out, so a fast tap on Orders cannot race it.
   */
  useEffect(() => {
    if (!slug || !restaurant) return;

    // Only ever file a row that belongs to THIS slug. During a slug change the
    // previous restaurant is still in state for a beat, and storing it here
    // would put restaurant A's dishes in restaurant B's snapshot.
    const rowSlug = (restaurant as { slug?: string }).slug;
    if (rowSlug && rowSlug !== slug) return;

    // And only file a COMPLETED load. `version` is set by the same call that sets
    // the menu, so a snapshot without one means the menu has not arrived yet —
    // reading that back on the next visit would paint an empty menu with no
    // skeleton, instead of loading it. (A restaurant with no menu at all is not
    // this case: it has a real token, `0|none`.)
    if (menuVersionRef.current === null) return;

    menuSnapshots.set(slug, {
      restaurant,
      menuItems,
      version: menuVersionRef.current,
      cart,
    });
  }, [slug, restaurant, menuItems, cart]);

  // 🍽️ Keep availability fresh while the guest reads. The kitchen marks an item
  // out of stock from its own dashboard, and `get_menu_for_restaurant` returns
  // only the available items — so without this a guest who scanned the QR
  // before that keeps seeing the dish and only finds out at the end of checkout.
  // A Realtime subscription cannot do it here (the guest is `anon`, which has no
  // privilege on `menu_items` — the subscription that replaced it could never
  // deliver a row). The cheap version is to poll the anon-callable version token
  // and re-download the menu only when it moves.
  usePollWhenVisible(
    refreshMenuIfChanged,
    MENU_POLL_MS,
    Boolean(restaurant?.id)
  );

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

    return matchesSearch && matchesCategory && item.is_available;
  }).sort((a, b) => {
    if (categoryFilter === "all") {
      return (b.sales_count || 0) - (a.sales_count || 0);
    }
    return 0;
  });

  const addToCart = (
    item: MenuItem,
    selectedSize?: any,
    selectedAddons: any[] = [],
    quantityToAdd: number = 1
  ) => {
    const basePrice = selectedSize ? selectedSize.price : item.base_price;
    const addonsTotal = selectedAddons.reduce(
      (sum, addon) => sum + addon.price,
      0
    );
    const itemTotal = basePrice + addonsTotal;

    const cartItem: CartItem = {
      ...item,
      quantity: Math.min(quantityToAdd, MAX_ITEM_QUANTITY),
      selectedSize,
      selectedAddons,
      itemTotal,
    };

    const existingIndex = cart.findIndex((ci) =>
      isSameCartLine(ci, { id: item.id, selectedSize, selectedAddons })
    );

    if (existingIndex >= 0) {
      const newCart = [...cart];
      // 🔒 Same per-line cap the server enforces — adding a plate to a line
      // that is already at the cap keeps it at the cap instead of overflowing.
      newCart[existingIndex].quantity = Math.min(
        newCart[existingIndex].quantity + quantityToAdd,
        MAX_ITEM_QUANTITY
      );
      setCart(newCart);
    } else {
      setCart([...cart, cartItem]);
    }

    closeItemSheet();
  };

  // ↩️ Undo state — the last removed item is kept whole (with size + add-ons)
  // so a single UNDO tap can put it back exactly where it was. The newest
  // removal replaces the previous one (Gmail-style); older ones are final.
  const [removedItem, setRemovedItem] = useState<{ item: CartItem; index: number } | null>(null);

  const updateQuantity = (index: number, delta: number) => {
    const current = cart[index];
    const nextQuantity = current.quantity + delta;

    // 🔒 Same per-line cap as the server. The + control is disabled at the cap
    // too; this guards the function itself against any stale caller.
    if (nextQuantity > MAX_ITEM_QUANTITY) return;

    if (nextQuantity <= 0) {
      // −@1 removes the row → keep it for the undo toast. Snapshot is taken
      // from the CURRENT row (spread copy, still at its last quantity) so undo
      // restores the item whole — never as a quantity-0 zombie row.
      setRemovedItem({ item: { ...current }, index });
      setCart(cart.filter((_, i) => i !== index));
      return;
    }

    const newCart = [...cart];
    newCart[index] = { ...current, quantity: nextQuantity };
    setCart(newCart);
  };

  const undoRemoval = () => {
    if (!removedItem) return;
    const newCart = [...cart];
    // Insert back at the ORIGINAL index, clamped in case items shifted.
    newCart.splice(Math.min(removedItem.index, newCart.length), 0, removedItem.item);
    setCart(newCart);
    setRemovedItem(null);
  };

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  // ✏️ Reopen the sheet on a cart line: it seeds from the line's own size,
  // add-ons and quantity, so the guest edits what they actually chose.
  const openEdit = (index: number) => {
    const row = cart[index];
    if (!row) return;
    setSelectedItem(row);
    setEditContext({
      index,
      seed: {
        size: row.selectedSize ?? null,
        addons: row.selectedAddons ?? [],
        quantity: row.quantity,
      },
    });
    setShowItemModal(true);
  };

  // ✏️ Save an edit: replace the line in place — or merge it into an
  // identical line (same identity rule as addToCart) so the cart never shows
  // two rows that are the same configuration. Merge only when the summed
  // quantity stays under the per-line cap; otherwise the row keeps its own
  // slot, so a quantity can never be silently dropped.
  const saveEditedCartItem = (
    item: MenuItem,
    selectedSize?: any,
    selectedAddons: any[] = [],
    quantityToSave: number = 1
  ) => {
    const index = editContext?.index ?? -1;
    const current = cart[index];
    // Defensive: the sheet covers the cart, so the row cannot vanish mid-edit,
    // but a missing row must never write a phantom line.
    if (!current) {
      closeItemSheet();
      return;
    }

    const basePrice = selectedSize ? selectedSize.price : item.base_price;
    const addonsTotal = selectedAddons.reduce(
      (sum, addon) => sum + addon.price,
      0
    );
    const nextRow: CartItem = {
      ...current,
      selectedSize,
      selectedAddons,
      quantity: Math.min(Math.max(quantityToSave, 1), MAX_ITEM_QUANTITY),
      itemTotal: basePrice + addonsTotal,
    };

    const otherIndex = cart.findIndex(
      (ci, i) => i !== index && isSameCartLine(ci, nextRow)
    );

    const next = [...cart];
    if (
      otherIndex >= 0 &&
      next[otherIndex].quantity + nextRow.quantity <= MAX_ITEM_QUANTITY
    ) {
      next[otherIndex] = {
        ...next[otherIndex],
        quantity: next[otherIndex].quantity + nextRow.quantity,
      };
      next.splice(index, 1);
    } else {
      next[index] = nextRow;
    }

    setCart(next);
    setRemovedItem(null); // a stale UNDO must not restore into a shifted cart
    closeItemSheet();
  };

  const handleItemClick = (item: MenuItem) => {
    if ((item.sizes && item.sizes.length > 0) || (item.addons && item.addons.length > 0)) {
      setSelectedItem(item);
      setShowItemModal(true);
    } else {
      addToCart(item);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50/50 pb-28">
        <Skeleton className="h-48 md:h-64 w-full rounded-none" />
        <div className="max-w-xl mx-auto px-4 -mt-20 relative z-20">
          <Card className="p-5 shadow-sm rounded-3xl">
            <div className="flex items-start gap-4">
              <Skeleton className="w-16 h-16 rounded-2xl flex-shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-6 w-48 mb-2" />
                <Skeleton className="h-4 w-32 mb-3" />
                <div className="flex gap-2">
                  <Skeleton className="h-6 w-20 rounded-lg" />
                  <Skeleton className="h-6 w-20 rounded-lg" />
                </div>
              </div>
            </div>
          </Card>
        </div>
        <div className="max-w-xl mx-auto px-4 mt-6">
          <Skeleton className="h-12 w-full rounded-2xl" />
        </div>
        <div className="max-w-xl mx-auto px-4 mt-5">
          <div className="flex gap-2 pb-2 overflow-x-hidden">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-8 w-24 rounded-xl flex-shrink-0" />
            ))}
          </div>
        </div>
        <div className="max-w-xl mx-auto px-4 py-6 grid gap-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Card key={i} className="flex gap-4 p-4 rounded-2xl">
              <div className="flex-1">
                <Skeleton className="h-5 w-3/4 mb-2" />
                <Skeleton className="h-4 w-full mb-1" />
                <Skeleton className="h-4 w-2/3 mb-4" />
                <Skeleton className="h-5 w-16" />
              </div>
              <Skeleton className="w-28 h-28 md:w-32 md:h-32 rounded-2xl flex-shrink-0" />
            </Card>
          ))}
        </div>
      </div>
    );
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

  // 🛎️ Call Waiter (migration 036). Only a table QR can do this: the RPC
  // requires a table number and rejects a blank one, and a takeaway customer
  // has no table for staff to walk to — so the navbar hides the button when
  // this is undefined instead of offering a control that cannot work.
  const handleCallWaiter =
    slug && tableCode && tableLabel ? () => callWaiter(slug, tableCode) : undefined;

  return (
    <div id="customer-ordering-root" className="min-h-screen bg-gray-50/50 pb-28">
      {/* 🧭 Sticky customer action bar — Call Waiter · Table · Orders */}
      <CustomerNavbar
        restaurantName={restaurant?.name}
        tableNumber={tableLabel}
        // The table code rides along: the Orders page must be able to hand the
        // guest back to the menu at THEIR table, not on the Master QR.
        onOrders={() => navigate(withTableCode(`/tracking/${slug}`, tableCode))}
        onCallWaiter={handleCallWaiter}
      />
      
      {/* 🚀 Dynamic Premium Cover Photo Banner */}      <div className="relative h-32 md:h-52 overflow-hidden w-full bg-slate-900">
        <img
          src={restaurant?.banner_url || DEFAULT_MENU_BANNER_URL}
          alt={restaurant?.name ? `${restaurant.name} banner` : "Restaurant banner"}
          className="w-full h-full object-cover transform scale-105 filter brightness-[0.45] blur-[1px]"
        />
      </div>

      {/* 🏡 Restaurant Floating Premium Info Card */}
      <RestaurantHeader restaurant={restaurant} />

      {/* A QR the server does not recognise — the standee was rotated, the table
          was stopped, or the link was typed by hand. Say so instead of letting
          the guest fill a checkout for a table that cannot order. */}
      {tableCodeInvalid && (
        <div className="max-w-xl mx-auto px-4 mt-4">
          <Alert
            type="warning"
            message="This table's QR code isn't valid any more. Please ask a member of staff for the new one — or order as takeaway below."
          />
        </div>
      )}

      {/* 🔍 Search */}
      {/* A slim bar, not a hero field: on a phone this sits between the name
          card and the sticky categories, so every 10px it keeps is 10px of menu
          pushed below the fold. 41px tall (py-2.5 + the 21px line box) still
          clears a comfortable touch target. */}
      <div className="max-w-xl mx-auto px-4 mt-4">
        <div className="relative mb-3 group">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 group-focus-within:text-amber-500 transition-colors" />
          <input
            type="text"
            placeholder="Search for dynamic dishes, starters, desserts..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-100 rounded-2xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/10 focus:border-amber-500 shadow-sm transition-all text-gray-800 placeholder-gray-400"
          />
        </div>
      </div>

      {/* 🏷️ Horizontal Category Scroll Slider */}
      <div className="bg-white border-b border-gray-100 sticky top-14 z-30 shadow-sm mt-4">
        <div className="max-w-xl mx-auto px-4">
          {/* Slim strip for phones: the pills carry the height on their own, so
              the wrapper only needs a little breathing room around them. */}
          <div className="flex gap-2 overflow-x-auto py-2 scrollbar-hide">
            {categories.map((category) => (
              <button
                key={category}
                onClick={() => setCategoryFilter(category || "all")}
                className={`px-3.5 py-1.5 rounded-xl text-xs font-extrabold whitespace-nowrap transition-all flex items-center gap-1.5 ${
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
              const hasVariations =
                (item.sizes && item.sizes.length > 0) ||
                (item.addons && item.addons.length > 0);

              return (
                <MenuItemCard
                  key={item.id}
                  item={item}
                  quantity={quantity}
                  hasVariations={hasVariations}
                  getCategoryEmoji={getCategoryEmoji}
                  handleItemClick={handleItemClick}
                  handleAddSimple={handleAddSimple}
                  handleRemoveItem={handleRemoveItem}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* 🍔 Cart — same shell as the customizer, checkout and payment sheets */}
      <BottomSheet
        open={showCart}
        onClose={() => setShowCart(false)}
        title="Your Crave-box"
        subtitle={`${cartCount} ${cartCount === 1 ? "item" : "items"} selected`}
      >
        
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-neutral-50">
          {cart.length === 0 ? (
            <div className="text-center py-12">
              <ShoppingCart className="w-16 h-16 text-neutral-300 mx-auto mb-4" />
              <p className="text-neutral-400 text-sm font-bold">Your tray is currently empty</p>
            </div>
          ) : (
            cart.map((item, index) => {
              // A configurable line (sizes and/or add-ons) can be edited from
              // here — tapping its info block opens the sheet pre-filled with
              // this row's choices; the pencil after the name is the cue. A
              // plain line keeps the non-interactive layout.
              const isEditable =
                (item.sizes && item.sizes.length > 0) ||
                (item.addons && item.addons.length > 0);

              return (
                <div
                  key={index}
                  className="flex items-center gap-3 pl-3 pr-2 py-3 border border-gray-100 rounded-2xl bg-white shadow-sm"
                >
                  {/* Info block — one control when editable, so the pencil and
                      the row share a single handler. aria-label replaces the
                      inner text for screen readers, so it carries the size. */}
                  <div
                    role={isEditable ? "button" : undefined}
                    tabIndex={isEditable ? 0 : undefined}
                    aria-label={
                      isEditable
                        ? `Edit ${item.name}${item.selectedSize ? ` (${item.selectedSize.name})` : ""}`
                        : undefined
                    }
                    onClick={isEditable ? () => openEdit(index) : undefined}
                    onKeyDown={
                      isEditable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openEdit(index);
                            }
                          }
                        : undefined
                    }
                    className={`flex items-center gap-3 flex-1 min-w-0${
                      isEditable ? " cursor-pointer" : ""
                    }`}
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
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h4 className="font-extrabold text-sm text-neutral-800 truncate min-w-0">
                          {item.name}
                        </h4>
                        {isEditable && (
                          <Pencil
                            aria-hidden="true"
                            className="w-3.5 h-3.5 text-neutral-400 flex-shrink-0"
                          />
                        )}
                      </div>
                  
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
                  </div>

                  <div className="flex-shrink-0">
                    <div className="flex items-center bg-white border border-neutral-100 rounded-xl shadow-sm">
                      <button
                        onClick={() => updateQuantity(index, -1)}
                        className="px-2.5 py-2.5 hover:bg-neutral-100 rounded-l-xl text-neutral-600 active:scale-90 transition-all"
                        aria-label="Decrease quantity"
                      >
                        <Minus className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                      <span className="w-6 text-center font-extrabold text-xs text-neutral-800 select-none">
                        {item.quantity}
                      </span>
                      <button
                        onClick={() => updateQuantity(index, 1)}
                        disabled={item.quantity >= MAX_ITEM_QUANTITY}
                        className="px-2.5 py-2.5 hover:bg-neutral-100 rounded-r-xl text-neutral-600 active:scale-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                        aria-label="Increase quantity"
                      >
                        <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            }))}
        </div>

        {cart.length > 0 && (
          <div className="bg-neutral-50/50 p-6 border-t border-neutral-100 rounded-t-3xl">
            <div className="flex justify-between items-center text-lg font-black text-neutral-800 mb-4">
              <span>Subtotal</span>
              <span className="text-xl">{formatCurrency(cart.reduce((sum, item) => sum + item.itemTotal * item.quantity, 0))}</span>
            </div>
            {/* Same shared Button + overrides as the checkout sheet's PLACE
                ORDER, so the two sheet CTAs render identically (height, type
                scale, radius, colour all come from one component). The extra
                class is the idle nudge — motion-sensitive guests keep the
                button still via motion-reduce. */}
            <Button
              fullWidth
              onClick={() => {
                setShowCart(false);
                setShowCheckout(true);
              }}
              className={`rounded-xl py-3.5 font-bold text-xs uppercase tracking-wider ${
                cartCtaNudging ? "animate-nudge-shake motion-reduce:animate-none" : ""
              }`}
            >
              Configure Dining & Place Order
            </Button>
          </div>
        )}
      </BottomSheet>

      {/* 📋 Item Customization — the sheet shell lives inside the component */}
      {selectedItem && (
          <ItemCustomizerContent
            isOpen={showItemModal}
            item={selectedItem}
            onClose={closeItemSheet}
            onAdd={editContext ? saveEditedCartItem : addToCart}
            mode={editContext ? "edit" : "add"}
            initialSelection={editContext?.seed ?? null}
          />
        )}

      {/* 🍕 Checkout — the sheet shell lives inside the component */}
      {restaurant && (
          <CheckoutContent
            isOpen={showCheckout}
            cart={cart}
            restaurantId={restaurant.id}
            slug={slug || ""}
            tableCode={tableLabel ? tableCode : undefined}
            tableLabel={tableLabel}
            onClose={() => setShowCheckout(false)}
            onSuccess={(order) => {
              // ✅ Order is safely in the DB. Close the sheet — the CSS
              // transition below slides it down (~300ms) while the backdrop
              // fades out simultaneously — then clear the cart (which also
              // unmounts the floating cart bar, since cartCount drops to 0)
              // and confirm with the success toast.
              setShowCheckout(false);
              setCart([]);
              // UPI prepaid → pay first, toast after. Everything else keeps the
              // old single-step success toast.
              if (order.paymentRequired && order.orderId) {
                setPaymentOrder(order);
              } else {
                setPlacedOrder(order);
              }

              if (order.orderId) {
                try {
                  const stored = persistentStorage.getItem(`recent_orders_${slug}`);
                  const currentOrders: string[] = stored ? JSON.parse(stored) : [];

                  // Keep unique orders only
                  const updatedOrders = Array.from(new Set([...currentOrders, order.orderId]));
                  persistentStorage.setItem(`recent_orders_${slug}`, JSON.stringify(updatedOrders));
                } catch {
                  // Private mode / unavailable storage must never break ordering.
                }
              }
            }}
          />
        )}

      {/* 🚀 Persistent Bottom Floating Cart Indicator */}
      {cartCount > 0 && !showCart && !showCheckout && !showItemModal && (
        <FloatingCartBar
          cartCount={cartCount}
          cart={cart}
          setShowCart={setShowCart}
        />
      )}

      {/* 💸 Direct-UPI payment sheet (migration 050). Shown instead of the
          toast for a prepaid order; "Done" then confirms normally. */}
      {/* Deliberately no toast after this closes: for a prepaid order the
          sheet IS the confirmation, and "Order placed successfully!" would be
          a lie to a guest who closed it without paying. */}
      <PaymentSheet order={paymentOrder} onClose={() => setPaymentOrder(null)} />

      {/* ✅ One-shot order confirmation toast (top-centre, auto-dismiss 4s) */}
      {placedOrder && (
        <OrderSuccessToast
          orderNumber={placedOrder.orderNumber}
          tableNumber={placedOrder.tableNumber}
          onDismiss={() => setPlacedOrder(null)}
        />
      )}

      {/* ↩️ 5-second undo window after a cart removal (bottom-centre) */}
      {removedItem && (
        <UndoToast
          key={`${removedItem.item.id}-${removedItem.index}-${removedItem.item.quantity}`}
          itemName={removedItem.item.name}
          onUndo={undoRemoval}
          onDismiss={() => setRemovedItem(null)}
        />
      )}
    </div>
  );
};

export default CustomerMenu;
