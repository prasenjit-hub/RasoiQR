# Customer ordering — 9:16 narrated promo

**`rasoiqr-customer-flow-vertical-9x16.mp4`** · 1080×1920 · 30 fps · 60.23s · H.264 + AAC

Built with **Remotion** (React), so the motion graphics are real layout and real
springs rather than a single `drawtext` filter graph: captions are a centred CSS
column, cards are flex boxes, and the handset is a DOM tree that can be pushed,
tilted and lit per shot.

## How it is produced

| Step | Command | What it produces |
|---|---|---|
| 1. Measure the take | `node tools/find-content-box.mjs` | The live rectangle inside the screen recording is **430×932 at 0:0** of an 860×1864 frame — the rest of the frame is flat grey left by the recorder. Clips are cut from that box. |
| 2. Word-level transcription | `uv run --with faster-whisper python words.py …` | `src/words.json`: 146 words with real start/end times, so the karaoke highlight lands on the word being spoken. |
| 3. Timeline | `node tools/make-timeline.mjs` | `src/timeline.ts` + `out/timeline.json`: 18 shots, 36 caption pages, 10 chapters, 1807 frames. |
| 4. Footage clips | `node tools/make-clips.mjs` | One frame-exact H.264 clip per shot in `public/footage/clips/`, cropped, retimed to its narration slot and padded so a shot holds through the pauses. |
| 5. Composition | `npx remotion render Promo out/rasoiqr-customer-flow-vertical-9x16.mp4` | The finished file. |
| 6. Verification | `node tools/stills.mjs` then `node tools/check-stills.mjs out/stills/f*.png` | Still frames plus a pixel measurement of where caption text actually landed. |

Re-running 3 → 4 → 5 is the whole loop when the narration or the order of the
demo changes. `npm install` in `.freebuff/video/remotion` first (Remotion is free
for individuals and teams of up to three).

## Chapters (one per spoken sentence)

| # | At | Chapter chip |
|---|---|---|
| 01 | 00:00 | RIGHT FROM THE TABLE |
| 02 | 00:05 | SCAN & BROWSE |
| 03 | 00:13 | MAKE IT YOURS |
| 04 | 00:21 | ONE TAP TO TRAY |
| 05 | 00:23 | REVIEW YOUR TRAY |
| 06 | 00:29 | TABLE AUTO-DETECTED |
| 07 | 00:34 | NO APP TO INSTALL |
| 08 | 00:38 | STRAIGHT TO THE KITCHEN |
| 09 | 00:43 | LIVE ORDER TRACKING |
| 10 | 00:53 | START FREE |

## Shots

| From | Shot | Overlay | Camera | Chapter | Caption at cut |
|---|---|---|---|---|---|
| 00:00 | `title` | hero | rise | RIGHT FROM THE TABLE | Meet RasoiQR, ordering made |
| 00:05 | `menu_top` | qrscan | push | SCAN & BROWSE | table. Guests scan the table |
| 00:08 | `menu_browse` | chipsMenu | driftLeft | SCAN & BROWSE | instantly in their |
| 00:13 | `customiser_open` | calloutVariants | push | MAKE IT YOURS | labels. For dishes with |
| 00:15 | `customiser_size` | sizePills | tilt | MAKE IT YOURS | variant, add their preferred |
| 00:17 | `customiser_addon` | addonPills | tilt | MAKE IT YOURS | extras, and customize the |
| 00:18 | `customiser_confirm` | priceUp | push | MAKE IT YOURS | order before adding it to |
| 00:21 | `add_simple` | tapPulse | push | ONE TAP TO TRAY | the tray. One tap adds |
| 00:23 | `tray_open` | trayTotal | driftRight | ONE TAP TO TRAY | tray. Guests can review |
| 00:27 | `tray_review` | qtyStepper | tilt | REVIEW YOUR TRAY | total, adjust quantities, or |
| 00:30 | `checkout_open` | tablePill | push | TABLE AUTO-DETECTED | keep browsing. For a |
| 00:34 | `checkout_form` | formTyping | driftLeft | TABLE AUTO-DETECTED | the table automatically. No |
| 00:36 | `checkout_notes` | noteChip | driftRight | NO APP TO INSTALL | type. Guests just add a |
| 00:38 | `place_order` | sendTicket | push | STRAIGHT TO THE KITCHEN | number. Orders go straight |
| 00:40 | `toast` | linkChip | driftLeft | STRAIGHT TO THE KITCHEN | to the kitchen. Every order |
| 00:43 | `history` | historyList | driftRight | STRAIGHT TO THE KITCHEN | link. Guests can revisit |
| 00:47 | `tracking` | statusTimeline | push | LIVE ORDER TRACKING | bar and follow each |
| 00:53 | `end` | endcard | none | START FREE | staff. Try RasoiQR |

