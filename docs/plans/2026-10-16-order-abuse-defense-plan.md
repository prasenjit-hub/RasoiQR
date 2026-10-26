# Order abuse defense — plan (hard-cap-free)

Status: **P0 partially shipped 2026-10-16** (migration [042](../../database/migrations/042_order_burst_alert_only.sql): the restaurant-wide 5-minute burst is now **alert-only** and never refuses a guest) · L1/L2/L3/L4 still not built
Scope: how to protect the public, unauthenticated customer order path (`customer_create_order`, anon-callable) from spam/scripts **without** blunt per-phone / per-table caps that can refuse a real busy restaurant.

> **TL;DR (simple):** Right now we stop attackers by counting orders and refusing the 11th (phone) or 9th (table) from one identity; the whole-restaurant count is still measured but no longer refuses anything (042 made it alert-only). The research says the count is the wrong load-bearing control: a fixed number is a *guess* at "is this a real guest", and the cost of guessing wrong is a lost real order. Better: **prove where the order came from** (signed QR token), **make bots pay an invisible cost** (Turnstile / proof-of-work), **score behaviour instead of counting**, and **step up or queue instead of refusing**. Caps then become a last-resort circuit breaker, not the product limit.

---

## 0. Premise correction (before any decision is made on numbers)

The concern that started this plan was *"30 orders per hour is far too low"*. The live numbers are not what that sounds like:

| Limit | Where | Current value | Real-world meaning |
|---|---|---|---|
| Phone | one mobile number | 10 | per **hour** |
| Table | one table (dine-in only) | 8 | per **hour** |
| Burst | one **restaurant** | 30 | per **5 minutes** ≈ **360/hour** |

So the restaurant-wide brake is already **~360 orders/hour** — not 30/hour — and there is **no** per-restaurant hourly cap at all ([041](../../database/migrations/041_order_rate_limit_tuning.sql)). The genuinely debatable one is the **phone** cap (10/hour), because one phone can legitimately front a group/office order; and the **table** cap (8/hour) can be hit by a large party ordering in rounds. This plan therefore does not start by picking bigger numbers — it removes the *need* for the numbers to be tight.

> **⚠️ Correction (2026-10-16, after this plan was written):** the suggestion that 360/hour sits comfortably above any real venue is **wrong**, and is fixed in §1. Published high-throughput QSR data reaches **~29 transactions per 5 minutes at peak** — so the 30/5min brake has **no headroom** for such a venue — and because it is a *rolling 5-minute* window applied to a bursty workload, it can bind at ~**100–150 orders/hour**. The brake is therefore **not** a safe backstop as currently tuned; see §4.

## 1. Why fixed caps are the wrong load-bearing control (evidence)

