import React from "react";

interface VegIndicatorProps {
  isVeg: boolean | null | undefined;
  /** Fallback mark edge length in px (default 15) — overridden by className sizing. */
  size?: number;
  /** Extra classes for the svg — e.g. responsive sizing: "w-3 h-3 sm:w-4 sm:h-4". */
  className?: string;
}

// FSSAI-style Veg / Non-Veg mark: a square outline holding a filled circle
// (veg) or a filled triangle (non-veg) — the mark Indian food apps use.
// Renders nothing when the value is null/undefined ("not yet classified"),
// so callers need no placeholder and cause no layout shift.
const VegIndicator: React.FC<VegIndicatorProps> = ({ isVeg, size = 15, className = "" }) => {
  if (isVeg !== true && isVeg !== false) return null;

  const isVegValue = isVeg === true;
  const markColor = isVegValue ? "#16a34a" : "#dc2626"; // green-600 / red-600

  // Drawn as a 24-unit SVG so the outline stays crisp at any footprint.
  return (
    <svg
      role="img"
      aria-label={isVegValue ? "Veg" : "Non-Veg"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`flex-shrink-0 ${className}`}
    >
      <rect
        x="1.6"
        y="1.6"
        width="20.8"
        height="20.8"
        rx="2.6"
        fill="none"
        stroke={markColor}
        strokeWidth="3.2"
      />
      {isVegValue ? (
        <circle cx="12" cy="12" r="5.1" fill={markColor} />
      ) : (
        <path d="M12 6.6 L17.6 16.6 L6.4 16.6 Z" fill={markColor} />
      )}
    </svg>
  );
};

export default VegIndicator;
