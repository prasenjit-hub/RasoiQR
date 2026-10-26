import React, { useRef, useState } from 'react';
import { Upload, X, Loader2, Image as ImageIcon, RefreshCw, Trash2 } from 'lucide-react';
import { uploadImageToCloudinary } from '../../services/imageService';

interface ImageUploadProps {
  value: string;
  onChange: (url: string) => void;
  label?: string;
  className?: string;
  /**
   * `square` (default) is the 128px avatar frame used for logos and menu items.
   * `banner` is a wide 4:1 frame for cover images — it matches the shape the
   * customer menu crops to, so what you see here is what customers get.
   */
  variant?: "square" | "banner";
}

const FRAME_CLASS: Record<"square" | "banner", string> = {
  square: "w-32 h-32",
  banner: "w-full aspect-[4/1]",
};

/**
 * The empty banner frame is allowed to grow into whatever height its column has
 * left over (capped), because on the owner's own phone a taller target is worth
 * more than a strictly 4:1 box. The shape is still stated by the chips beside it
 * and by the 4:1 frame the photo gets the moment it is uploaded.
 */
const EMPTY_BANNER_FRAME = "w-full flex-1 min-h-[8.5rem] max-h-[220px]";

/**
 * Longest edge we ask the CDN to keep. A square avatar tops out at 128px on
 * screen, so 800 is generous; a menu banner is drawn 1000px+ wide on desktop
 * and needs the resolution or it renders soft.
 */
const MAX_WIDTH: Record<"square" | "banner", number> = {
  square: 800,
  banner: 1600,
};

/**
 * The window a customer actually sees, as a percentage inset of this 4:1 frame.
 *
 * Phone-first, because a QR standee is scanned with a phone:
 *
 *  · Sides — the customer page draws the cover `object-cover` in a 375x128
 *    strip (2.9:1), so a 4:1 photo loses its left and right edges, and the page
 *    zooms 5% on top of that (`scale-105`). Measured: ~73% of the width lands
 *    on screen, so the 15% inset is a touch conservative on purpose.
 *  · Bottom half — the restaurant card overlaps the strip by `-mt-16`, which is
 *    64px of a 128px strip: exactly half is hidden. Measured on the live menu at
 *    390px (strip 56→184, card top 120). Vertical centring is the classic banner
 *    mistake, so the guide has to show it rather than describe it.
 *  · Top — a phone shows the photo's top edge, so nothing is trimmed there; the
 *    2% is only breathing room between the box and the frame's border.
 *
 * The app is phone-first, so a laptop's crop (a 208px strip, where the top and
 * bottom go instead) deliberately does not shape this guide. A photo framed for
 * the box below still loses its extremes on a laptop — that is the accepted
 * trade for getting the phone right.
 */
const SAFE_AREA = { x: "15%", top: "2%", bottom: "50%" };