| Finding | Source |
|---|---|
| The caps exist to answer *"is this a real guest?"*. A count is a proxy — it cannot tell a genuine rush from a script varying table + phone | design gap in 040/041 |
| **8 orders/table/hour = one order every 7.5 minutes**, which is *far* more frequent than normal table turnover (Toast: 3–4 turns/meal period fast-casual; 1–2 fine dining). It is safe for a normal party, but a large group, repeated QR rounds, or a group-order flow can legitimately reach it → should be a **review/step-up signal**, not an unconditional block | Toast table-turn guidance |
| **⚠️ CORRECTED 2026-10-16 — 30/5min (=360/hour, one order every 10s) is NOT safely above real peaks.** Chipotle's highest-throughput restaurants are reported at **>350 transactions in a lunch hour ≈ 29.2 per 5 min** — i.e. *at* the cap; one Chick-fil-A outlet reported **326 drive-thru cars in one hour** (91% of 360); a counter-service operator reports ~**80–100 orders/hour** across a 2.5h lunch. For a high-throughput venue this ceiling has **no safety margin** | [Chipotle >350/hr](https://operationsroom.wordpress.com/2012/08/30/making-fast-food-faster/), [Chick-fil-A drive-thru](https://www.chick-fil-a.com/press-room/drive-thru-behind-the-scenes), [Toast: Salted Melon lunch rush](https://pos.toasttab.com/ko-us/blog/data/rush-hour-diaries-salted-melon-charlotte) |
| **A 5-minute window on a bursty workload measures the wrong thing.** An hourly total hides the *shape*: a venue doing only **100–150 orders/hour** can still put **>30 into one 5-minute interval** when a lunch convoy arrives, so the brake can bind far below 360/hour | hourly-average vs 5-min-window mismatch |
| Major platforms do **not** publish a numeric guest-checkout cap. They use **signed/authenticated tokens**, and **fraud scoring on device, IP and payment history** (Toast runs automatic backend fraud checks on every online order; Square Risk Manager uses velocity rules) | Toast, Square, DoorDash, Uber Eats docs |
| One checkout is many API requests; **request-rate limits ≠ order limits**. Applying an API-style cap to the *completed order* conflates the two | Square / Olo guidance |
| Fixed caps have an **unmeasured false-positive rate** — no vendor publishes one, and shared venue Wi-Fi/NAT makes any IP-based rule unsafe | Cloudflare, AWS, OWASP |
| Kitchen overload is a **capacity** problem, solved by queueing and longer quoted ready-times, not by rejecting orders | Olo (throttle by orders per 15 min, prep-minutes, or in-progress count; queue + adjust lead time) |
| Physical presence cannot be proven by a **static** printed QR — it is a bearer token: anyone who photographs/forwards it can replay it | OWASP session/JWT guidance |

**Conclusion:** keep the caps only as a cheap, very high circuit breaker. Move the real work to proof-of-origin + invisible friction + behaviour scoring, and answer "the kitchen is drowning" with pacing, not with a block.

## 2. Target model — four layers

```
order submit
  │
  ├─ L1  proof of origin      signed per-table token (HMAC/JWT), rotatable, validated server-side
  ├─ L2  invisible bot cost   Turnstile (or self-hosted proof-of-work) verified in an Edge Function
  ├─ L3  behaviour score      session/device signals + this venue's own p95/p99 baseline  → risk tier
  └─ L4  graduated response   low risk → accept · medium → step up · high → queue/alert (never a silent block)
        +  kitchen pacing    prep-time / in-progress count → longer ETA, not a refusal
        +  039 idempotency   unchanged — a retry must always be able to succeed
```

### L1 — Proof of origin (signed QR token)
- Sign `restaurant_id + table_id + version` with a server-only key; validate on every submit and take the table from the **verified token**, never a client-sent `table_number`.
- **What it buys:** an attacker cannot invent a valid table, and bulk "generic" attacks (guessing ids / hitting the RPC directly) die. It also finally makes the table number trustworthy.
- **What it does NOT buy:** physical presence — a printed token can be copied/shared. Rotate a table's token when it leaks; keep it **stable and multi-use** (several diners, several rounds) and never give it a short expiry, or the printed standee stops working.
- **✅ Cost is ZERO right now (corrected 2026-10-17): nothing has been printed yet, and this app generates every QR itself.** The QR images/PDF come from [QRCodeManager.tsx](../../src/pages/restaurant/components/QRCodeManager.tsx) and [qrPdfService.ts](../../src/services/qrPdfService.ts), which build `${base}/menu/${slug}?table=${i}` on demand — there is no external printing pipeline and no standee in the field. So the URL can be changed **now** and every QR printed afterwards is protected from day one. This stops being free the moment the first restaurant prints a standee, because a printed QR is immutable.
- **Prefer a random per-table CODE over an HMAC token.** Both stop invention/enumeration, but an HMAC secret is all-or-nothing: rotating it revokes **every** standee at once. A random code can be rotated for **one** table (the leaked one) while the others keep working — and it needs no secret management. It also forces the table registry this app is missing anyway (see below), instead of encoding a table that does not exist as an entity.
- **✅ DONE (migration 045, 2026-10-17) — the registry plus the random per-table code, not an HMAC.** `restaurant_tables` holds one row per table (`label`, random 12-hex-char `code`, `is_active`, `rotated_at`); the QR is `/menu/<slug>?t=<code>`, and `customer_create_order`/`customer_call_waiter` resolve the code **server-side** and write the label the database holds — the client never names a table. `update_my_restaurant(p_table_count)` still owns the count and now syncs rows (raise = create, lower = **deactivate**, so raising it again revives the same codes with no reprint). Owner actions are `owner_rotate_table_code` (one table, every other standee untouched — the thing an HMAC cannot do) and `owner_set_table_active`. The old `?table=N` URL and the checkout's typed "Your Table Number" field are gone.
  - **Decision made with the code (2026-10-17): the Master QR is Takeaway only.** Dine-in requires a table's own code, so a restaurant with no declared tables takes takeaway orders only. That is fail-**closed** where 044 was fail-open, and it was chosen deliberately: a correct table is worth more than a lenient form, and every restaurant can print its table QRs from the app before launch.
  - **Still open here:** the code is a **bearer token** (a photo can be shared), so it stops invention/enumeration/garbage values and makes a leak revocable per table — it does not prove physical presence. That is L2/L3, unchanged. And **no per-table order cap came back** with it: the table is still shared by every guest at it, and the phone cap remains the only refusal.
