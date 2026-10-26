import React, { useEffect, useState } from "react";
import { CheckCircle, Minus, Plus, X } from "lucide-react";
import type { MenuItem } from "../../../config/supabase";
import { formatCurrency, MAX_ITEM_QUANTITY } from "../../../utils/helpers";

// 🎯 Default size rule — a configurable item opens with one size already
// selected, so the guest never lands on a dead "Select a Variant" button.
// The default is the size the menu card prices (cheapest; ties → first
// listed), so the amount shown on the card is exactly what the sheet opens
// on. The normal selected state is the only signal — no "default" badge or
// extra text. If the rule ever changes (e.g. an owner-set default), this is
// the one place to edit.
const getDefaultSize = (sizes?: { name: string; price: number }[]) => {
  if (!sizes || sizes.length === 0) return null;
  return sizes.reduce((cheapest, size) =>
    size.price < cheapest.price ? size : cheapest
  );
};

// ✏️ What the sheet opens on. Edit mode seeds from the cart line's real
// choice; a fresh add uses the default-size rule above. The mount seed and
// the reopen-reset both read this one function, so they can never disagree.
interface InitialSelection {
  size?: { name: string; price: number } | null;
  addons?: { name: string; price: number }[];
  quantity?: number;
}

const seedSelection = (
  item: MenuItem,
  mode: "add" | "edit",
  initial?: InitialSelection | null
) => ({
  size: mode === "edit" ? initial?.size ?? null : getDefaultSize(item.sizes),
  addons: mode === "edit" ? initial?.addons ?? [] : [],
  quantity: mode === "edit" ? initial?.quantity ?? 1 : 1,
});

// 🍕 Item Customizer Component (Separated for cleaner states)
interface ItemCustomizerContentProps {
  isOpen: boolean;
  item: MenuItem;
  onClose: () => void;
  onAdd: (item: MenuItem, selectedSize?: any, selectedAddons?: any[], quantity?: number) => void;
  /** "edit" = opened on a cart line: copy and button change, and the sheet
      opens on that line's own selection instead of the size default. */
  mode?: "add" | "edit";
  /** The cart line's saved choice (edit mode); wins over the size default. */
  initialSelection?: InitialSelection | null;
}

const ItemCustomizerContent: React.FC<ItemCustomizerContentProps> = ({
  isOpen,
  item,
  onClose,
  onAdd,
  mode = "add",
  initialSelection,
}) => {
  const isEditing = mode === "edit";
  const seed = seedSelection(item, mode, initialSelection);

  const [selectedSize, setSelectedSize] = useState<any>(seed.size);
  const [selectedAddons, setSelectedAddons] = useState<any[]>(seed.addons);
  const [quantity, setQuantity] = useState(seed.quantity);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);

  useEffect(() => {
    if (isOpen && !prevIsOpen) {
      const reset = seedSelection(item, mode, initialSelection);
      setSelectedSize(reset.size);
      setSelectedAddons(reset.addons);
      setQuantity(reset.quantity);
    }
    setPrevIsOpen(isOpen);
  }, [isOpen, prevIsOpen, item, mode, initialSelection]);

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
    // If sizes exist but none selected, show total as 0 or just addons
    if (item.sizes && item.sizes.length > 0 && !selectedSize) {
      return addonsTotal;
    }
    return basePrice + addonsTotal;
  };

  const isAddDisabled = !!(item.sizes && item.sizes.length > 0 && !selectedSize);

  return (
    <>
      <div className="px-6 pb-3 border-b flex justify-between items-center">
        <div>
          <h3 className="font-extrabold text-lg text-neutral-800">
          {isEditing ? "Edit Item" : "Customize Item"}
        </h3>
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
                      ? "border-emerald-500 bg-emerald-50/50 text-emerald-900 font-extrabold shadow-sm"
                      : "border-neutral-100 hover:border-neutral-200 text-neutral-500 bg-white"
                  }`}
                >
                  <div className="w-full flex items-center justify-between">
                    <span className="font-extrabold text-sm">{size.name}</span>
                    {selectedSize?.name === size.name ? (
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border-2 border-neutral-200" />
                    )}
                  </div>
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
                        ? "border-emerald-500 bg-emerald-50/50 text-emerald-900 font-extrabold shadow-sm"
                        : "border-neutral-100 hover:border-neutral-200 text-neutral-500 bg-white"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {isSelected ? (
                        <CheckCircle className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <div className="w-4 h-4 rounded-md border-2 border-neutral-200" />
                      )}
                      <span className="font-extrabold text-xs">{addon.name}</span>
                    </div>
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

      <div className="bg-neutral-50/50 p-6 border-t border-neutral-100 rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.03)]">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3 bg-white border border-neutral-200 rounded-xl px-2 py-1 shadow-sm">
            <button
              onClick={() => quantity > 1 && setQuantity(q => q - 1)}
              className="p-2 hover:bg-neutral-50 rounded-lg text-neutral-600 disabled:opacity-50"
              disabled={quantity <= 1}
            >
              <Minus className="w-4 h-4 stroke-[3]" />
            </button>
            <span className="w-6 text-center font-extrabold text-sm text-neutral-800 select-none">
              {quantity}
            </span>
            <button
              onClick={() =>
                setQuantity((q) => Math.min(q + 1, MAX_ITEM_QUANTITY))
              }
              disabled={quantity >= MAX_ITEM_QUANTITY}
              aria-label="Increase quantity"
              className="p-2 hover:bg-neutral-50 rounded-lg text-neutral-600 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              <Plus className="w-4 h-4 stroke-[3]" />
            </button>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-neutral-400 font-bold uppercase tracking-widest leading-none mb-1">Total</p>
            <span className="text-xl font-black text-neutral-900">{formatCurrency(calculateTotal() * quantity)}</span>
          </div>
        </div>
        <button
          onClick={() => !isAddDisabled && onAdd(item, selectedSize, selectedAddons, quantity)}
          disabled={isAddDisabled}
          className={`w-full font-extrabold py-4 rounded-xl shadow-lg active:scale-[0.99] transition-all text-xs uppercase tracking-wider ${
            isAddDisabled 
              ? "bg-neutral-200 text-neutral-400 shadow-none cursor-not-allowed" 
              : "bg-neutral-900 hover:bg-neutral-800 text-white shadow-neutral-900/15"
          }`}
        >
          {isAddDisabled ? "Select a Variant" : isEditing ? "Update Plate" : "Add Customised Plate"}
        </button>
      </div>
    </>
  );
};

export default ItemCustomizerContent;
