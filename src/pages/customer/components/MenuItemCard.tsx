import React from "react";
import { Minus, Plus } from "lucide-react";
import type { MenuItem } from "../../../config/supabase";
import { formatCurrency, MAX_ITEM_QUANTITY } from "../../../utils/helpers";
import VegIndicator from "./VegIndicator";

interface MenuItemCardProps {
  item: MenuItem;
  quantity: number;
  hasVariations: boolean | undefined;
  getCategoryEmoji: (category: string | undefined) => string;
  handleItemClick: (item: MenuItem) => void;
  handleAddSimple: (item: MenuItem) => void;
  handleRemoveItem: (itemId: string) => void;
}

const MenuItemCard: React.FC<MenuItemCardProps> = ({
  item,
  quantity,
  hasVariations,
  getCategoryEmoji,
  handleItemClick,
  handleAddSimple,
  handleRemoveItem,
}) => {
  return (
    <div
      key={item.id}
      className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm hover:shadow-md transition-all duration-200 flex gap-4 relative overflow-hidden"
    >
      {/* Left Column: Food Specs & Details */}
      <div className="flex-1 min-w-0 flex flex-col justify-between">
        <div>
          {/* Name & Desc — veg mark sits inline, left of the name */}
          <div className="flex items-start gap-2">
            {/* mt-* centers the mark on the name's first line (null → nothing, no gap) */}
            {item.is_veg != null && (
              <VegIndicator
                isVeg={item.is_veg}
                className="mt-[3px] sm:mt-0.5 w-3.5 h-3.5 sm:w-4 sm:h-4"
              />
            )}
            <h3 className="font-extrabold text-base text-gray-800 tracking-tight leading-tight mb-1">
              {item.name}
            </h3>
          </div>
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

        {/* Plates already in the cart for a configurable item. Informational
            only — it never changes a quantity; it exists because variants have
            no stepper, so this is the only sign on the card that something was
            added. Rendered before the availability block, so the Sold Out
            overlay keeps covering it. */}
        {hasVariations && quantity > 0 && (
          <span
            aria-label={`${quantity} added to cart`}
            className="absolute right-1.5 top-1.5 min-w-[20px] h-5 px-1.5 inline-flex items-center justify-center rounded-full border-2 border-white bg-neutral-900 text-[10px] font-extrabold text-white shadow-sm"
          >
            {quantity}
          </span>
        )}

        {/* Elite ADD/Minus overlap widget.
            A configurable item (sizes and/or add-ons) never gets the −/N/+
            stepper: that control promises "quantity of this exact plate", but
            each configuration is its own cart row (Half, Full, extra cheese…),
            so − used to drop whichever row matched first — a silent
            wrong-item removal, and the number read as a dish count it wasn't.
            Customizing happens in the customizer, and editing/removing happens
            in the cart sheet, where every row shows its own size and add-ons. */}
        {item.is_available ? (
          <div className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-24">
            {hasVariations || quantity === 0 ? (
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
                  disabled={quantity >= MAX_ITEM_QUANTITY}
                  aria-label="Increase quantity"
                  className="px-2.5 py-2 hover:bg-neutral-800 active:scale-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
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
};

export default MenuItemCard;