- **No-reprint alternative:** issue a short-lived **anonymous session token** server-side when the menu page opens, require it on submit, and score how that session behaved (L3). Weaker than a signed table token but costs nothing physical.

### L2 — Invisible bot friction
- **Cloudflare Turnstile** — free plan is **unlimited challenges**, up to 20 widgets / 10 hostnames; token is single-use, 300s life, **must be verified server-side**. Real guests normally see nothing.
- **ALTCHA** (open-source proof-of-work, self-host, no vendor fee) if we prefer no third party or EU hosting; watch the 2025 replay advisory — use a patched library and enforce single-use + expiry.
- **Architecture constraint (important):** the provider secret can never live in browser code, so verification belongs in a **Supabase Edge Function** (Supabase documents exactly this Turnstile flow) — not in the anon-callable SQL RPC. The RPC stays the DB write path, called by the edge function after verification, with direct anon EXECUTE narrowed if we go all-in on that shape.
- **Candidate names / device fingerprinting** are explicitly *not* recommended as a substitute for auth (bypassable, privacy cost). A **honeypot field** is a free extra, but is weak against a script that knows about it.

### L3 — Behaviour score instead of a count
Score, don't cap. Signals that separate a real rush from automation (all computable in SQL against `orders`):

| Signal | Genuine busy venue | Suspicious |
|---|---|---|
| Velocity | many orders at **one** venue at its usual peak | volume far outside **that venue's own** pattern |
| Identity diversity | many distinct customers/sessions | **same phone at 3+ restaurants** in minutes; **one device selecting 4+ tables** |
| Journey/timing | menu/item activity before submit; plausible dwell | submit < ~2s after page open with **no** browse events |
| Business-data validity | a real, active table | a table id that doesn't exist for that venue |
| Inter-arrival | varied timing during a rush | many submits at near-identical short gaps |
| Reuse | different carts/items | identical payloads without an idempotency key |

Rules of engagement from the research: **IP is weak evidence** (venue Wi-Fi/NAT covers a whole restaurant); never block on diversity alone; treat p99 exceedance as *context*, not fraud; combine signals, and prefer step-up over rejection. Privacy: store a **hashed** phone for scoring, not raw, in analytics.

### L4 — Graduated response + kitchen pacing
- Uncertain → **low-friction step-up** (re-run the challenge, or ask for a quick confirm), not a refusal.
- Overwhelmed kitchen → **queue + longer ETA** (Olo model: throttle by orders per window, prep-minutes, or in-progress count). The guest is told *"ready by X"*, not *"you can't order"*.
- Hard block is reserved for a **circuit breaker** far above any plausible venue.

## 3. Rollout: shadow mode first (no guest ever affected)

