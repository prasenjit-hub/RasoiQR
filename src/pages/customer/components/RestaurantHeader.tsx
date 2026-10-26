import React from "react";
import { Clock, Star } from "lucide-react";
import { restaurantNameSizeClass } from "../../../utils/helpers";

interface RestaurantHeaderProps {
  restaurant: any;
}

// 🏡 Restaurant Floating Premium Info Card
const RestaurantHeader: React.FC<RestaurantHeaderProps> = ({ restaurant }) => {
  // Note: the table number deliberately lives only in the sticky CustomerNavbar
  // — it stays on screen while the customer scrolls this card away.
  //
  // Two evenly-weighted chips: same height, same padding, same icon size. The
  // rating keeps the warm accent (it is the strongest social proof) and the
  // prep time stays neutral so it reads as secondary.
  const statsItems = (
    <>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 font-bold text-amber-700 ring-1 ring-inset ring-amber-100">
        <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" aria-hidden />
        <span className="tabular-nums">4.9</span>
        {/* A real 1px rule instead of a "|" glyph — glyph weight and position
            drift with the font, this always lines up. */}
        <span className="h-3 w-px shrink-0 bg-amber-200" aria-hidden />
        <span className="font-semibold">100+ Ratings</span>
      </span>

      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-50 px-2.5 py-1 font-semibold text-gray-600 ring-1 ring-inset ring-gray-100">
        <Clock className="h-3 w-3 shrink-0 text-amber-500" aria-hidden />
        <span>15-20 mins</span>
      </span>
    </>
  );

  return (
    <div className="max-w-xl mx-auto px-4 -mt-16 relative z-20">
      {/* p-4, not p-5: the card floats over the cover photo, so its padding is
          height the guest pays for twice — once as empty white below the chips
          and once as photo it covers up again. */}
      <div className="bg-white rounded-3xl p-4 shadow-[0_15px_35px_rgba(0,0,0,0.06)] border border-gray-100">
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
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1
                className={`font-extrabold ${restaurantNameSizeClass(
                  restaurant.name
                )} text-gray-900 tracking-tight leading-snug break-words line-clamp-2`}
              >
                {restaurant.name}
              </h1>
            </div>
            <p className="text-xs font-semibold text-amber-600 mt-0.5 tracking-wider uppercase">
              {restaurant.restaurant_type || "Fine Dining / Multi-Cuisine"}
            </p>

            <div className="hidden sm:flex flex-wrap items-center gap-2 mt-3 border-t border-gray-100 pt-3 text-xs">
              {statsItems}
            </div>
          </div>
        </div>
        {/* Centred on phones so the leftover width splits evenly between the
            two sides instead of all landing on the right. Desktop (sm:+)
            keeps the stats left-aligned under the name. */}
        <div className="flex sm:hidden flex-wrap items-center justify-center gap-2 mt-2.5 border-t border-gray-100 pt-2.5 text-xs">
          {statsItems}
        </div>
      </div>
    </div>
  );
};

export default RestaurantHeader;
