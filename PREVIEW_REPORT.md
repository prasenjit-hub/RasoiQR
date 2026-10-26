# RasoiQR — Local Preview Run Report

**Date:** 5 Oct 2026
**Repo:** github.com/prasenjit-hub/RasoiQR (branch `main`, HEAD `c9a4a2a`)
**Scope:** Clone → study codebase → run in preview → verify. **No source code was modified.**

---

## 1. Summary

The project was cloned, its architecture documented, and the app is running locally at
`http://localhost:3000` (Vite dev server), connected to the production Supabase backend
using the public anon credentials. The full customer ordering flow was exercised in the
preview and works correctly.

## 2. Project at a glance

- **Stack:** React 19 + Vite 7 + TypeScript 5.9 + Tailwind CSS 3.4
- **Backend:** Supabase (Postgres + Auth + Realtime + RLS). No custom API server —
  all data access goes through SECURITY DEFINER RPCs (`get_restaurant_by_slug`,
  `get_menu_for_restaurant`, `customer_create_order`, …)
- **Routing:** `react-router-dom` v7, SPA — all routes in `src/App.tsx`
- **State:** React local state + one `AuthContext` (no Redux/Zustand)
- **Customer UI — one file:** `src/pages/customer/CustomerMenu.tsx` (1234 lines)
  - Restaurant header — L306 · Item cards — L383 · Floating cart bar — L692
  - `ItemCustomizerContent` (sizes/add-ons) — L734 · `CheckoutContent` — L962

## 3. How to run

```bash
npm install
npm run dev     # Vite on port 3000
```

Requires gitignored `.env`:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...    # public anon key; safe in browser, RLS enforces security
VITE_DEMO_MODE=false
VITE_CLOUDINARY_CLOUD_NAME=dcnkg4pob
```

## 4. Verification results

| Check | Result |
|---|---|
| Landing page, `/login`, `/admin/login`, `/register` | ✅ render correctly |
| Supabase connectivity | ✅ RPCs return 200 |
| `/menu/babu-mosai` | ✅ real data — Babu Mosai, 6 categories, 6 items, Cloudinary images |
| Customize modal (Half ₹80 / Full ₹100 + add-ons +₹10) | ✅ live total ₹110, correct |
| Add to cart → floating cart bar → cart drawer | ✅ ₹110 total, modifiers shown |
| Checkout form (Dine-in/Takeaway, details, finances summary) | ✅ renders, total ₹110 |
| Browser console errors | ✅ none |
| `git diff` | ✅ empty — zero code changes |

## 5. Notes & limitations

- Preview connects to the **production** Supabase. "Place Order" was **not** clicked —
  it would insert a real order. Full order test needs a staging DB first.
- Restaurant header values (★ 4.9, 100+ Ratings, 15-20 mins, banner image) are
  **hardcoded** in `CustomerMenu.tsx`, not from the database.
- README demo credentials (`demorestaurant@gmail.com`, `/demo-restaurant`) are
  outdated against the current DB.
- Cart state is in-memory only — lost on page refresh.
- `npm audit`: 19 vulnerabilities (left untouched per "no changes" request).

## 6. Suggested next steps

1. **Staging Supabase project** — safe environment to test the full Place Order flow.
2. **Split `CustomerMenu.tsx`** into components (Header, ItemCard, Customizer, CartBar)
   before making UI changes.
3. **Data-driven header** — add rating / ETA / banner fields to the DB.
4. **E2E tests** (Playwright) for the customer ordering flow.