1. **Instrument** (no enforcement): record per submission a session id, device id, hashed phone, submit-time minus page-open, and the score/rules that *would* have fired. Store the decision, not just the order.
2. **Baseline**: build complete aligned 5-minute bins **including zero-count bins** (otherwise percentiles skew high) for ≥ 4–8 weeks, per venue, keyed by local weekday + hour. Compare a live window to **that venue's own** p95/p99 (`percentile_cont`).
3. **Label a sample** — a random mix of *flagged and unflagged* orders, judged by staff/support as `legitimate` / `abusive` / `unknown`. Compute **false-positive rate = flagged ÷ labelled-legitimate** and also abuse recall, by venue and by rush period.
4. **Only then enforce** — and start with step-up, not block. AWS (Count mode) and Google (observe scores before acting) both describe exactly this pattern. Re-tune when traffic changes.

## 4. How the numbers get decided (not by judgement)
- The current three constants were chosen by judgement; this plan replaces the *mechanism*, and any surviving threshold is set from **our own logs' per-venue p99**, not from a published number (the research found **no** credible public peak orders/hour-per-restaurant dataset).
- Standing recommendation while L1–L3 are not built: **phone 10/hour is the only one worth relaxing**, and only into a step-up (e.g. an easy confirm) rather than a hard refusal; table 8/hour is fine for normal parties but should also degrade to a soft signal.
- **Restaurant-wide burst brake (revised 2026-10-16):** as tuned (30/5min) it has no headroom for a high-throughput venue, and it is the one cap an attacker can *pull* to refuse **real guests** — 30 cheap orders are enough to keep every genuine guest refused for the rest of the rolling window (it is a **denial-of-service lever**, not just a false-positive risk). Until behaviour scoring exists, either raise the ceiling far above plausible peaks (**~100+/5min**) and make a trip an **alert**, or run it **alert-only** during the pilot. Phone and table caps are per-identity — but **only the phone cap is genuinely self-harming.** The **table** cap is a *shared* identity (every guest at that table) *and* client-supplied (the table QR carries `?table=N`, and the Master QR lets a guest type the number), so 8 orders can lock a **real** table, and a large party ordering on separate phones can reach it legitimately. A script just varies the table, so this cap barely stops a script while it can refuse real guests — the fix is a signed per-table token (L1) + per-session scoring (L3), not a bigger number.
  - **✅ DONE (migration 042, 2026-10-16):** shipped **alert-only**. The 5-minute count still runs and crossing it raises a Postgres `WARNING` plus one deduplicated `notifications` row (`type = 'order_burst'`); a guest is **never** refused. Verified live: 35 orders in 13 s from 35 distinct phones/tables → **35/35 accepted, 0 refusals, 0 HTTP 429, exactly 1 alert row**. ⚠️ Consequence, deliberate: **nothing now stops a script that varies both phone and table** — the remaining caps are per-identity and trivially varied. That gap is exactly what L2 closes, which makes L2 the next real work rather than an enhancement.

## 5. Phased plan

| Phase | Work | Effort | Risk | Guest impact |
|---|---|---|---|---|
| **P0** | Turnstile (or self-hosted PoW) verified in a Supabase Edge Function; RPC called after verification | Medium | Low | none (invisible) |
| **P0** | ~~Turn the table (and phone) caps into **soft signals** once P0 friction is live; keep one high burst breaker~~ — **partially done the other way round:** 042 made the restaurant-wide burst **alert-only** immediately (it never refuses a guest now). Phone/table stay enforcing, because the per-identity caps are not what causes false blocks and L2 does not exist yet | Low | Low | *reduces* false blocks |
| **P1** | Anonymous session token (server-issued, no reprint) + scoring fields persisted for shadow mode | Medium | Low | none |
| **P1** | ~~Signed per-table QR token~~ — **✅ DONE (045) as a random per-table code + registry**, no dual-mode needed (nothing had been printed, so the URL shape was free) | Medium | Medium (print dependency) | none for new prints |
| **P2** | Per-venue p95/p99 baseline, labelled sample, FP measurement, then enable graduated enforcement | Medium–High | Medium (needs labels) | none |
| **P2** | Kitchen capacity pacing (queue + adaptive ETA) replacing the burst brake as the "busy" story | High | Medium | better UX (honest ETA) |

