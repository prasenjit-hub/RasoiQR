# Cart item edit — plan

Status: **shipped** 2026-10-16 — built exactly as specced (pencil cue + tappable info block, prefilled edit sheet, in-place replace, identity merge) and verified in the browser the same day: pencil only on configurable rows, edit prefilled the row's own Full + cheese (not the size default), save replaced in place (row count unchanged), an edited row merged into an identical line (qty summed), cancel left the row untouched, and the stepper still works next to the tap area. Not exercised: the >50 merge-refusal branch (needs a 49-qty row).
Scope: from **Your Crave-box** (the cart sheet), a customer can change an already-customized line
(size / add-ons / quantity) instead of deleting the row and building it again.

## 0. Short answers to the two owner questions

**Q1 — "maybe just an edit icon here is enough?"**
Icon-only has **no precedent** in the apps that were researched — the verified pattern is
**tap the row** (DoorDash and Uber Eats both document: tap the cart item → change its options →
"Update Cart"), and Zomato shows an **"Edit" text link** next to a cart item (partial evidence, §7).
Recommended: **small pencil icon as the cue + make the row's info area tappable**, both firing the
same handler. Icon-only still works but is the weakest option: tiny target, no behavioural precedent.

**Q2 — "or also: clicking a customizable item's card/row should open the edit sheet — should we add that too?"**
**Yes — that is the verified industry pattern.** One scope limit: the tap opens edit only on the
**info area** (thumbnail + text column), never across the stepper (− / N / +), which stays as is.

## 1. The actual gap