## What is on screen

- **Background** — four drifting colour fields, a grid that creeps upward, a light sweep every ~9 s, film grain and a vignette, all in `src/components/Background.tsx`.
- **Handset** — metal rail, travelling glare and a halo, wrapped around the screen recording (`src/components/DeviceFrame.tsx`). No drawn notch: the recording is a full app screen whose own navbar already sits at the top edge.
- **HUD** — a progress rail across the whole video, the brand lockup, and a chapter chip that changes on every sentence (`src/components/Hud.tsx`).
- **Captions** — max five words / 28 characters per page at 54 px Inter ExtraBold, word-by-word highlight from the transcription, a growing accent rule and a per-page progress line (`src/components/Captions.tsx`).
- **Shot overlays** — 18 layouts in `src/overlays/index.tsx`: QR scan card, floating feature chips, a variant callout with a leader line, size pills, add-on toggles, a live-price counter, tap ripples, a tray total, a quantity stepper, table auto-detect, typing form fields, a kitchen note, a flying order ticket, a tracking link, past orders, a live status timeline, and the end card.
- **Audio** — your recording, kept as `public/audio/voiceover-source.wav` and loudness-normalised once with `loudnorm=I=-16:TP=-1.5` into the `voiceover.wav` the composition plays (−17.3 LUFS integrated, −4.5 dBTP; the untouched take measured −18.8). Faded in and out; narration ends at 58.38s inside a 60.23s video.

## Why the captions cannot run off the edge

The caption column is fixed: 1080 px canvas, 100 px side padding, 880 px max
width, pages capped at 28 characters. The previous version placed text with an
ffmpeg `drawtext` at a hand-picked `x`, which is how a caption ended up in the
frame edge. On this build `tools/check-stills.mjs` decodes rendered frames and
measures every run of text pixels in the caption band: the widest line observed
reaches x ≈ 933 and the narrowest starts at x ≈ 148, both inside the 100…980
column.

## Verification

`node tools/verify-video.mjs` runs against the finished file:

- 1080×1920 · 30 fps · H.264 · AAC 48 kHz · 1807 frames · 60.23s
- decodes end to end with no errors
- caption bounds measured **in the encoded file**, not just in stills: the widest line reaches x ≈ 933 and the narrowest starts at x ≈ 148, both inside the 100…980 column
- `tools/make-clips.mjs` output is checked for exact frame counts, so no shot can fall short of its slot

## Files

- `rasoiqr-customer-flow-vertical-9x16.mp4` — the narrated vertical master (Reels / Shorts)
- `rasoiqr-customer-flow-vertical-9x16-whatsapp.mp4` — same cut at a shareable bitrate, for WhatsApp status
- `.freebuff/video/remotion/` — the source of the video (edit this, not the mp4); `out/preview.html` is a player page for review
- `rasoiqr-customer-flow-captioned.mp4` / `-clean.mp4` — older 16:9 silent cuts from the ffmpeg pipeline
- `voiceover.wav` — the narration as rendered

## Notes and limitations

- The narration is your recording; nothing was re-voiced, and no music bed was added (that needs a licensed track).
- Demo data appears in the capture: **Babu Mosai**, table 7, and test orders `20261015-001/002/003` in the live database.
- Caption wording follows the transcription, with the brand corrected to **RasoiQR** and the obvious mis-hearings fixed (`dinin` → `dine-in`, `tab` → `tap`, `pass` → `past`).
- Shot speeds run from 0.732× to 3.286× so every shot lands inside its narration slot.
- The 16:9 cuts are still silent; the same composition can be re-pointed at 1920×1080 if you want a narrated landscape version.