export const ImageUpload: React.FC<ImageUploadProps> = ({ 
  value, 
  onChange, 
  label = "Image", 
  className = "",
  variant = "square",
}) => {
  const isBanner = variant === "banner";
  const frame = FRAME_CLASS[variant];
  const maxWidth = MAX_WIDTH[variant];
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openPicker = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (e.g. max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be less than 5MB');
      return;
    }

    try {
      setIsUploading(true);
      setError(null);
      const url = await uploadImageToCloudinary(file, maxWidth);
      onChange(url);
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Failed to upload image. Please try again.'
      );
    } finally {
      setIsUploading(false);
      // Reset input so the same file could be selected again if needed
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRemove = () => {
    onChange('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const actionButton =
    "inline-flex items-center gap-1 rounded-lg bg-white/95 px-2 py-1 text-[11px] font-semibold shadow-sm backdrop-blur transition-colors hover:bg-white focus:outline-none focus:ring-2 focus:ring-offset-1";

  return (
    <div className={isBanner ? `flex flex-1 flex-col gap-2 ${className}` : `space-y-2 ${className}`}>
      {label && <label className="block text-sm font-medium text-text">{label}</label>}
      
      <div className={`flex flex-1 flex-col items-start gap-4`}>
        {value ? (
          isBanner ? (
            <div className="relative w-full overflow-hidden rounded-xl border border-border">
              {/* The frame holds the photo (and its guide) in their own box: the
                  guide is `inset-0`, so once the actions drop below the photo on
                  small screens it must not stretch down over them. */}
              <div className="relative">
                <img
                  src={value}
                  alt="Uploaded banner preview"
                  className={`${frame} object-cover`}
                />

              {/* One meaning for the dim: outside this box nobody sees your photo.
                  Pointer-events off so it never blocks the buttons below, and the
                  parent's `overflow-hidden` keeps the 9999px shadow inside the
                  frame. */}
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <span
                  className="absolute rounded-md border border-dashed border-white/90 shadow-[0_0_0_9999px_rgba(2,6,23,0.58)]"
                  style={{ left: SAFE_AREA.x, right: SAFE_AREA.x, top: SAFE_AREA.top, bottom: SAFE_AREA.bottom }}
                />
                <span
                  className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/95 px-2 py-[3px] text-[10px] font-semibold text-text shadow-sm"
                  style={{ top: `calc(${SAFE_AREA.top} + 4px)` }}
                >
                  Shown on a phone
                </span>
                {/* Sits at the left so it never fights the Replace/Remove pair. */}
                <span className="absolute bottom-2 left-3 whitespace-nowrap text-[10px] font-medium text-white/90">
                  Behind your name card
                </span>
                </div>
              </div>

              {/* Labelled actions beat a bare ✕ on a wide frame: "Remove" is a
                  destructive tap you want to read before making, and "Replace"
                  is the common follow-up after uploading the wrong photo.

                  Under `sm` they drop below the photo instead of floating on it
                  — in a narrow column the photo is only ~66px tall, so overlay
                  buttons fought the guide's bottom label for the same strip. */}
              <div className="flex items-center justify-end gap-1.5 px-1 pt-2 sm:absolute sm:bottom-2 sm:right-2 sm:p-0">
                <button
                  type="button"
                  onClick={openPicker}
                  className={`${actionButton} text-text ring-1 ring-inset ring-border hover:ring-border`}
                >
                  <RefreshCw className="h-3 w-3" />
                  Replace
                </button>
                <button
                  type="button"
                  onClick={handleRemove}
                  className={`${actionButton} text-error ring-1 ring-inset ring-error/25`}
                >
                  <Trash2 className="h-3 w-3" />
                  Remove
                </button>
              </div>
            </div>
          ) : (
            <div className="relative inline-block">
              <img 
                src={value} 
                alt="Uploaded preview" 
                className={`${frame} object-cover rounded-lg border border-border`}
              />
              <button
                type="button"
                onClick={handleRemove}
                className="absolute -top-2 -right-2 bg-white rounded-full p-1 shadow-md border border-border text-error hover:bg-error/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )
        ) : isBanner ? (
          // A real <button>: on a 4:1 frame this is the only control in the
          // section, so it should be tabbable and pressable with Enter.
          <button
            type="button"
            onClick={openPicker}
            className={`${EMPTY_BANNER_FRAME} flex flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border-2 border-dashed border-border bg-bg-subtle px-4 text-center transition-colors hover:border-text-secondary/40 hover:bg-white`}
          >
            {isUploading ? (
              <Loader2 className="w-5 h-5 text-text-secondary animate-spin" />
            ) : (
              <>
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white text-text-secondary shadow-sm ring-1 ring-inset ring-border">
                  <ImageIcon className="h-4 w-4" />
                </span>
                <span className="text-sm font-semibold text-text">Upload banner</span>
                <span className="hidden text-xs text-text-secondary sm:block">
                  1600 × 400 px works best
                </span>
              </>
            )}
          </button>
        ) : (
          <div 
            className={`${frame} flex flex-col items-center justify-center border-2 border-dashed border-border rounded-lg bg-bg-subtle hover:bg-bg-subtle/80 cursor-pointer transition-colors relative`}
            onClick={() => fileInputRef.current?.click()}
          >
            {isUploading ? (
              <Loader2 className="w-6 h-6 text-text-secondary animate-spin" />
            ) : (
              <>
                <Upload className="w-6 h-6 text-text-secondary mb-2" />
                <span className="text-xs text-text-secondary">Upload Image</span>
              </>
            )}
          </div>
        )}
        
        <input 
          type="file" 
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          className="hidden"
        />
        
        {error && <p className="text-sm text-error">{error}</p>}
        {isUploading && <p className="text-sm text-text-secondary">Uploading...</p>}
      </div>
    </div>
  );
};