A cart row built from a configurable item has **only a ± stepper** ([CustomerMenu.tsx L455-527](../../src/pages/customer/CustomerMenu.tsx#L455-L527)).
To change Half → Full today the customer must remove the row (undo toast appears) and add the item
again from scratch — sizes, add-ons and quantity all re-done. That re-configuration step is the
same drop-off point the earlier cart research flagged; the cart is the natural place to fix it.

## 2. What already exists (do not rebuild)

| Piece | State | Where |
|---|---|---|
| Customizer sheet (sizes, add-ons, qty) | shipped | [ItemCustomizerContent.tsx](../../src/pages/customer/components/ItemCustomizerContent.tsx) |
| Default size preselected on fresh add | shipped 2026-10-16 (`getDefaultSize`) | [ItemCustomizerContent.tsx L13](../../src/pages/customer/components/ItemCustomizerContent.tsx#L13) |
| Cart identity + merge + 50-cap rule | shipped | `addToCart`, [CustomerMenu.tsx L147-189](../../src/pages/customer/CustomerMenu.tsx#L147-L189) |
| Undo toast for removals | shipped | `updateQuantity` / `undoRemoval`, [CustomerMenu.tsx L201+](../../src/pages/customer/CustomerMenu.tsx#L201) |
| Cart sheet + drag-dismiss | shipped | `cartDrag` [CustomerMenu.tsx L60-63](../../src/pages/customer/CustomerMenu.tsx#L60-L63) |
| Pencil-style icon | dependency already used | `Edit` in [restaurant/Menu.tsx L2](../../src/pages/restaurant/Menu.tsx#L2) (lucide-react) |

## 3. Affordance spec

| Row type | Affordance |
|---|---|
| **Customizable row** (item has `sizes` or `addons`) | small pencil icon in the meta line **+** the info block (thumbnail + text) is tappable — both call `openEdit(index)` |
| **Plain row** (e.g. Veg Burger) | nothing new — the stepper is the only control; there is nothing to configure |

Numbers (evidence in §7):

- icon visual ~16 px, **hit area ≥ 24 CSS px** (WCAG 2.5.8 AA minimum or its spacing exception); aim 40–44 px where the row allows (Apple 44 pt / Material 48 dp)
- **≥ 8 px clearance** from the stepper (Material: 48 dp targets with ≥ 8 dp gaps; Android warns that auto-expanding small targets can overlap neighbours)
- `aria-label="Edit <item name>"` on the button; icon itself decorative
- the icon sits **inside** the info block, so icon-tap and row-tap are literally the same handler — no two competing actions

## 4. Behaviour spec (save semantics)

1. **Open:** `editingIndex = index`; the sheet receives the cart row as `item` (CartItem extends
   MenuItem) plus `initialSelection = { size, addons, quantity }` from that row.
2. **Prefill:** `initialSelection` **wins over** the default-size seed — edit must open on the row's
   actual selection (Half + Extra cheese + qty 2), never on the fresh-add default. Fresh adds keep
   `getDefaultSize()` untouched. This split is the one real regression risk; it is explicit.
3. **Cancel** (X / drag-dismiss / backdrop) → row untouched, `editingIndex = null`.
4. **Save** (button reads **"Update Plate"** in edit mode):
   - rebuild the row with the same price math as `addToCart`
   - identity = item id + `selectedSize.name` + exact add-ons (the **same predicate** `addToCart`
     uses — extract it once so the two paths cannot drift)
   - if another row matches and `qty + other.qty ≤ MAX_ITEM_QUANTITY (50)` → merge into that row and
     remove the edited row
   - else replace in place
   - **no silent quantity loss**: merge only when it fits under the cap; otherwise the row stays separate
   - clear any pending undo toast (`setRemovedItem(null)`) so UNDO cannot restore into a shifted cart
5. **Quantity semantics:** in edit mode the sheet stepper **replaces** the row quantity; in add mode
   it still **adds** to a matching row (current behaviour). The button label carries the difference.
6. **Stacking:** the cart sheet stays open underneath (return-to-cart after save). The customizer
   sheet already paints above it — both are `z-50` and the customizer comes later in the DOM
   ([L438](../../src/pages/customer/CustomerMenu.tsx#L438) vs [L559](../../src/pages/customer/CustomerMenu.tsx#L559));
   verify pointer capture and the double backdrop in Phase 1 (this combination has never been
   exercised — the item sheet has so far only ever opened while the cart was closed).
7. Only rows whose **item** has sizes/add-ons get the affordance.

## 5. Files & interfaces (smallest set)

| File | Change |
|---|---|
| [CustomerMenu.tsx](../../src/pages/customer/CustomerMenu.tsx) | `editingIndex` state; `openEdit(index)`; `saveEditedCartItem(size, addons, qty)`; cart-row affordance; extract the shared identity predicate out of `addToCart` |
| [ItemCustomizerContent.tsx](../../src/pages/customer/components/ItemCustomizerContent.tsx) | optional `initialSelection` prop; optional `mode: "add" \| "edit"` for header/button text; seed = `initialSelection ?? default` |

No DB, no RPC, no service change — the cart is client state, and `customer_create_order` already
prices each line server-side with its own guards (quantity 1–50, 50-line cap).

## 6. Risks

| # | Risk | Handling |
|---|---|---|
| R1 | Mis-tap into the stepper on a 360 px screen | tap scoped to the info block; icon clearance ≥ 8 px; test at 360 px |
| R2 | Duplicate rows after edit | one shared identity predicate (§4.4) |
| R3 | Stale `editingIndex` if the cart mutates while the sheet is open | the sheet covers the UI; defensive `if (!cart[editingIndex])` bail |
| R4 | Edit prefill accidentally using the default size | §4.2 + acceptance test #2 |
| R5 | Two stacked sheets misbehave (backdrops, dismiss) | §4.6 acceptance check before Phase 2 |
| R6 | Undo toast restores into a shifted cart | §4.4 last bullet |
| R7 | Icon too small to be a real target | §3 numbers; verify with the browser's element size, not visually |

## 7. Evidence

| Claim | Source | Strength |
|---|---|---|
| Tap the cart row → change options → "Update Cart" | [wikiHow DoorDash guide](https://www.wikihow.tech/Use-DoorDash-on-Android) (updated 2025-06) | explicit steps (third-party) |
| Tap the item; swipe-left is delete, not edit | [Ridesharing Driver Uber Eats guide](https://www.ridesharingdriver.com/uber-eats-order-cancel-tip/) | explicit steps (third-party) |
| "Edit" text link beside a cart item | [Facebook post preview (Zomato cart)](https://www.facebook.com/groups/foodaholicsinahmedabad/posts/30086565074321581/) | partial — text indexed, image not inspectable |
| No pencil-icon precedent found in cart rows | Swiggy (Page Flows), Domino's case study, McDonald's app/FAQ | **could not verify** those apps' cart affordances |
| ≥ 24 CSS px targets (or spacing exception) | [W3C WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) · [2.5.5 AAA 44 px](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) | official |
| 44 pt hit region; spacing matters | [Apple HIG — Buttons/Accessibility](https://developer.apple.com/design/human-interface-guidelines/buttons) | official |
| 48 dp targets, ≥ 8 dp gaps; auto-expansion can overlap | [Material 3 structure](https://m3.material.io/foundations/designing/structure) · [Android a11y](https://support.google.com/accessibility/android/answer/7101858?hl=en) | official |

Note: the green check marks in the owner's screenshot are **not in the code** — `grep` for green
tokens in the cart sheet returns nothing (checked 2026-10-16 01:34). They are annotations on the
screenshot pointing at the two customizable rows.

## 8. Acceptance criteria (browser-testable, in order)

1. Customizable row shows the pencil; plain row does not.
2. Icon tap **and** info-block tap both open the sheet, prefilled exactly as the row (Half + Extra
   cheese + qty 2 → that is what shows, not the default Half-only).
3. Half → Full: row price and subtotal update; row count unchanged; no duplicate appears.
4. Two rows of one item (Half + Full): edit Full → Half → one merged Half row with summed quantity.
5. Merge respects the 50 cap; no quantity is lost.
6. Cancel (X and drag) → the row is unchanged.
7. Fresh-add regression: default-size preselect and add/merge behaviour unchanged.
8. Stepper unchanged; no mis-taps at 360 px width.
9. `npx tsc -b --noEmit` clean; no console errors in the preview.

## 9. Out of scope

Swipe gestures (delete-only in the apps researched, and undiscoverable) · editing from the checkout
sheet · owner-set default sizes (the `getDefaultSize` helper is the single place that would change) ·
making plain rows editable · any DB/migration work.

## 10. Verification plan

Build the 4-row scenario from the owner's screenshot at `/menu/demo-dhaba` — Chicken Chowmein Half
₹80, Cheese Pizza + Extra cheese, Veg Chowmein Half + Extra cheese ₹90, Veg Burger ₹100 (subtotal
₹500) — then run §8 top to bottom. Typecheck after each phase. DB checks (smoke-test /
migration drift) are not applicable — nothing server-side changes.