## 6. Keep / change / stop

| | Item | Verdict |
|---|---|---|
| ✅ Keep | 039 idempotency (retry returns the same order) | pure win — a retry must never be refused |
| ✅ Keep | invalid-table, invalid/unavailable item, price recompute, dine-in guard, trial guards | unrelated to abuse, all cheap |
| ✅ Keep | `cancelled`/`rejected` not counting toward a quota | correct |
| ✅ Done | **table cap removed entirely** (043) — it refused large parties and could be used to lock a real table, while barely touching a script | removes one of the two remaining false-block paths |
| 🔁 Change | **phone cap** → **soft/step-up** once L2 is live | removes the only remaining refusal |
| 🔁 Change | burst brake 30/5min → stays, but re-framed as a **circuit breaker**, not a throughput cap | it is already ≈360/hour |
| ⛔ Don't add | per-restaurant **hourly** hard cap | no defensible universal number; blocks a busy venue instead of an attacker |
| ⛔ Don't add | counting retries against the quota | punishes exactly the guest whose reply was lost (the 039 case) |
| ⛔ Don't add | IP-based guest limits, device fingerprinting | whole venue sits behind one NAT; bypassable, privacy cost |

## 7. Open questions for the owner
1. ~~Is **reprinting QR standees** acceptable, or is no-reprint required?~~ **Answered 2026-10-17: nothing has been printed yet** — the app is still being built, so there is no reprint cost and the strongest L1 is available for free. Decide the QR URL shape **before the first standee is printed**; after that it becomes a reprint rollout across every restaurant.
2. Third-party (Cloudflare Turnstile, free) or self-hosted (ALTCHA) for the PoW?
3. Do we have **staff who can label** a sample of orders during the shadow period? Without labels the FP rate cannot be measured honestly.
4. Is queueing / adaptive ETA acceptable to the restaurants, or does the kitchen want a hard stop at some point?

## 8. Success criteria
- Zero legitimate orders **refused** during a measured pilot; every "busy" outcome is a queue/ETA, not a rejection.
- A **measured** false-positive rate exists (with sample size), not a guess.
- Simulated floods (script varying table + phone) are stopped or paced without touching real guests.
- A retry after a lost response still succeeds (039 preserved).

## 9. What could not be verified (honest limits)
- No comparable **published false-positive rates** for Turnstile / hCaptcha / ALTCHA — any number is ours to measure.
- No credible public **peak orders/hour per restaurant** dataset; table-turn benchmarks are occupancy cycles, not order submissions.
- Platforms' **consumer** checkout defenses (exact thresholds, CAPTCHA triggers, fraud models) are not publicly documented — only partner-API limits are.
- Whether a static signed QR actually reduces abuse **in our traffic** is unproven; it must be measured after P1.

## 10. Sources
Cloudflare WAF rate-limiting best practices · Cloudflare Turnstile (plans, server-side validation) · Cloudflare bot scores · AWS WAF Bot Control (test/tune, false positives) · Google reCAPTCHA Enterprise (interpret assessment, OAT best practices) · Stripe Radar (risk-tiered action) · OWASP Automated Threats (OAT-005, OAT-021) + Bot Management & Anti-Automation Cheat Sheet + Session/JWT/REST cheat sheets · ALTCHA docs + security advisory GHSA-6gvq-jcmp-8959 · Anubis · mCaptcha · Friendly Captcha v2 · hCaptcha docs/plans · Supabase Edge Functions (Turnstile example, secrets, securing your API) · Toast (table turns, API rate limits, online-order fraud) · Square (QR ordering, Risk Manager, error handling) · Shift4 quickstart · DoorDash (JWT auth, API limits, group orders) · Uber Eats (Marketplace auth, large-group orders) · ChowNow privacy/fraud pages · Olo order throttling strategies · National Restaurant Association 2025 off-premises share.
