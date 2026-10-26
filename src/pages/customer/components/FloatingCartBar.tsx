import React from "react";
import { ChevronRight } from "lucide-react";
import { formatCurrency } from "../../../utils/helpers";
import type { CartItem } from "../CustomerMenu";

interface FloatingCartBarProps {
  cartCount: number;
  cart: CartItem[];
  setShowCart: (open: boolean) => void;
}

// 🚀 Persistent Bottom Floating Cart Indicator
const FloatingCartBar: React.FC<FloatingCartBarProps> = ({
  cartCount,
  cart,
  setShowCart,
}) => {
  return (
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
  );
};

export default FloatingCartBar;
