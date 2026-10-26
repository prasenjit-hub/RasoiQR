import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Button } from "../../../components/ui";
import {
  getAlertSoundState,
  playAlertSound,
  setAlertSoundMuted,
  setAlertSoundVolume,
  subscribeAlertSoundSettings,
} from "../../../utils/helpers";

/**
 * The kitchen's own alert-sound knob: mute + volume for the order and waiter
 * chimes (migration 036 added the waiter one).
 *
 * It sits in the top nav because the dashboard shell is mounted on every tab —
 * a tablet showing Orders still has to be able to silence or raise the chime
 * without navigating away first. The value it writes is per *device*
 * (localStorage, see helpers.ts), so the counter tablet can stay loud while the
 * owner's phone stays quiet.
 */
const AlertSoundMenu: React.FC = () => {
  const { muted, volume, blocked } = useSyncExternalStore(
    subscribeAlertSoundSettings,
    getAlertSoundState
  );
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside press and on Escape. `pointerdown` rather than `click`, so
  // the panel is gone before the press reaches whatever is underneath it.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Hand focus back to the trigger, or a keyboard user is dropped at the
      // top of the document.
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const percent = Math.round(volume * 100);
  const statusLabel = muted ? "Alert sound is off" : `Alert sound on, ${percent}%`;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={statusLabel}
        title={statusLabel}
        className="relative rounded-lg p-2 text-text-secondary transition-colors hover:bg-bg-subtle hover:text-text focus:outline-none focus:ring-2 focus:ring-accent"
      >
        {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
        {/* The dot shows only while silenced: a silent tablet must never be a
            mystery to whoever picks it up. */}
        {muted && (
          <span
            className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warning ring-2 ring-white"
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Alert sound"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-xl border border-border bg-white p-3 text-left shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-text">Alert sound</p>
              <p className="text-xs text-text-secondary">
                {muted ? "Off" : `On · ${percent}%`}
              </p>
            </div>
            {/* role="switch" so a screen reader announces on/off rather than a
                nameless toggle. */}
            <button
              type="button"
              role="switch"
              aria-checked={!muted}
              aria-label="Alert sound"
              onClick={() => setAlertSoundMuted(!muted)}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 ${
                muted ? "bg-border" : "bg-accent"
              }`}
            >
              <span
                className={`absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                  muted ? "translate-x-0" : "translate-x-5"
                }`}
              />
            </button>
          </div>

          <label
            htmlFor="alert-sound-volume"
            className="mt-3 block text-xs font-medium text-text"
          >
            Volume
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="alert-sound-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={muted}
              onChange={(event) => setAlertSoundVolume(Number(event.target.value))}
              className="h-1.5 w-full cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
            <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-text-secondary">
              {percent}%
            </span>
          </div>

          {/* A slider you cannot hear is a guess, so the volume being set is
              played back. Disabled while muted — there is nothing to hear, and
              silently unmuting for a test would be a lie about the setting. */}
          <Button
            size="sm"
            variant="ghost"
            disabled={muted}
            onClick={() => playAlertSound("order")}
            icon={<Volume2 className="h-4 w-4" />}
            className="mt-3 w-full"
          >
            Test sound
          </Button>

          {blocked && (
            <p className="mt-2 rounded-lg bg-warning/10 px-2 py-1.5 text-[11px] text-text-secondary">
              The browser blocked the last alert. Click anywhere on this page once and
              the next one will play.
            </p>
          )}

          <p className="mt-2 text-[11px] text-text-secondary">
            Saved on this device only — other phones and tablets keep their own
            setting.
          </p>
        </div>
      )}
    </div>
  );
};

export default AlertSoundMenu;
