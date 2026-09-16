# SharpAI — Master Architecture Document

**Version:** 1.0 (draft for D-192-A)
**Authors:** Claude (CTO) under CEO §19.3 authorization
**Source documents:** BetGenius_Framework.md v2.42, CLAUDE.md, existing migrations + edge functions + src/ tree
**Target launch:** Aug 1, 2026 — NBA + MLB, NFL if ready, NHL deferred
**Status:** SPEC ONLY — no code shipped from this document. Step B (loop framework) will execute against this spec.

---

## How to read this document

Each section is the canonical answer for one architectural surface. Subsequent loop tasks reference these sections by anchor (e.g. "build per §2.3.5"). When a section conflicts with current code, the section wins for FUTURE work; existing code is updated atomically with the next ship touching that surface per Cardinal Rule §1.12.

Six dependencies thread through every section:

1. **Cardinal Rules §1.1-1.17** from framework v2.42 are non-negotiable for any code generated against this spec.
2. **Subscriber trust is the load-bearing product surface.** Every choice in §1, §4, §8, §10, §12 is graded by "does this preserve trust on first contact?"
3. **70%+ win rate is the public commitment.** §4 + §12 + §8 are written so the algorithm and surface reinforce that promise truthfully.
4. **Calibration is the closed feedback loop.** D-118 calibration_snapshots is the measurement instrument — every algorithm change ships with the §1.12 verification and the calibration delta must be inspected before any subscriber-facing weight update.
5. **Multi-sport launch needs per-sport functions sharing `_shared/`.** D-097 strategy locked. NBA stays canonical; MLB rebuild required per §15.1; NFL/NHL plug into the same pattern.
6. **Real-money cohort drift is real.** D-118/D-119/D-123 showed synthetic ≠ organic ≠ rescored ≠ live-engine. §4.11 forbids treating them as one number.

---

## §1 — Product surfaces (UI/UX)

Every subscriber-visible screen. Text wireframes. Mobile responsiveness is non-optional; all wireframes assume Tailwind responsive breakpoints with one-column mobile layout collapsing into two-column or three-column desktop.

### §1.1 Landing page (pre-signup) — `/`

Unauthenticated. Marketing surface. Goal: convert visitor → trial signup in ≤ 2 minutes.

**Dual-phase posture per §14 Q7 (D-196, 2026-05-17):** the landing page renders different copy during the Aug 1 – Sept 30, 2026 closed-beta window vs the Oct 1, 2026+ public-launch window. The marketing surface is the same component; the CTA + subscriber-count strip swap based on a server-side `launch_phase` flag.

```
┌──────────────────────────────────────────────────────────────┐
│  [SharpAI logo]                          Sign in   Get access │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│   Sharp algorithmic edge.                                      │
│   On every player prop, every game.                            │
│                                                                │
│   [ Last 30 days: 67% WR · +12.4 units · 489 picks settled ]  │
│   [ Hit rate refresh: live · last update: 14m ago ]            │
│                                                                │
│  --- CLOSED BETA WINDOW (Aug 1 – Sept 30, 2026) -------------- │
│   Public launch October 2026 — closed beta access by invite.   │
│   [ Join the waitlist → ]                                      │
│                                                                │
│  --- PUBLIC LAUNCH WINDOW (Oct 1, 2026 onward) ----------------│
│   [ Start your 7-day free trial → ]                            │
│                                                                │
├──────────────────────────────────────────────────────────────┤
│ How it works                                                   │
│   ① 22-factor algorithm scores every prop 0–100                │
│   ② AI cross-checks injuries, lineups, line moves              │
│   ③ Only 70+ confidence picks reach your dashboard             │
├──────────────────────────────────────────────────────────────┤
│ Live calibration  [chart: confidence tier vs real hit rate]    │
│  --- Closed-beta strip ---                                     │
│  Closed beta: 38 / 50 invite seats filled                      │
│  --- Public-launch strip ---                                   │
│  Public launch: 78 subscribers and growing                     │
├──────────────────────────────────────────────────────────────┤
│ "Not financial or betting advice. SharpAI is an AI sports     │
│  analytics + projections platform. 18+. US + Canada."          │
└──────────────────────────────────────────────────────────────┘
```

**Beta-invitation landing variant** lives at `/beta-access?invite=<code>`. Same outer chrome, but the hero CTA becomes "Activate your beta invite → $49/mo locked through Apr 1, 2027" and the subscriber-count strip reads "Closed beta invite code accepted — N seats remaining." Invalid or expired codes redirect to the public landing page with a waitlist CTA.

Hard rules for the landing page:
- The hero hit-rate number is **always** sourced from `calibration_snapshots` (D-118) rolling-30d organic window. Never hardcoded. If `calibration_snapshots` returns no rolling window, the hero falls back to "Live calibration loading…" — never a placeholder number.
- The chart in "Live calibration" is real data, generated server-side, refreshed every 4h.
- "US + Canada" reflects the §9.3 broad-state launch posture. Geo-IP capture continues server-side for analytics; no state-based access blocks at v1.
- Disclaimer is fixed-position on mobile, footer on desktop. Never collapsed behind a click-to-expand.
- The dual-phase CTA swap is driven by a single server-side `launch_phase` config value ∈ {`closed_beta`, `public_launch`}. CEO flips the flag on 2026-10-01 to switch the public-facing page from waitlist-only to free-trial CTA. Beta cohort retains access via `/beta-access?invite=<code>` regardless of public-phase flag.

### §1.2 Signup — `/signup`

Single-page magic-link flow. No passwords ever.

```
┌──────────────────────────────────────────────────────────────┐
│ Create your SharpAI account                                    │
├──────────────────────────────────────────────────────────────┤
│  Email: [ ___________________________ ]                        │
│  [ ] I confirm I'm 21+ and located in [auto-detected state]    │
│  [ ] I agree to the Terms of Service and Privacy Policy        │
│  [ Send magic link → ]                                         │
├──────────────────────────────────────────────────────────────┤
│  Or:  [ Continue with Google ]   (Phase 2)                     │
└──────────────────────────────────────────────────────────────┘
```

After click:
```
┌──────────────────────────────────────────────────────────────┐
│  Check your email at name@example.com                          │
│  We sent a sign-in link. Open it on this device.               │
│  Didn't get it? [ Resend ] (cooldown 60s)                      │
│                                                                │
│  Wrong email? [ Use a different one ]                          │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- `referral_code` query parameter persisted into session for attribution on signup row insert.
- Geo-IP gate enforced server-side at OTP request: blocked states return a 4xx with "Not available in your region" copy.
- During the closed-beta window (Aug 1 – Sept 30, 2026, 50-invite cap per §14 Q7 / D-196), signup via `/beta-access?invite=<code>` auto-grants `promotional_grants.closed_beta_aug2026` (see §11.1). Tracked via a row insert before subscription creation. Public-launch signups (Oct 1, 2026+) follow the standard 7-day trial flow with no promotional grant.
- TOS + Privacy must be checked. Both ToS version + acceptance timestamp are stored in `user_preferences.tos_accepted_version` and `.tos_accepted_at` (§2.5).

### §1.3 Login — `/login`

Same magic-link form. Distinguishes returning user from new signup by presence in `auth.users`. Allowlist-gated post-auth only for the legacy beta period; after Aug 1 launch, allowlist is replaced by Stripe subscription state.

### §1.4 Dashboard — `/dashboard`

The main subscriber surface. Shows today's picks.

```
┌──────────────────────────────────────────────────────────────┐
│ Today's picks   [NBA ▼] [MLB] [NFL]    [Date: Today ▼]         │
│                                                                │
│ Filters: Min conf ▢60 ◉70 ▢80 ▢90  |  Prop: All ▼            │
│ Show: ◉ Primary only  ▢ All markets                            │
├──────────────────────────────────────────────────────────────┤
│ [ Pick card 1 ]                                                │
│   ⭐ ELITE 92 · D. Mitchell · Points 25.5 · OVER · -110         │
│   📊 Projection 28.1  · EV +$8.20 · Kelly $50 (capped)         │
│   🏠 Hard Rock -110  · Best: FanDuel -105                       │
│   Key factors: L5 hit rate 100% · Season 68% · Pace +3pp        │
│   [ Tap to expand factor breakdown · AI analysis · history ]    │
│                                                                │
│ [ Pick card 2 ]  ... (sorted by confidence desc)               │
│                                                                │
│ Showing 12 of 47 picks today (35 hidden below 70 threshold)    │
│ [ Show all 47 picks ]                                          │
├──────────────────────────────────────────────────────────────┤
│ Live calibration: rolling-30d 70+ tier WR 67.2%  ✓ on target   │
└──────────────────────────────────────────────────────────────┘
```

Hard rules:
- Sport switcher is a single tab row, not a separate page. Switching reloads picks for that sport's `recommendations_cache` rows.
- Default filter is "70+ Primary only." D-165 `is_secondary_market` filter on by default.
- Each pick card shows the top 5-6 metrics defined in §12. No more, no less.
- "Key factors" line is the top-3 absolute-value factors from `pick_history.factors` JSONB, human-translated via `FACTOR_LABELS` (D-150) plus D-164/165/166/167 flag chips when fired.
- The bottom calibration banner is the public commitment surface — always visible, always live. If the rolling-30d 70+ tier WR drops below 65%, the banner switches to amber and reads "Calibration drift detected — investigating." See §8.5.
- "Show all 47 picks" reveals 60-69 tier and lower, with explicit warning copy: "Below 70 confidence — informational only, not recommended bets."

### §1.5 Pick detail view — `/dashboard?pick=<id>` (modal)

Expanding a pick card opens a full-page view (desktop) or full-screen modal (mobile).

```
┌──────────────────────────────────────────────────────────────┐
│ D. Mitchell · Points 25.5 · OVER · CLE @ NYK · 7:30pm ET       │
│ Confidence 92 (ELITE) · Quarter Kelly: $50 (5% cap binding)    │
├──────────────────────────────────────────────────────────────┤
│ Why this pick                                                  │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ AI analysis (Sonnet 4.6, cross-checked vs algorithm)     │  │
│ │ "Mitchell has hit 25.5 in 8 of his last 10. He's        │  │
│ │  averaging 28.4 over the last 5 against bottom-third     │  │
│ │  defenses, and NYK ranks 28th in points allowed to       │  │
│ │  guards. The line has moved from 24.5 to 25.5 this       │  │
│ │  afternoon — sharps are on the over."                    │  │
│ │ Verdict alignment: AI says TAKE, algorithm says ELITE ✓  │  │
│ └──────────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│ Factor breakdown (collapsed by default)                        │
│   [+]  L5 hit rate              +15   100% (5/5)               │
│   [+]  Season hit rate          +10   68% (28/41)              │
│   [+]  Floor analysis           +12   floor 22 > line 25.5     │
│   [+]  Recent form              +5    +9% L5 vs season         │
│   ...                                                          │
│   [+]  trivial_line_penalty     -3    25.5 line clusters near 25│
├──────────────────────────────────────────────────────────────┤
│ Line shopping                                                  │
│   ✓ Hard Rock      -110   (your default)                       │
│     FanDuel        -105   ⭐ best price                         │
│     DraftKings     -110                                        │
│     [ Edit your books in Settings → ]                          │
├──────────────────────────────────────────────────────────────┤
│ Similar picks history (CONFIDENTIAL — subscriber-only)         │
│ Last 30 picks for D. Mitchell points overs at 80+ conf: 21W-9L │
├──────────────────────────────────────────────────────────────┤
│ [ Log this bet → ]    [ Add to parlay (Phase 2) ]              │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- Factor breakdown is collapsed by default — expanding logs an event to `analytics_events` (§2.7) for retention measurement.
- Line shopping section honors the subscriber's books selection from Settings (D-026, hydrated via D-029+).
- "Similar picks history" pulls from `pick_history` JOINed on `(player_name, prop_type)` — 30-day rolling window. If <10 picks in that window, the section reads "Not enough history yet."
- "Log this bet" pre-fills the Tracker form with player, prop, line, side, odds.

### §1.6 Evaluator — `/evaluator`

Custom-prop scoring tool. Subscriber types a player + prop + line and gets the algorithm's score, even if no book has posted the prop today.

```
┌──────────────────────────────────────────────────────────────┐
│ Evaluator                                                      │
├──────────────────────────────────────────────────────────────┤
│ Sport: [NBA ▼]                                                 │
│ Player: [ D. Mitchell ___________________ ]   (autocomplete)   │
│ Prop:   [ Points ▼ ]                                           │
│ Line:   [ 25.5 ]                                               │
│ Side:   ◉ Over  ▢ Under                                        │
│ Odds:   [ -110 ]   (optional — defaults to -110)               │
│ [ Score this prop → ]                                          │
├──────────────────────────────────────────────────────────────┤
│ Result:  Confidence 87 · STRONG PICK                           │
│ Source:  ✓ exact cache hit  /  ≈ fuzzy ±0.5  /  ⚡ live fetch   │
│                                                                │
│ Factor breakdown: [same expansion UI as Pick detail]           │
│ Recommendation: bet · Quarter Kelly $35                        │
│ [ Log this bet → ]                                             │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- Cache-first read per D-179 (analyze-pick cache-first read). Cache → fuzzy ±0.5 → live fetch fall-through.
- Live fetch uses analyze-pick edge function which post-D-155 imports `_shared/scoring.ts` — identical math to Dashboard.
- Three-state source caption is permanent — subscribers know which mode they got.

### §1.7 Performance — `/performance`

Subscriber's view into algorithm performance, calibration, and (optionally) their own bet results.

```
┌──────────────────────────────────────────────────────────────┐
│ Performance                       [Window: 7d 30d 90d All]    │
├──────────────────────────────────────────────────────────────┤
│ Headline                                                       │
│   Algorithm rolling-30d:  67.2% WR  ·  +14.8 units  ·  n=189   │
│   Your real-money rolling-30d:  61.5% WR · +6.2u · n=78        │
│   [these read calibration_snapshots + bets ⨝ pick_history]     │
├──────────────────────────────────────────────────────────────┤
│ Calibration by tier (D-118 calibration_snapshots)              │
│   ┌────────────────────────────────────────────┐              │
│   │ Tier   Backtest  Real-30d  Δ      n         │              │
│   │  90+   70.0%     71.8%    +1.8   142        │              │
│   │  80-89 59.5%     58.9%    -0.6   210        │              │
│   │  70-79 56.0%     56.8%    +0.8   473        │              │
│   │  60-69 55.5%     54.1%    -1.4   853        │              │
│   └────────────────────────────────────────────┘              │
│   ✓ All tiers within ±2pp of backtest baseline                 │
├──────────────────────────────────────────────────────────────┤
│ Equity curve  [chart of cumulative units, algorithm vs real]   │
├──────────────────────────────────────────────────────────────┤
│ WR by prop type    | WR by sport        | WR by day-of-week    │
│ Points  61.2%      | NBA  67.2%         | Mon  64%             │
│ Rebounds 58.4%     | MLB  ⏳ (data)     | Tue  71%             │
│ Assists 54.9%      |                    | ...                  │
├──────────────────────────────────────────────────────────────┤
│ Sanity checks (D-167 stack-vs-non-stack, D-164/165/166 flags)  │
│   coin_flip flagged today: 3 picks                             │
│   negative_stacking ≥3 today: 1 pick                           │
│   unbettable_juice today: 0 picks                              │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- Headline numbers read calibration reference #4 (real organic post-megadeploy) as the canonical subscriber-facing number per D-134. The backtest column is a labeled secondary reference, never headline-level.
- The calibration table colorizes Δ: green |Δ|<2pp, amber 2-5pp, red >5pp. Red triggers the §8.5 calibration-drift alert.
- "Your real-money" line only appears when the subscriber has logged ≥10 real bets in the window. Below that, the row hides and a one-line CTA appears: "Log your real-money bets in Tracker to see your personal performance."
- Sanity checks section surfaces D-164/165/166/167 flag counts as the §15.10-critical subscriber-trust transparency surface — "the algorithm doesn't hide its own weak picks."

### §1.8 Tracker — `/tracker`

Subscriber logs real-money bets. SharpAI does NOT place bets; subscribers track on their own.

```
┌──────────────────────────────────────────────────────────────┐
│ Log a bet                                                      │
│ Player [ ___ ]  Prop [ Points ▼ ]  Line [ 25.5 ]               │
│ Side ◉ Over ▢ Under  Odds [ -110 ]  Stake $ [ 50 ]             │
│ Book [ Hard Rock ▼ ]  Date [ today ▼ ]                          │
│ [ Log bet ]                                                    │
├──────────────────────────────────────────────────────────────┤
│ Bet history                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ Date  | Pick                  | Stake | Result | P/L    │  │
│  │ 5/15  | Mitchell pts 25.5 O   | $50   | W 28   | +$45   │  │
│  │ 5/15  | Edwards reb 6.5 U     | $25   | L 8    | -$25   │  │
│  │ 5/14  | Curry threes 4.5 O    | $50   | W 6    | +$45   │  │
│  └────────────────────────────────────────────────────────┘  │
│  Settled by: resolve-picks cron · Pending: 2 bets              │
│  [ Export CSV ]   [ Filters: sport · book · status · date ]    │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- `bets.pick_id` auto-populates via the AFTER INSERT trigger (D-021) using natural-key match against `pick_history`. Manual bets that don't match an algorithm pick (subscriber's own selection) leave `pick_id` null — these surface separately as "Off-algorithm bets" in filters.
- `bets.user_id` populated via D-025 trigger from session JWT.
- `resolve-picks` cron settles bets twice daily (10:00 AM, 12:30 AM ET). Settlement reads `pick_history.actual_value` and writes `bets.result`, `bets.payout`, `bets.settled_at`.
- Export CSV downloads the subscriber's own bets only — RLS enforces.

### §1.9 Settings — `/settings`

```
┌──────────────────────────────────────────────────────────────┐
│ Settings                                                       │
├──────────────────────────────────────────────────────────────┤
│ Account                                                        │
│   Email:  name@example.com                                     │
│   [ Change email → ] [ Sign out ]                              │
├──────────────────────────────────────────────────────────────┤
│ Subscription                                                   │
│   Plan: Pro · $99/mo · renews 2026-06-15                       │
│   Status: Active   [ Manage subscription → Stripe portal ]     │
├──────────────────────────────────────────────────────────────┤
│ Default sport: ◉ NBA  ▢ MLB  ▢ NFL                             │
├──────────────────────────────────────────────────────────────┤
│ My books (line shopping defaults)                              │
│   ✓ Hard Rock  ✓ FanDuel  ▢ DraftKings  ▢ MGM  ...             │
├──────────────────────────────────────────────────────────────┤
│ Kelly aggressiveness                                           │
│   ◉ Quarter (default — safe)                                   │
│   ▢ Half (moderate)                                            │
│   ▢ Full (aggressive — assumes perfect calibration)            │
│   Bankroll: $ [ 1000 ]                                         │
├──────────────────────────────────────────────────────────────┤
│ Notifications                                                  │
│   ▢ Email me when 80+ picks land  (Phase 2)                    │
│   ▢ Daily morning digest                                       │
│   ▢ Push notifications (mobile, Phase 2)                       │
├──────────────────────────────────────────────────────────────┤
│ Data & privacy                                                 │
│   [ Export my data (CSV/JSON) ]                                │
│   [ Delete my account ] (irreversible)                         │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- All preferences persist to `user_preferences` server-side (D-026 + Apr 29 RLS) AND mirror to localStorage for offline read. Hydration on sign-in via `hydrateUserPreferences` (App.tsx:68).
- "Manage subscription" opens Stripe Customer Portal (§6.4).
- "Delete my account" opens the deletion flow (§7.6).
- Email change flows through Supabase Auth's email-update flow (verification email to new address).

### §1.10 Subscription management

Stripe-hosted. SharpAI never sees card data. See §6 for full Stripe flow. The Settings page's "Manage subscription" CTA opens a Stripe Customer Portal session created server-side per subscriber.

### §1.11 Account / GDPR-CCPA — `/account/export` and `/account/delete`

Hidden routes accessed from Settings.

**Export** (`/account/export`):
- Triggers a Vercel function that queries the subscriber's rows across: `auth.users`, `user_preferences`, `bets`, `pick_history` (read-only — algorithm output, not personal data), `subscriptions`, `referrals_made`, `referrals_received`.
- Bundles as a ZIP of CSVs + a `manifest.json` describing the dataset.
- Delivered as a signed S3/Supabase Storage URL via email; URL expires after 7 days.
- Logs `analytics_events { event: 'data_export_requested', user_id }`.

**Delete** (`/account/delete`):
- Confirmation modal: "This deletes your account and all data. Continue?"
- Soft-delete first: row insert into `account_deletion_requests` with `requested_at`, `scheduled_for = NOW() + INTERVAL '30 days'`. Subscription auto-canceled at period-end (no further charges).
- After 30 days, a daily cron `process-deletion-requests` hard-deletes: `auth.users` row → cascades to `user_preferences`, `bets`, `subscriptions`, `referrals_made/received`. `pick_history` preserved (algorithm output, not personal). Confirmation email sent post-deletion.
- Subscriber can cancel deletion during the 30-day window via a one-click email link.

### §1.12 Support / FAQ — `/support`

Static markdown rendered server-side. No live chat in v1.

```
┌──────────────────────────────────────────────────────────────┐
│ Support & FAQ                                                  │
├──────────────────────────────────────────────────────────────┤
│ Common questions                                               │
│   • What does the confidence score mean?                       │
│   • How is the algorithm validated?                            │
│   • Why didn't I get an alert today?                           │
│   • How do I cancel my subscription?                           │
│   • What sports are supported?                                  │
│   ...                                                          │
├──────────────────────────────────────────────────────────────┤
│ Contact                                                        │
│   Email: support@sharpai.app                                   │
│   Response time: <24h business days                            │
└──────────────────────────────────────────────────────────────┘
```

### §1.13 Affiliate / referral dashboard — `/refer`

```
┌──────────────────────────────────────────────────────────────┐
│ Refer a friend                                                 │
├──────────────────────────────────────────────────────────────┤
│ Your code:  SHARP-XYZ4P                                        │
│ Your link:  https://sharpai.app/?ref=SHARP-XYZ4P  [ Copy ]     │
│                                                                │
│ Earn $20 credit for each friend who subscribes (after their    │
│ first paid month). They get $20 off their first month.         │
├──────────────────────────────────────────────────────────────┤
│ Your referrals                                                 │
│   Pending:   3 (signed up, not yet paying)                     │
│   Active:    2 (paying subscribers)                            │
│   Credits earned: $40                                          │
│   Credits applied: $20                                         │
│   Credits remaining: $20                                       │
└──────────────────────────────────────────────────────────────┘
```

Phase 2 affiliate program (framework §22) supersedes this in v2.

### §1.14 Mobile responsive layout

All screens above MUST work on mobile. Rules:
- Single-column layout below `sm:` breakpoint (640px).
- Touch targets ≥ 44×44 pt.
- Pick cards full-width on mobile; tap to expand modal slides up full-screen.
- Sport switcher tabs scroll horizontally on overflow.
- All tables wrap into definition-list-style stacked rows.
- Charts (Recharts) use `ResponsiveContainer` and degrade gracefully — sparkline-style on mobile.
- Auth flows are mobile-first because magic-link emails are opened on phones most of the time.

---

## §2 — Data model

Every table, every column, every relationship. Standardize naming: `snake_case` columns, semantic table names. The current production schema (post ~100 migrations) is reflected here, with launch additions called out.

### §2.0 Naming conventions

- Tables: plural, snake_case (`bets`, `pick_history`, `cache_player_game_logs`).
- Columns: snake_case (`player_name`, `confidence_score`, `is_synthetic`).
- Foreign keys: `<referenced_table>_id` (`pick_id`, `user_id`).
- Booleans: prefer `is_` / `has_` prefix (`is_synthetic`, `has_resolved`).
- Timestamps: `_at` suffix with `TIMESTAMPTZ` type (`created_at`, `settled_at`, `resolved_at`).
- Dates: `_date` suffix with `DATE` type (`game_date`) per D-110 (TEXT→DATE migration).
- Numerics: explicit precision for money/percentages (`NUMERIC(10,2)` for dollars, `NUMERIC(4,3)` for decimal percentages).

### §2.1 Core algorithm tables

#### `algorithm_weights`
Single-row table holding the live tunable algorithm weights.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INT PK | Always 1 — single-row config |
| `w_l5` | NUMERIC NOT NULL | L5 hit rate weight (~1.0) |
| `w_l10` | NUMERIC NOT NULL | L10 hit rate weight (D-065: 0.75) |
| `w_season` | NUMERIC NOT NULL | Season hit rate weight (~1.5) |
| `w_floor_ceiling` | NUMERIC NOT NULL | Floor/ceiling (~1.3) |
| `w_recent_form` | NUMERIC NOT NULL | |
| `w_home_away` | NUMERIC NOT NULL | D-044: bumped 0→1.0 |
| `w_rest` | NUMERIC NOT NULL | D-173: under-side suppressed |
| `w_b2b` | NUMERIC NOT NULL | D-170 Path C: zeroed pending data |
| `w_minutes_trend` | NUMERIC NOT NULL | |
| `w_pace` | NUMERIC NOT NULL | |
| `w_opp_defense` | NUMERIC NOT NULL | D-189: activated |
| `w_role_change` | NUMERIC NOT NULL | |
| `w_usg_rate` | NUMERIC NOT NULL | |
| `w_player_injury` | NUMERIC NOT NULL | |
| `w_stale_data` | NUMERIC NOT NULL | |
| `w_market_conf` | NUMERIC NOT NULL | |
| `w_vig_filter` | NUMERIC NOT NULL | D-059: 0→0.5 |
| `w_minutes_volume` | NUMERIC NOT NULL | D-075 decompose |
| `w_minutes_stability` | NUMERIC NOT NULL | D-075 decompose |
| `w_trivial_line_penalty` | NUMERIC NOT NULL | |
| `w_blowout_risk` | NUMERIC NOT NULL | D-137 |
| `w_line_movement` | NUMERIC NOT NULL | D-139 |
| `w_low_min_risk` | NUMERIC NOT NULL | D-136 |
| `w_ha_split` | NUMERIC NOT NULL | (currently 0 pending data) |
| `w_consistency` | NUMERIC NOT NULL | |
| `w_z_score` | NUMERIC NOT NULL | |
| `w_regression` | NUMERIC NOT NULL | |
| `w_prop_type_penalty` | NUMERIC NOT NULL | |
| `w_tier_aware` | NUMERIC NOT NULL | (Tier 4 #11 — pending) |
| `updated_at` | TIMESTAMPTZ | Manual updates per §19.3 |

RLS: read-public-to-authed. Write: service-role only.

#### `calibration_snapshots` (D-118)
Daily snapshot of algorithm calibration by tier × prop type × factor presence.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `snapshot_date` | DATE NOT NULL | |
| `window` | TEXT NOT NULL | rolling_7d / rolling_30d / all_time |
| `metric_type` | TEXT NOT NULL | overall / tier / prop_type / factor_presence |
| `tier` | TEXT NULLABLE | 90+ / 80-89 / 70-79 / 60-69 / <60 |
| `prop_type` | TEXT NULLABLE | points / rebounds / etc. |
| `factor_name` | TEXT NULLABLE | |
| `picks_count` | INT | |
| `hits` | INT | |
| `hit_rate` | NUMERIC(5,2) | |
| `units_pnl` | NUMERIC(10,2) | |
| `algorithm_version` | TEXT | for cross-version comparison |
| `created_at` | TIMESTAMPTZ | |

UNIQUE(snapshot_date, window, metric_type, tier, prop_type, factor_name).
Written daily by `write-calibration-snapshot` edge function (jobid 13).

#### `safety_gate_log` (D-081)
Audit trail for every auto_optimize proposal — applied or rejected.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `proposed_at` | TIMESTAMPTZ | |
| `proposal_jsonb` | JSONB | full weights JSON |
| `baseline_wr` | NUMERIC | current production backtest WR |
| `proposed_wr` | NUMERIC | proposal backtest WR |
| `wr_delta_pp` | NUMERIC | |
| `decision` | TEXT | APPLIED / REJECTED / NO_IMPROVEMENT / REJECT_OVERFIT / NO_SIGNAL / INSUFFICIENT_VALIDATE_DATA / NO_PROPOSAL / ERROR |
| `optimizer_mode` | TEXT | placeholder_no_op / coordinate_descent / multi_weight / walk_forward |
| `notes` | TEXT | |

### §2.2 Pick lifecycle tables

#### `pick_history`
The single source of truth for every algorithm-generated pick. Heavily denormalized for analytics.

Identity columns:
| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `player_name` | TEXT NOT NULL | |
| `prop_type` | TEXT NOT NULL | |
| `line` | NUMERIC NOT NULL | |
| `pick_side` | TEXT NOT NULL | over / under |
| `game_date` | DATE NOT NULL | D-110 — DATE not TEXT |
| `event_id` | TEXT | Odds API event id |
| `sport` | TEXT NOT NULL | nba / mlb / nfl / nhl |
| `source` | TEXT | process-games / analyze-pick / backfill-historical |
| `is_synthetic` | BOOLEAN DEFAULT FALSE | backfill picks flagged |
| `created_at` | TIMESTAMPTZ | |

UNIQUE: partial index on `(player_name, prop_type, line, pick_side, game_date) WHERE is_synthetic = false` (D-115 lesson — see §1.17 audit).

Confidence & scoring:
| Column | Type | Notes |
| --- | --- | --- |
| `confidence` | INT | 0-100 |
| `verdict_label` | TEXT | Elite/Strong/Good/Lean/Pass (D-101) |
| `factors` | JSONB | full breakdown for audit |
| `algorithm_version` | TEXT | YYYY-MM-DD-d### tag |
| `side_odds` | INT | American odds at pick time |
| `home_team` | TEXT, `away_team` | |
| `is_home` | BOOLEAN | |

Individual factor scores (every factor materialized as its own column for backtest_weights_v3 + optimizer reads):
- `score_l5`, `score_l10`, `score_season`, `score_floor_ceiling`, `score_recent_form`, `score_home_away`, `score_rest`, `score_b2b`, `score_minutes_trend`, `score_pace`, `score_opp_defense`, `score_role_change`, `score_usg_rate`, `score_player_injury`, `score_stale_data`, `score_market_conf`, `score_vig_filter`, `score_minutes_volume`, `score_minutes_stability`, `score_trivial_line_penalty`, `score_trivial_line_cap` (BOOLEAN), `score_blowout_risk`, `score_line_movement`, `score_low_min_risk`, `score_ha_split`, `score_consistency`, `score_z_score`, `score_regression`, `score_prop_type_penalty`, `score_odds_value` (dead, always 0)

Sanity flags (D-164/165/166/167):
- `unbettable_juice_flag BOOLEAN NOT NULL DEFAULT false`
- `is_secondary_market BOOLEAN NOT NULL DEFAULT false`
- `coin_flip_flag BOOLEAN NOT NULL DEFAULT false`
- `negative_stacking_flag BOOLEAN NOT NULL DEFAULT false`
- `negative_factor_count INT NOT NULL DEFAULT 0`

Resolution:
| Column | Type | Notes |
| --- | --- | --- |
| `actual_value` | NUMERIC | filled by resolve-picks |
| `hit` | BOOLEAN | TRUE/FALSE/NULL (void) |
| `resolved_at` | TIMESTAMPTZ | |
| `voided` | BOOLEAN | DNP auto-void |
| `void_reason` | TEXT | dnp / postponed / no_data |

AI:
| Column | Type |
| --- | --- |
| `ai_analysis` | TEXT |
| `ai_verdict` | TEXT |
| `ai_engine` | TEXT (sonnet / template / fallback) |
| `gemini_analysis` (deprecated per D-168 note) | TEXT |

Indexes:
- `(game_date)`, `(sport, game_date)`, `(player_name, prop_type, game_date)` for natural-key trigger lookups, `(confidence DESC, game_date)` for tier queries, `(resolved_at)` for resolution scans.

Triggers:
- AFTER INSERT/UPDATE: `set_secondary_market` (D-165) recomputes `is_secondary_market` for the (player, game_date) group with recursion guard.

Writers (per §1.17 audit):
1. `upsert_pick_history` RPC (called by `process-games`, `analyze-pick`, `process-games-mlb`, future `-nfl`/`-nhl`)
2. `backfill-bdl-historical` direct POST (specialized — writes resolution columns at insert time)

Both writer paths MUST be audited atomically on every column addition (§1.17 Cardinal Rule).

RLS: read-all to authed users; write service-role only.

#### `recommendations_cache`
Mirror of today/tomorrow `pick_history` rows that the Dashboard reads directly. Faster reads, narrower column set. Same key columns as `pick_history` plus:
- `expires_at TIMESTAMPTZ` — derived from game start time
- `available_books JSONB` — line shopping payload (D-028)
- `game_lines_summary JSONB` — spread/total context for game picks
- All score_*, verdict_label, ai_analysis, sanity flag columns mirroring pick_history (read-side denormalization)

Writers: `process-games`, `process-games-mlb`. Direct POST with `Prefer: resolution=merge-duplicates` (D-021 / D-064).
Readers: Dashboard's `fetchFromCache`.

RLS: read-all to authed; write service-role only.

#### `bets`
Subscriber-logged real-money bets.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL REFERENCES auth.users | D-025: trigger default |
| `pick_id` | UUID REFERENCES pick_history(id) NULLABLE | D-021 trigger natural-key resolver |
| `player_name`, `prop_type`, `line`, `pick_side` | | |
| `odds` | INT | American |
| `stake` | NUMERIC(10,2) | |
| `book` | TEXT | hard_rock / fanduel / draftkings / etc. |
| `status` | TEXT | pending / settled / voided |
| `result` | TEXT | win / loss / push / void |
| `result_value` | NUMERIC | |
| `payout` | NUMERIC(10,2) | |
| `placed_at` | TIMESTAMPTZ | |
| `settled_at` | TIMESTAMPTZ | filled by resolve-picks |
| `sport` | TEXT | |

Trigger: BEFORE INSERT — populate user_id default (D-025), populate pick_id via natural-key match (D-021).

View: `real_money_bets` (D-144 — SECURITY INVOKER) = `bets ⨝ pick_history` for Performance UI.

RLS: `(user_id = auth.uid())` for both read and write.

### §2.3 Subscriber tables

#### `auth.users`
Managed by Supabase Auth. We don't own this table but we reference its `id`.

#### `subscriptions`
Stripe subscription state mirror.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `user_id` | UUID NOT NULL UNIQUE REFERENCES auth.users | one active sub per user |
| `stripe_customer_id` | TEXT NOT NULL | |
| `stripe_subscription_id` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | trialing / active / past_due / canceled / unpaid / incomplete |
| `plan_id` | TEXT NOT NULL | pro_beta_49 / pro_monthly_99 / pro_monthly_129 / pro_monthly_149 (see §6.2.1 for the full price-ID catalog per D-196 Path C launch) |
| `current_period_start` | TIMESTAMPTZ | |
| `current_period_end` | TIMESTAMPTZ | |
| `cancel_at_period_end` | BOOLEAN | |
| `trial_end` | TIMESTAMPTZ NULLABLE | |
| `created_at`, `updated_at` | TIMESTAMPTZ | |

RLS: `(user_id = auth.uid())` read only. Write: service-role (Stripe webhook handler).

#### `user_preferences`
Subscriber settings server-side, per Apr 29 RLS / §15.10 #2 sync.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | UUID PK REFERENCES auth.users | |
| `default_sport` | TEXT DEFAULT 'nba' | |
| `selected_books` | JSONB | array of book ids |
| `kelly_fraction_mode` | TEXT DEFAULT 'quarter' | quarter / half / full |
| `bankroll` | NUMERIC(10,2) DEFAULT 1000 | |
| `email_notifications` | BOOLEAN DEFAULT false | |
| `push_notifications` | BOOLEAN DEFAULT false | |
| `tos_accepted_version` | TEXT | semver of TOS at acceptance |
| `tos_accepted_at` | TIMESTAMPTZ | |
| `state_residence` | TEXT | 2-letter US state from geo or self-attestation |
| `updated_at` | TIMESTAMPTZ | |

RLS: `(user_id = auth.uid())` read/write.

#### `allowed_emails` (legacy, deprecated post-launch)
Beta access allowlist. After Aug 1 launch, signups gated by subscription state instead of allowlist.

| Column | Type |
| --- | --- |
| `email` | TEXT PK (lowercase) |
| `added_by` | TEXT |
| `added_at` | TIMESTAMPTZ |

RLS: read-all to authed (so login flow can check); write admin only via `is_admin()` helper.

### §2.4 Launch additions

#### `referral_codes`
Subscriber's unique code.

| Column | Type | Notes |
| --- | --- | --- |
| `code` | TEXT PK | SHARP-XXXX format |
| `user_id` | UUID NOT NULL REFERENCES auth.users | |
| `created_at` | TIMESTAMPTZ | |
| `is_active` | BOOLEAN DEFAULT true | |

RLS: read-own + read-by-code (for landing-page attribution).

#### `referrals_made`
Tracks subscriber → friend conversions.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `referrer_user_id` | UUID NOT NULL REFERENCES auth.users | |
| `referred_user_id` | UUID NULLABLE REFERENCES auth.users | populated on signup |
| `referral_code` | TEXT NOT NULL REFERENCES referral_codes | |
| `status` | TEXT | pending / signed_up / paying / churned |
| `signed_up_at` | TIMESTAMPTZ | |
| `paying_since` | TIMESTAMPTZ | |
| `credit_dollars_earned` | NUMERIC(10,2) DEFAULT 0 | |

RLS: read-own (`referrer_user_id = auth.uid()`).

#### `referral_credits`
Subscriber's earned credit ledger.

| Column | Type |
| --- | --- |
| `id` | UUID PK |
| `user_id` | UUID NOT NULL |
| `amount` | NUMERIC(10,2) |
| `kind` | TEXT (earned / applied / expired) |
| `referral_id` | UUID NULLABLE REFERENCES referrals_made |
| `stripe_credit_id` | TEXT NULLABLE | Stripe coupon/credit ref |
| `created_at` | TIMESTAMPTZ |

#### `promotional_grants`
Closed-beta Aug 2026 invite tracking (per §14 Q7 / D-196) + future promo campaigns. The `grant_type` column distinguishes cohorts (e.g. `closed_beta_aug2026`, `launch_promo`, `friend_invite`).

| Column | Type |
| --- | --- |
| `id` | UUID PK |
| `user_id` | UUID NOT NULL |
| `grant_type` | TEXT (first_100_free_week / launch_promo / friend_invite) |
| `granted_at` | TIMESTAMPTZ |
| `expires_at` | TIMESTAMPTZ |
| `redeemed` | BOOLEAN |

#### `account_deletion_requests`
Soft-delete with 30-day grace period.

| Column | Type |
| --- | --- |
| `user_id` | UUID PK REFERENCES auth.users |
| `requested_at` | TIMESTAMPTZ NOT NULL |
| `scheduled_for` | TIMESTAMPTZ NOT NULL |
| `canceled` | BOOLEAN DEFAULT false |
| `canceled_at` | TIMESTAMPTZ |
| `executed_at` | TIMESTAMPTZ |

#### `state_availability`
Geo-gate for US states.

| Column | Type |
| --- | --- |
| `state_code` | TEXT PK |
| `status` | TEXT (available / waitlist / blocked) |
| `legal_review_status` | TEXT |
| `enabled_at` | TIMESTAMPTZ NULLABLE |

#### `analytics_events`
Funnel tracking. Not algorithmic — for retention/conversion analysis.

| Column | Type |
| --- | --- |
| `id` | UUID PK |
| `user_id` | UUID NULLABLE |
| `session_id` | TEXT |
| `event` | TEXT (signup / trial_started / pick_card_expanded / bet_logged / churn / etc.) |
| `metadata` | JSONB |
| `created_at` | TIMESTAMPTZ |

Anonymous events allowed (`user_id NULL`). Session id from a first-party cookie.

### §2.5 Cache tables

These are operational caches that exist purely to reduce ESPN/BDL/Odds API hits. All have `fetched_at` timestamps and TTL-based eviction.

- `cache_player_game_logs` — per-player game log snapshots
- `cache_opponent_defensive_stats` — per-team defensive ratings (BDL + ESPN merged)
- `cache_team_metadata` — team_name ↔ bdl_id ↔ espn_id mapping
- `cache_team_advanced_stats_by_position` (D-186) — team def vs position-specific scoring
- `cache_game_scoreboard` — per-day game results for resolution
- `cache_game_lines` (D-137) — spread + total game-line cache
- `props_cache` — raw Odds API event payloads

All cache tables: RLS read-public-to-authed (subscriber Evaluator hits them); write service-role only.

### §2.6 Observability tables

- `error_log` — structured errors written by `logErrorStructured`. Columns: `id`, `phase` (TEXT), `error_type` (TEXT), `severity` (TEXT — debug/info/warning/critical), `function_name` (TEXT), `message` (TEXT), `context` (JSONB — redacted per §7.4), `created_at`.
- `run_log` — per-cron-tick metrics. Columns: `id`, `function_name`, `status` (success/skipped/failure), `games_found`, `picks_generated`, `errors_count`, `cache_write_errors`, `opp_stats_failed`, `duration_ms`, `created_at`.
- `cron_progress` — per-cron-tick game-by-game progress tracking. Columns: `cron_tick_id`, `game_id`, `status` (pending/in_progress/complete/failed), `picks_count`, `started_at`, `completed_at`.
- `notifications_log` — outbound CEO + future subscriber alerts. Columns: `id`, `severity`, `metadata` JSONB, `sent_to` (slack / email / sms), `delivered_at`, `created_at`.
- `api_usage` — every Odds API + BDL call: `id`, `provider`, `endpoint`, `http_status`, `requests_remaining`, `requests_used`, `created_at`.
- `backfill_runs` — historical backfill orchestration runs: `id`, `start_date`, `end_date`, `status`, `picks_generated`, `created_at`.

### §2.7 Indexes (performance)

Beyond identity / unique indexes called out above, the following indexes are load-bearing for production query patterns:

- `pick_history (sport, game_date DESC)` — Dashboard sport-filter
- `pick_history (confidence DESC) WHERE confidence >= 60` — tier filters
- `pick_history (player_name, prop_type, game_date)` — natural-key trigger
- `pick_history (resolved_at)` — resolution scans
- `recommendations_cache (sport, game_date, confidence DESC)` — Dashboard fast path
- `bets (user_id, placed_at DESC)` — Tracker per-user history
- `bets (pick_id)` — Performance ⨝ pick_history
- `error_log (function_name, error_type, created_at)` — D-147 Check #4 scan
- `error_log (severity, created_at)` — Alerts
- `calibration_snapshots (snapshot_date DESC, window, metric_type)` — Performance reads
- `cache_player_game_logs (player_name, snapshot_date)` — Evaluator + analyze-pick reads

### §2.8 RLS policies

Every user-data table has explicit RLS. Per D-144 lesson — `CREATE OR REPLACE VIEW` does NOT preserve `security_invoker`; views must `ALTER VIEW ... SET (security_invoker = true)` explicitly after every replace.

Policy matrix:

| Table | Read | Write |
| --- | --- | --- |
| `bets` | `user_id = auth.uid()` | `user_id = auth.uid()` |
| `subscriptions` | `user_id = auth.uid()` | service-role only |
| `user_preferences` | `user_id = auth.uid()` | `user_id = auth.uid()` |
| `referral_codes` | own + by-code lookup | service-role only |
| `referrals_made` | `referrer_user_id = auth.uid()` | service-role only |
| `referral_credits` | `user_id = auth.uid()` | service-role only |
| `account_deletion_requests` | `user_id = auth.uid()` | `user_id = auth.uid()` (insert/update own) |
| `pick_history` | authed-read-all | service-role only |
| `recommendations_cache` | authed-read-all | service-role only |
| `algorithm_weights` | authed-read-all | service-role only |
| `calibration_snapshots` | authed-read-all | service-role only |
| `safety_gate_log` | admin only | service-role only |
| `allowed_emails` | authed-read-all | admin only |
| `analytics_events` | admin only | service-role only |
| All `cache_*` tables | authed-read-all | service-role only |
| `error_log`, `run_log`, `cron_progress`, `notifications_log`, `api_usage`, `backfill_runs` | admin only | service-role only |
| `state_availability` | public read | admin only |
| `promotional_grants` | `user_id = auth.uid()` | service-role only |

Helper function: `public.is_admin()` (Apr 29 D-029) returns TRUE if the calling user's email is in `ADMIN_EMAILS` (auth.users → email match). Used in admin-only policies.

### §2.9 Triggers

- `set_secondary_market` AFTER INSERT/UPDATE on `pick_history` (D-165): recomputes `is_secondary_market` for affected `(player_name, game_date)` group. Recursion guard via `pg_trigger_depth() < 2`.
- `default_bet_user_id` BEFORE INSERT on `bets` (D-025): fills `user_id` from session if null.
- `resolve_bet_pick_id` BEFORE INSERT on `bets` (D-021): natural-key match against pick_history to populate `pick_id`. Respects explicit values.
- `preserve_spread_line_t0` BEFORE UPDATE on `cache_game_lines` (D-139): immutability guard on first-observed spread.
- `update_subscriptions_updated_at` BEFORE UPDATE on `subscriptions`: standard updated_at maintenance.
- `process_deletion_on_signup_cancel` AFTER UPDATE on `account_deletion_requests`: if `canceled = true`, re-activate user's subscription if still within billing period.

---

## §3 — API surface (edge functions)

All edge functions are Deno-runtime Supabase functions under `supabase/functions/`. `verify_jwt = false` for cron functions; service-role-key gated via `BACKFILL_AUTH_TOKEN` for write paths. Subscriber-triggered functions (Evaluator) verify JWT and apply RLS naturally via the user's session.

### §3.1 Cron functions (write side)

#### `process-games`
The main NBA pick generation cron. Runs every 15 min during the 10am-7pm ET window.

- **Trigger:** pg_cron jobid 1 (every 15 min 10:00-19:00 ET)
- **Input:** none (reads props_cache + ESPN + BDL)
- **Output:** writes to `recommendations_cache` + `pick_history` (via `upsert_pick_history` RPC), `run_log`, `error_log`, all cache tables.
- **Skip paths (D-113):** outside cron window / no events in props_cache / all-games already complete — writes `run_log` row with `status='skipped'`.
- **Auth:** none (`verify_jwt = false`).
- **Errors:** structured `logErrorStructured` per D-158; silent-catch refactor per D-116. Notifications via `notify()` for critical errors.
- **AI:** Sonnet 4.6 (`getSonnetAnalysis`, `getSonnetGameAnalysis`). Cost ~$0.005/pick. Gemini path deprecated per D-168.

#### `process-games-mlb`
MLB pick generation. Currently DORMANT (D-120) — no cron schedule. Will be revived under D-118 calibration discipline + MLB rebuild per §15.1. See §13.

#### `process-games-nfl`
Future, deferred to fall 2026. Same architecture pattern.

#### `process-games-nhl`
Deferred to 2027.

#### `fetch-odds` / `fetch-odds-mlb`
Pulls today's player props + game lines from The Odds API into `props_cache` + `cache_game_lines`.

- **Trigger:** pg_cron jobid 2 (every 15 min)
- **API quota:** 100K/month plan ($59) — resets 1st of month 12am UTC
- **Errors:** D-064 dedupe within batch; D-119 (b) error_log wiring (commit ba72330)
- **Auth:** none

#### `resolve-picks`
Settles bets + pick_history twice daily.

- **Trigger:** pg_cron jobid 3 (10:00 AM + 12:30 AM ET)
- **Gates:** 6h-old min (D-078)
- **Writes:** `pick_history.actual_value, hit, resolved_at`; `bets.result, payout, settled_at`
- **DNP void:** `voided=true, void_reason='dnp'` when minutes=0 + stat=0
- **Reset endpoint (D-053):** `POST {"reset": true}` requires `x-reset-token` header matching `RESET_TOKEN` secret. Returns 401 otherwise.

#### `health-monitor`
Per-checkpoint health scanner.

- **Trigger:** pg_cron jobid 10 (every 30 min)
- **Checks:**
  1. error_log volume past hour above threshold
  2. run_log freshness — most recent process-games run within 30min
  3. algorithm_weights row updated_at freshness
  4. (D-147 + D-151) per-(function, error_type) failure rate (fast-burst >5/30min or slow-drain >3/6h)
- **Notifications:** notify() helper routes to notifications_log + Slack/email (§8.4)

#### `run-optimizer-v2`
Weekly auto-optimizer (walk-forward validated).

- **Trigger:** pg_cron jobid 12 (Sunday 11:00 UTC = 6am ET)
- **Auth:** service-role via vault.decrypted_secrets (D-108)
- **Logic:** D-104 — multi-weight grid search + walk-forward validation
- **Output:** safety_gate_log row + notification per run
- **Gate:** APPROVE / REJECT_OVERFIT / NO_SIGNAL / INSUFFICIENT_VALIDATE_DATA / NO_PROPOSAL / ERROR per D-105

#### `write-calibration-snapshot`
Daily calibration snapshot writer.

- **Trigger:** pg_cron jobid 13 (daily 11:15 UTC)
- **Writes:** 214 rows per run (D-118) across windows × metric types
- **RPC:** calls `compute_calibration_snapshot` SQL function

#### `snapshot-opp-stats`
Daily true-opponent-allowed RPG/APG aggregation from BDL.

- **Trigger:** pg_cron jobid 11 (daily 12:00 UTC)
- **Writes:** `cache_opponent_defensive_stats.rpg_allowed_bdl, apg_allowed_bdl, opp_stats_source`
- **Rate limit:** BDL ALL-STAR 60 req/min (D-098)

#### `fetch-team-advanced-stats` (D-186)
Per-position defensive scoring snapshot.

- **Trigger:** pg_cron jobid 14 (daily — schedule per D-186 migration)
- **Writes:** `cache_team_advanced_stats_by_position`

### §3.2 Subscriber-triggered functions (read side)

#### `analyze-pick`
Evaluator backend. Subscriber types player + prop + line → score.

- **Trigger:** HTTPS from Evaluator UI
- **Auth:** JWT verified; RLS applies
- **Cache-first read (D-179):** cache_player_game_logs + cache_opponent_defensive_stats + cache_team_metadata, then live ESPN/BDL fallback
- **Game-line cache fetch (D-156):** for D-137/D-139 factors
- **Scoring:** imports `_shared/scoring.ts` (D-155) — identical math to process-games
- **Writes:** pick_history row via `upsert_pick_history` RPC (D-177-A)

#### `get-player-stats`
Player lookup helper for Evaluator.

#### `get-live-games`, `get-props`
Auxiliary read endpoints — kept lean, defer to cache layers.

#### `team-stats`
Team advanced stat lookup (post-D-186).

#### `health-check`
Operational health endpoint. Returns boot status, last cron tick time, error_log summary. No auth required (uptime monitoring).

### §3.3 Launch additions

#### `stripe-webhook`
Single endpoint handler for all Stripe webhooks.

- **Auth:** Stripe webhook signature verification (`STRIPE_WEBHOOK_SECRET`)
- **Events handled:**
  - `customer.subscription.created` / `updated` / `deleted` — sync `subscriptions` table
  - `invoice.payment_succeeded` — extend period_end
  - `invoice.payment_failed` — mark past_due, retry, eventually cancel
  - `customer.subscription.trial_will_end` — send 3-day-warning email
  - `charge.refunded` — credit ledger
- **Idempotency:** every event has Stripe event id; we store processed ids in `stripe_events_processed` table to dedupe replays.
- **Race conditions:** subscription rows have `updated_at` — webhook handler skips updates with `event_created < row.updated_at` (out-of-order delivery).

#### `create-stripe-portal-session`
Generates a Stripe Customer Portal session URL.

- **Auth:** JWT required
- **Input:** none (reads user_id from session)
- **Output:** `{ url: '...' }` — redirect destination
- **Notes:** Stripe portal handles cancellation, payment method update, invoice history — we don't reimplement.

#### `create-checkout-session`
Generates a Stripe Checkout session for new signups.

- **Auth:** JWT required (post-magic-link)
- **Input:** `{ plan_id: 'pro_beta_49' | 'pro_monthly_99' | 'pro_monthly_129' | 'pro_monthly_149' }` (per §6.2.1 D-196 catalog; the function validates plan_id against the active price catalog at the current `launch_phase`)
- **Output:** `{ url: '...' }`

#### `export-user-data`
GDPR/CCPA data export.

- **Auth:** JWT + rate-limit (1/day per user)
- **Output:** signed URL to a ZIP in Supabase Storage; expires 7 days
- **Logs:** analytics_events { event: 'data_export_requested' }

#### `process-deletion-requests`
Daily cron that hard-deletes accounts past their 30-day grace window.

- **Trigger:** pg_cron jobid 15 (daily 02:00 UTC)
- **Logic:** select unprocessed account_deletion_requests where scheduled_for < NOW(), cascade-delete, mark executed_at

#### `send-daily-digest`
Optional subscriber morning digest.

- **Trigger:** pg_cron jobid 16 (daily 09:00 ET = 13:00 UTC)
- **Recipients:** users with `user_preferences.email_notifications = true`
- **Body:** top picks for today, calibration banner, link to Dashboard
- **Provider:** Resend or Postmark (§8.4)

#### `referral-attribution`
Webhook called when a `referrals_made` row transitions `pending → paying`.

- **Logic:** insert `referral_credits` row for referrer; trigger Stripe coupon creation for next invoice.

### §3.4 Error codes (consistent across all functions)

| Code | Meaning |
| --- | --- |
| 200 | Success |
| 200 + `{skipped: true}` | Successful skip (cron only) |
| 400 | Bad input (e.g. unknown player) |
| 401 | Missing or invalid auth |
| 403 | Forbidden (RLS or admin gate) |
| 404 | Player/game/event not found |
| 429 | Rate-limit exceeded (Odds API or BDL upstream) |
| 500 | Internal error — written to error_log |
| 503 | Upstream API outage — circuit breaker engaged (H6 fix) |

### §3.5 Rate limits

| Endpoint | Limit |
| --- | --- |
| `analyze-pick` (per user) | 20/min |
| `create-checkout-session` | 5/min |
| `export-user-data` | 1/day |
| `referral-attribution` | service-role only — no public limit |
| `stripe-webhook` | no app-level limit (Stripe's signature is the auth) |
| Cron functions | no rate limit (only fire on schedule) |

Implementation: lightweight in-memory per-instance counter with `_shared/rate_limit.ts` (to be added in Step B); for stricter enforcement, fall back to a `rate_limit_log` table.

---

## §4 — Algorithm specification

### §4.1 Top-line invariants

1. Base score starts at 50. Each factor adds or subtracts. Final clamped 0-100.
2. All 30 active stored factors (FACTOR_LABELS count per D-150, excluding intentionally-dead `score_odds_value`) live in `_shared/scoring.ts`. Single source of truth post-D-155.
3. Every factor is side-flipped where statistically correct — per the Bug #4 family closure in megadeploy D-064. Side-flips encoded as `if (pickSide === 'under') restScore = -restScore;` UNLESS the factor is asymmetric (D-173 score_rest is now under-suppressed, not side-flipped).
4. Every factor reads its weight from `algorithm_weights` row 1. Tuning is single-row UPDATE per §19.3 manual gate. Auto-optimize cron is UNSCHEDULED pending C16 closure + Path C re-enable per D-083.
5. Calibration is measured against post-megadeploy organic real-money data (reference #4 per D-134), not synthetic backfill (reference #1) or pre-megadeploy organic (reference #2 — contaminated). See §4.11.

### §4.2 Scoring factors (canonical list)

Each factor's columns are: name, formula (or short description), weight column, side-flip rule, fire-rate target, signal floor.

**Hit rate factors:**
- `score_l5` — L5 hit-rate buckets {+15,+12,+5,0,-8,-15}. Weight `w_l5` ~1.0. Side-flipped.
- `score_l10` — L10 buckets {+10,+5,0,-8}. Weight `w_l10` = 0.75 (D-065). Side-flipped.
- `score_season` — Season buckets {+10,+3,0,-8}. Weight `w_season` ~1.5. Side-flipped. (NB: 3-bucket categorical per D-119 finding — Tier 1 #4 calls for de-categorization but unshipped.)

**Statistical structure:**
- `score_floor_ceiling` — Floor > line +10 / Ceiling < line -8 / within 2 +3. Weight `w_floor_ceiling` ~1.3.
- `score_z_score` — z-score of recent vs season distributions. Side-aware (D-119 finding: directionally correct on misses).
- `score_consistency` — variance proxy.
- `score_regression` — mean-reversion penalty/bonus.

**Form:**
- `score_recent_form` — L5 avg vs season avg % delta {+10,+5,0,-5,-10}. Side-flipped.
- `score_minutes_trend` — L5 vs L10 minutes ratio.
- `score_minutes_volume` (D-075) — high minutes helps overs, hurts unders. Side-flipped.
- `score_minutes_stability` (D-075) — low minutes spread helps both sides. NOT side-flipped.

**Schedule/context:**
- `score_home_away` — Home +3 / Away -2. Weight `w_home_away` = 1.0 post-D-044. Side-flipped.
- `score_home_away_split` — per-venue hit rate buckets. Weight currently 0; under verification.
- `score_rest` — Rest day buckets. D-173: under-side suppressed (set to 0), over-side keeps positive signal. Weight `w_rest` ~1.0.
- `score_b2b` — Back-to-back penalty. D-170 Path C: weight zeroed pending 2-week data.
- `score_blowout_risk` (D-137) — Favored-team starters on big spreads get over-penalty. Side-flipped. Weight `w_blowout_risk` = 1.0.
- `score_line_movement` (D-139) — Spread movement toward/away from pick. Side-flipped. Weight = 1.0.
- `score_low_min_risk` (D-136) — Player whose minutes collapsed. Side-flipped. Weight = 1.0.

**Opponent / matchup:**
- `score_pace` — Opponent PPG bucketed (D-064 recentered on 116.1). Side-aware via prop-type cascade (D-064).
- `score_opp_defense` — Per-prop opponent defensive rating (D-079 BDL def_rating + D-186 per-position). Weight `w_opp_defense` activated D-189.
- `score_role_change` — Recent role shift detector.
- `score_usg_rate` — USG rate matchup.

**Player state:**
- `score_player_injury` — BDL injury status. Side-aware. ESPN-only injury endpoint useless; BDL is primary.
- `score_stale_data` — Days since last game with scaling cap.

**Market signal:**
- `score_market_conf` — Implied market confidence from odds.
- `score_vig_filter` — High-vig penalty. Weight `w_vig_filter` = 0.5 (D-059).
- `score_trivial_line_penalty` (D-127) + `score_trivial_line_cap` (D-140) — Lines clustered near round numbers get penalty + Layer-2 cap predicate.
- `score_prop_type_penalty` — Per-prop-type baseline difficulty.
- `score_odds_value` — DEAD. Weight forced 0. Confirmed -1.19 delta in early backtests; kept as column for backwards compat.

**Future / Tier 4 #11:**
- `score_tier_aware` — Scoring that differs by current confidence tier. NOT YET SHIPPED. Per framework Tier 4 #11.

### §4.3 Tiers and labels (D-101)

| Tier | Confidence | Label |
| --- | --- | --- |
| Elite | 90+ | Elite Pick |
| Strong | 80-89 | Strong Pick |
| Good | 70-79 | Good Pick |
| Lean | 60-69 | Lean |
| Pass | <60 | Pass (not displayed) |

Labels are subscriber-facing. Algorithm internal name: `verdict_label` column on pick_history.

### §4.4 Calibration baselines (D-118 + D-123)

These are the reference points that subscriber-facing copy + auto-optimize gate read.

| Tier | Empirical hit rate (post-megadeploy synthetic) | Conservative buffer used for Kelly | Real-money 30d target |
| --- | --- | --- | --- |
| 90+ | 71.8% (142 picks) | 0.700 | ≥ 68% |
| 80-89 | 61.0% (210 picks) | 0.595 | ≥ 58% |
| 70-79 | 57.7% (473 picks) | 0.560 | ≥ 55% |
| 60-69 | 57.3% (853 picks) | 0.555 | ≥ 53% |

Calibration drift alert thresholds: if any tier's rolling-30d real-money WR drops below the "target" column for 7+ consecutive days, fire amber alert; >14d red alert (§8.5).

### §4.5 Walk-forward methodology (D-104 + D-109)

- **Train window:** Feb 1 – Mar 31, 2026 (synthetic backfill)
- **Validate window:** Apr 1 – May 3, 2026 (synthetic backfill)
- **Decision logic:** APPROVE only if validate-window delta is positive AND train/validate delta gap < 5pp (overfit ceiling).
- **REJECT_OVERFIT** fires when train shows positive delta but validate shows negative or near-zero. First smoke run caught +19.81pp train / -1.11pp validate (D-104).
- **Real-data window:** post-Aug 1 launch, train window shifts to organic data only; synthetic data is retired from the optimizer feedback loop.

### §4.6 Auto-optimize re-enable plan

Per D-083 Path C — manual control until ≥3000 post-megadeploy organic resolved picks accumulate. Then re-enable jobid 12 weekly schedule + safety gate at threshold = current production WR - 1pp.

Re-enable conditions (loop must verify all):
1. ≥3000 organic post-megadeploy resolved picks across 70+ tier
2. rolling-30d 70+ tier WR ≥ 55% for 14 consecutive days
3. Three §1.12 verifications clean on the last 3 weight changes
4. CEO §19.3 explicit re-enable approval

Loop owns conditions 1-3 verification. Condition 4 is human-gate.

### §4.7 Sanity flags (D-164–D-167)

These don't change confidence — they tag picks for transparency.

- `unbettable_juice_flag` — confidence in tier X but juice past tier-X breakeven
- `is_secondary_market` — same player + game_date with higher-conf pick exists; this one is duplicative
- `coin_flip_flag` — confidence ≥80 but season hit rate 40-60% (suggests artificial pumping)
- `negative_stacking_flag` + `negative_factor_count` — confidence ≥80 with ≥3 negative factor scores

Sanity check WR deltas surfaced in Performance.SanityChecksSection — if `negative_stacking_flag=true` picks have >10pp WR delta vs not-flagged, it's Failure Mode D signature surfacing (§8.5 alert).

### §4.8 DNP void rules

A pick is voided (not counted as a loss) when:
- minutes = 0 AND stat = 0 (player didn't play)
- game postponed (`games.status = 'postponed'`)
- BDL/ESPN data unavailable for the game date and 3 retries failed

Voided picks: `voided=true`, `void_reason=<dnp|postponed|no_data>`, `hit=NULL`. Bets resolved against voided picks: `bets.result='void'`, `payout = stake` (full refund).

### §4.9 Multi-sport sport-specific overrides

NBA is canonical (this whole §4). Other sports:

- **MLB:** different scoring math (Ks/hits/runs vs points/assists). Different data sources (MLB Stats API + BDL Baseball). Different opp stats (pitcher matchup vs team def_rating). `process-games-mlb` lives at `supabase/functions/process-games-mlb/index.ts` and imports `_shared/scoring.ts` only for utility helpers — the core scoring formula is MLB-specific. Currently DORMANT (D-120) pending rebuild per §15.1.
- **NFL:** weekly games (slower data cycle), heavier weight on opponent matchup. Build effort, deferred per §13.
- **NHL:** deferred to 2027.

### §4.10 Tier 4 #11 — tier-aware scoring (planned)

Currently every factor has the same weight across confidence tiers. D-119 audit showed the algorithm has two personalities — works for blocks/steals at 60-69 (84%/81% WR) and broken for points/assists at 70-79 (43%/36% WR). Tier 4 #11 adds per-tier weight modifiers, gating high-tier picks more strictly.

Implementation sketch (for the loop to execute):
- New table `algorithm_weights_tier_modifiers (tier, factor_name, multiplier)`
- `_shared/scoring.ts` reads modifier table; weight effective = base_weight × modifier(tier, factor)
- Initial multipliers from D-119 audit findings
- Walk-forward validation on tier-modifier proposals like base weights

### §4.11 The four (now five) meanings of "70+" — and the cohort drift

Per framework §11.5, "70+ confidence" appears in different places with different semantics. The architecture forbids conflating them:

1. **Algorithm verdict label** (`getScoreLabel`, src/lib/confidence.ts:101): subscriber-facing string.
2. **Backtest training threshold:** synthetic-data filter for optimizer.
3. **Dashboard display threshold:** subscriber-selectable filter (default 70).
4. **Resolution sampling milestone:** "first 200 resolved 70+ picks" criterion for data-driven decisions.
5. **Calibration reference #N:** D-123 surfaced four distinct calibration cohorts (synthetic backtest, pre-megadeploy organic, post-megadeploy organic rescored, live-engine organic). Subscriber-facing copy uses reference #4 only (D-134).

Every subscriber-facing copy that mentions hit rate, win rate, or "70+" MUST cite which meaning. Loop tasks touching these surfaces verify the citation before commit.

---

## §5 — Infrastructure

### §5.1 Cron jobs (pg_cron, all in `cron.job`)

| Jobid | Function | Schedule (UTC) | Purpose |
| --- | --- | --- | --- |
| 1 | `process-games` | every 15 min, 14:00-23:00 (10am-7pm ET) | NBA pick generation |
| 2 | `fetch-odds` | every 15 min | Odds API ingest |
| 3 | `resolve-picks` | 14:00, 04:30 daily | Settle picks + bets |
| 4 | `process-games-mlb` | (DORMANT, manual only) | MLB picks |
| 5 | `fetch-odds-mlb` | (DORMANT, will activate w/ MLB) | |
| 10 | `health-monitor` | every 30 min | All health checks |
| 11 | `snapshot-opp-stats` | 12:00 daily | BDL opp aggregation |
| 12 | `run-optimizer-v2` | Sundays 11:00 | Walk-forward optimizer (CURRENTLY APPROVE-ONLY GATE; per Path C will re-enable post-data) |
| 13 | `write-calibration-snapshot` | 11:15 daily | Calibration tracking |
| 14 | `fetch-team-advanced-stats` | per D-186 migration | Per-position def cache |
| 15 | `process-deletion-requests` | 02:00 daily | GDPR/CCPA |
| 16 | `send-daily-digest` | 13:00 daily | Subscriber emails |
| 17 | `process-promotional-grants` | 03:00 daily | Closed-beta cohort expiry sweep + future promo expiries (per §14 Q7) |

All cron commands invoke the edge function via pg_net + Authorization Bearer from `vault.decrypted_secrets` (D-108).

### §5.2 Cache tables — see §2.5

Cache eviction: per-table TTL. Daily snapshot tables (cache_team_advanced_stats_by_position, cache_opponent_defensive_stats) keep only the latest snapshot_date; older rows deleted on next snapshot write. Player game-log cache keeps rolling 14d.

### §5.3 Monitoring (D-147 + D-151 + §8)

Three checks via `health-monitor` (covered §3.1). Plus:
- Vercel deployment status alerts (Slack via Vercel integration)
- Supabase project health page (uptime, query latency)
- BDL/Odds API quota meters in api_usage

### §5.4 Log surfaces

- `error_log` — structured, queryable
- `run_log` — cron metrics
- `notifications_log` — outbound alerts ledger
- Supabase function logs (Deno console) — short retention; treat as ephemeral

### §5.5 Deploy gates

Each deploy must pass:
1. `tsc --build` clean
2. `npm run build` clean
3. ESLint clean (`npm run lint`)
4. (loop-added) Visual diff vs baseline screenshot (B.2 rule-check)
5. (loop-added) Schema audit per §1.17 if any migration touches a multi-writer table

Step B's runner will enforce these gates pre-commit.

### §5.6 Secrets

All in Supabase secrets / Vercel env vars. Never in code (D-053 / S1 lesson). Names:

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — edge function env
- `THE_ODDS_API_KEY` — Odds API
- `BALLDONTLIE_API_KEY` — BDL
- `ANTHROPIC_API_KEY` — Claude Sonnet for AI analysis
- `GEMINI_API_KEY` — legacy, dead code retained
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`
- `RESEND_API_KEY` or `POSTMARK_API_KEY` — transactional email
- `SENTRY_DSN_FRONTEND`, `SENTRY_DSN_EDGE` — error reporting
- `RESET_TOKEN` — resolve-picks reset endpoint guard
- `BACKFILL_AUTH_TOKEN` — service-role token for cron-invoked edge functions

Rotation: quarterly per §7.3. Documented per D-053 — rotate at provider, update Supabase secrets / Vercel env, deploy.

### §5.7 Backup & recovery

- Supabase Pro plan: daily automated DB backups, 7-day retention, point-in-time recovery (PITR).
- Critical tables manually exported weekly to S3 (`pick_history`, `bets`, `subscriptions`, `user_preferences`, `calibration_snapshots`) — script + cron jobid 18 (Sunday 04:00 UTC).
- Restore drill: quarterly test of PITR restore to staging project, verify counts and row checksums.

### §5.8 Hosting

- **Frontend:** Vercel — static assets + edge function `/api/*` routes (currently zero — we use Supabase functions for all backend).
- **Backend:** Supabase project `gzuzuqxvfjszlfclhcfz` (Pro tier $25/mo).
- **Domain:** `betgenius-eight.vercel.app` currently. Rebrand to `sharpai.app` deferred (framework §2.6 — coordinated DNS cutover required).

---

## §6 — Payments + auth

### §6.1 Auth (Supabase magic links)

Already shipped (D-029). Magic link via `signInWithOtp`. Allowlist (`allowed_emails`) currently gates beta access; post-launch the gate becomes "has active subscription."

Auth flow:
1. User enters email → `signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })`
2. Email arrives with magic link → user clicks → Supabase exchanges token for session
3. Session stored in localStorage (Supabase JS client) — auto-refreshed
4. `useAuthSession()` hook exposes session to App
5. `isAdmin` derived from `ADMIN_EMAILS.includes(session.user.email.toLowerCase())`

State transitions:
- Anonymous → magic-link-sent → signed-in → signed-out (sign-out button)
- Session expiry: 1 hour access token, 7d refresh. Auto-refresh.

### §6.2 Stripe integration

#### §6.2.1 Product configuration (Stripe Dashboard)

**Path C launch catalog per §14 Q7 (D-196, 2026-05-17):** four recurring-monthly price IDs sequenced across launch phases.

- Product: "SharpAI Pro"
- Prices (recurring monthly):
  - `pro_beta_49` — **$49/mo** — closed-beta cohort, Aug 1 – Sept 30, 2026 window. 50-invite cap. Auto-migrates to `pro_monthly_99` at first renewal after 2027-04-01 (§11.4 grandfather migration).
  - `pro_monthly_99` — **$99/mo** — public-launch price, active Oct 1, 2026 onward. Also the destination price for beta migration in Apr 2027.
  - `pro_monthly_129` — **$129/mo** — Q2 2027 new-subscriber price (per 3-Year Plan Phase 4). Activates Apr 1, 2027 for any signup that wasn't an existing beta-cohort migration.
  - `pro_monthly_149` — **$149/mo** — future premium tier (deferred; not active at v1).
- Trial: 7 days, set at Checkout-session creation. Applies to public-launch flows (`pro_monthly_99` / `pro_monthly_129`); closed-beta signups bypass the 7-day trial via `promotional_grants.closed_beta_aug2026` per §11.1.
- Tax: **Stripe Tax** enabled. CEO §14 Q1 decision (D-192-A.1, 2026-05-16): **Stripe direct + Stripe Tax** is the chosen approach — no merchant-of-record provider (LemonSqueezy ruled out). Stripe Tax handles US state sales tax + Canadian GST/HST per §9.3 broad-state + Canada launch posture.

**Beta → public migration logic (Apr 1, 2027):**
- Per §14 Q7 / §11.4: subscribers on `pro_beta_49` are migrated to `pro_monthly_99` at their first renewal date after 2027-04-01.
- Stripe webhook handler reads `subscriptions.plan_id` + `current_period_end`; on the renewal event closest to 2027-04-01, calls `stripe.subscriptions.update({ items: [{ price: 'pro_monthly_99' }], proration_behavior: 'none' })`.
- 30-day advance notice email goes out 2027-03-01 to every `pro_beta_49` holder ("Your beta pricing ends May 1, 2027. New pricing $99/mo unless you cancel.").
- Cancel-anytime window respected — subscriber can `customer.subscription.deleted` via Stripe portal at any point before the renewal lands at $99.

#### §6.2.2 Signup → trial flow
1. Subscriber signs up via magic link (§6.1)
2. Lands on `/dashboard` — if no `subscriptions` row, redirect to `/subscribe`
3. `/subscribe` page: select plan → POST to `create-checkout-session` edge function
4. Receives Stripe Checkout URL → redirect
5. Subscriber completes Checkout (or abandons)
6. Stripe sends `checkout.session.completed` webhook
7. `stripe-webhook` handler: insert `subscriptions` row with `status='trialing'`, `trial_end = NOW() + 7d`
8. Subscriber redirected to `/dashboard?welcome=true` — full access

#### §6.2.3 Trial → paid conversion
1. Stripe charges card on day 7 automatically
2. `invoice.payment_succeeded` webhook fires
3. `stripe-webhook` updates `subscriptions.status='active'`, extends `current_period_end`
4. (Optional) email "Your trial has converted" via send-transactional-email

#### §6.2.4 Renewal
1. Stripe charges on `current_period_end`
2. `invoice.payment_succeeded` webhook → extend period_end
3. No subscriber-facing action

#### §6.2.5 Cancellation
1. Subscriber clicks "Manage subscription" in Settings
2. Opens Stripe Customer Portal
3. Subscriber cancels
4. Stripe sends `customer.subscription.updated` with `cancel_at_period_end=true`
5. `stripe-webhook` updates `subscriptions.cancel_at_period_end=true`
6. Access continues until `current_period_end`
7. On period end, Stripe sends `customer.subscription.deleted` → status='canceled' → Dashboard returns "Subscribe to continue" view

#### §6.2.6 Refunds
- Manual via Stripe Dashboard (CEO-issued).
- Webhook `charge.refunded` triggers a `referral_credits` insert with `kind='refund_offset'` if any commission was paid out — clawback.
- Subscriber refunded amounts visible in Settings → Subscription history.

#### §6.2.7 Failed payments
- `invoice.payment_failed` → status='past_due' → Stripe retries automatically (4 attempts over ~3 weeks)
- Day-3, Day-7 reminder emails sent by Stripe (configurable)
- Final failure → `customer.subscription.deleted` → status='canceled'

### §6.3 Webhook signature verification

Every `stripe-webhook` request must:
1. Read `Stripe-Signature` header
2. Compute expected signature with `STRIPE_WEBHOOK_SECRET`
3. Compare with constant-time equality
4. Reject 400 if mismatch

Use Stripe's official SDK (`stripe.webhooks.constructEvent`) — never roll our own.

### §6.4 Subscription state machine

States: `incomplete` → `trialing` → `active` ↔ `past_due` → `canceled` (terminal). `unpaid` is reachable from `past_due` after grace period exhausted.

Access gate (`useSubscriptionGate` hook):
- `trialing` / `active` → full access
- `past_due` → full access for first 3 days, then degraded ("Payment past due — update your card to keep access")
- `canceled` (with cancel_at_period_end) → full access until period_end
- `canceled` (terminal) → `/subscribe` page only
- No `subscriptions` row → `/subscribe` page only (post-launch only — pre-launch allowlist gates)

Gate applied at the React Router (App.tsx) level: every page except `/subscribe`, `/login`, `/signup`, `/support` checks `useSubscriptionGate`.

### §6.5 Magic-link details

- Templates customized in Supabase Auth → Email Templates → "Magic Link"
- Subject: "Sign in to SharpAI"
- Body: branded with SharpAI logo + clear "Click to sign in" CTA + "If you didn't request this, ignore" disclaimer
- Site URL + Redirect URLs configured in Supabase Auth → URL Configuration: production domain + staging + localhost

### §6.6 Account deletion + GDPR/CCPA

Covered in §1.11 + §3.3.

The 30-day grace window aligns with Stripe's reasonable-cancellation expectation. If the subscriber cancels deletion mid-grace, their subscription is re-activated automatically only if `current_period_end > NOW()` (i.e. they haven't lapsed). Else they must re-subscribe.

Data exported: see §1.11.
Data deleted: see §1.11.
Data retained post-deletion: pick_history (algorithm output, no personal data once user_id removed); aggregated analytics events with user_id replaced by deterministic hash.

### §6.7 Subscription gating per route

| Route | Auth required | Subscription required |
| --- | --- | --- |
| `/` (landing) | No | No |
| `/signup`, `/login` | No | No |
| `/support` | No | No |
| `/subscribe` | Yes | No |
| `/dashboard` | Yes | Yes |
| `/evaluator` | Yes | Yes |
| `/tracker` | Yes | Yes |
| `/performance` | Yes | Yes |
| `/settings` | Yes | Yes (read-only without sub) |
| `/refer` | Yes | Yes |
| `/account/export`, `/account/delete` | Yes | No |
| `/admin` | Yes + admin email | N/A (always full access) |

---

## §7 — Security

### §7.1 RLS — see §2.8

Every user-data table has explicit RLS. Tested via the §1.12 verification migration pattern: after any policy change, run a probe query with anon key + a probe query with service-role key, confirm anon row count = filtered subset and service-role count = total.

### §7.2 Service-role key handling

- `SUPABASE_SERVICE_ROLE_KEY` lives in Supabase secrets only — never in frontend bundles, never in git.
- Edge functions read it via `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`.
- Loop's code-review checklist (§5.5 deploy gate) greps for the substring `service_role` in any committed `src/**` file → blocks commit.

### §7.3 API key rotation policy

Quarterly rotation for all upstream keys (Odds API, BDL, Anthropic, Gemini, Stripe — except Stripe webhook secret which only rotates if compromised).

Rotation runbook per key:
1. Generate new key at provider
2. `supabase secrets set <KEY>=<value>`
3. Deploy any affected edge function (env var is read at boot)
4. Revoke old key at provider
5. Document in framework D-record

### §7.4 Error context redaction

Per `logErrorStructured` (D-117 / D-158): no PII or API keys ever in `error_log.context`.

Rules:
- Never log full request body — log truncated 500-char body excerpt with key fields named explicitly (`{ player_name, prop_type, game_date }`).
- Never log `Authorization` headers, `apikey` headers, full cookies.
- Never log full email addresses — log domain only or hashed user_id.
- API errors from upstream: log HTTP status + first 200 chars of response body. Anything looking like a key (pattern: 32+ alphanumeric chars) gets replaced with `<redacted>`.

A `_shared/redact.ts` helper enforces this — every `logErrorStructured` call passes through it.

### §7.5 Rate limiting (per §3.5)

In-memory per-instance for low-volume endpoints; `rate_limit_log` table for higher-stakes endpoints. CSRF protection: Supabase Auth's session JWT serves as CSRF token implicitly (no cookie-based session, so no CSRF surface).

### §7.6 Subscriber data export + account deletion — see §1.11 / §6.6

### §7.7 SQL injection prevention

- All queries via PostgREST or SQL functions with parameterized arguments — no string concatenation.
- One exception: dynamic queries in `_shared/sql_builder.ts` (to be added in Step B if needed) — all dynamic identifiers whitelisted against schema.

### §7.8 Frontend security

- CSP header (Vercel config): `default-src 'self'; script-src 'self' https://js.stripe.com; connect-src 'self' https://*.supabase.co https://api.stripe.com`
- Subresource Integrity for any third-party scripts (Stripe Elements)
- No `dangerouslySetInnerHTML` except for sanitized AI-analysis text (passed through DOMPurify)
- Frame-ancestors none (no iframe embedding)

### §7.9 Threat model summary

| Threat | Mitigation |
| --- | --- |
| Account takeover via stolen magic link | Magic links single-use, 1h TTL, IP fingerprinted (Supabase Auth default) |
| Subscription bypass | Webhook signature verification + idempotent event handling + server-side subscription state check on every gated request |
| Data exfiltration via RLS bypass | Explicit policies on every user table; quarterly RLS audit per loop B.5 rule-check |
| API key theft from logs | Redaction helper enforced via grep in pre-commit |
| Replay attack on Stripe webhook | Stripe event id dedup table + signature check |
| Brute-force magic-link email guessing | Supabase Auth rate-limits OTP requests per email per IP |
| Mass account creation for promo abuse | Closed-beta cohort gated by invite code (50-seat hard cap per §11.1) + CEO-reviewed waitlist approval — no anonymous promo grants in v1 |
| State-availability bypass | Geo-IP gate at OTP request AND at every page load (server-side via Vercel geo headers) |

---

## §8 — Observability + alerts

### §8.1 Sentry configuration

#### §8.1.1 Frontend (Vercel-hosted)
- `@sentry/react` instrumented in `src/main.tsx` with `dsn: import.meta.env.VITE_SENTRY_DSN_FRONTEND`
- `Sentry.init` with `tracesSampleRate: 0.1`, `replaysSessionSampleRate: 0.05`, `replaysOnErrorSampleRate: 1.0`
- `Sentry.ErrorBoundary` wraps `<App />` — fallback UI per §10.7
- `beforeSend` hook scrubs PII via the same `_shared/redact.ts` logic (port to TS-shared lib)
- Release tag from `git rev-parse HEAD` injected at build time via Vite env

#### §8.1.2 Edge functions (Deno)
- Sentry's Deno SDK (`@sentry/deno`) initialized in `_shared/sentry.ts`
- Every function imports + wraps its handler in `Sentry.captureException` on catch
- `tracesSampleRate: 0.1`
- DSN from `Deno.env.get('SENTRY_DSN_EDGE')`
- `_shared/sentry.ts` exposes `captureWithContext(error, { function_name, ... })` so error context is consistent

#### §8.1.3 What's captured
- Frontend: every unhandled exception, every `Sentry.captureException` call, every error boundary fallback
- Edge: every catch-block where the error type isn't a known graceful-degradation (e.g. BDL 429 → graceful fall through to ESPN); only unexpected paths captured

#### §8.1.4 What's NOT captured
- 401/403 user-error responses (those are expected)
- Cron skip paths (D-113 — these are not errors)
- Validation errors (those are user-actionable, not engineer-actionable)

### §8.2 error_log routing

Two paths:
1. **Structured app errors:** `logErrorStructured` writes to `error_log` table (Supabase). Used by every edge function.
2. **Exception escapes:** `_shared/sentry.ts` captures to Sentry AND writes a row to `error_log` with `severity='critical'` so the in-app health-monitor sees it.

Retention:
- `error_log` rows: 90 days, then deleted by `prune-error-log` cron (jobid 19, weekly).
- Sentry retention: 30 days at launch (per CEO §14 Q3 decision below).

**Sentry plan: Team plan** ($26/mo, 50K events, 30d retention) — CEO §14 Q3 decision (D-192-A.1, 2026-05-16). Self-hosted ruled out (ops burden too high pre-1000-subscribers). Revisit at 1000+ subscribers per the original recommendation.

**Outbound email provider: Resend** — CEO §14 Q2 decision (D-192-A.1, 2026-05-16). Postmark + SendGrid ruled out. Used by §8.8 notify() critical-severity email leg + §10.3 transactional email templates.

### §8.3 Cron health monitoring (D-147 + D-151)

Already covered §3.1 health-monitor + §5.3. The four checks:
1. error_log volume past hour
2. run_log freshness
3. algorithm_weights row freshness (catches optimizer cron silently failing)
4. per-(function, error_type) silent-failure pattern (D-117 closure)

Severities:
- Critical (`silent_failure_pattern_no_run`, `cron_silent`) — SMS + Slack + email
- Warning (`silent_failure_pattern`, `silent_failure_pattern_slow_drain`) — Slack + email
- Info (`cron_resumed_after_outage`) — Slack only

### §8.4 Subscriber-facing status page

`/status` route. Static + server-rendered.

```
┌──────────────────────────────────────────────────────────────┐
│ SharpAI status                                                 │
├──────────────────────────────────────────────────────────────┤
│ Pick generation:    ✓ Operational  (last update 4 min ago)    │
│ Line shopping:      ✓ Operational  (last odds 6 min ago)      │
│ Bet tracking:       ✓ Operational                              │
│ Email notifications:✓ Operational                              │
├──────────────────────────────────────────────────────────────┤
│ Recent incidents (last 30 days)                                │
│   None                                                         │
└──────────────────────────────────────────────────────────────┘
```

Data source: latest run_log rows for each function. If most recent run_log is >60min stale → "Investigating." If error_log critical count >0 in last hour → "Investigating." Manual override flag (table: `incident_status`) lets CEO set degraded/investigating without code change.

### §8.5 Calibration-drift alerts

Specific to algorithm health. Reads `calibration_snapshots`.

Triggers:
- 70+ tier rolling-30d WR drops below 65% for 3 consecutive days → AMBER (Slack)
- 70+ tier rolling-30d WR drops below 60% for any day → RED (SMS + Slack + email)
- Any sanity-flag-vs-non-flag WR delta > 10pp for 7 days → Failure Mode D signature alert
- Synthetic vs organic WR delta > 15pp for any tier (D-123 cohort drift surveillance) → CRITICAL

These are subscriber-trust-protecting alerts. When any fires, the Dashboard's calibration banner switches to "Investigating" copy automatically (§1.4) — subscriber sees we know.

### §8.6 Performance metrics

| Metric | Target | Surface |
| --- | --- | --- |
| Cron tick end-to-end | < 30s | run_log.duration_ms |
| Evaluator response (cache hit) | < 500ms | analyze-pick timing |
| Evaluator response (live fetch) | < 8s | analyze-pick timing |
| Dashboard load (cold) | < 2s LCP | Vercel Speed Insights |
| API quota burn rate (Odds API) | < 80% of monthly cap | api_usage live |
| Cache hit rate | > 80% | cache hit/miss counters in run_log |

Metrics surfaced on Performance page admin section (admin-only).

### §8.7 Daily CEO health digest

Email to CEO at 09:00 ET. Source: aggregated reads of run_log, error_log, calibration_snapshots, api_usage.

```
SharpAI daily digest — 2026-05-16

Yesterday's picks:        47
Yesterday's 70+ picks:    12
Bets logged by users:     38
Real-money 70+ WR (rolling-30d): 67.2%  [trend ↑]
Calibration drift:        0 tiers in alert
Odds API quota:           34% used (May)
Critical errors past 24h: 0
Cron skips past 24h:      3 (all expected — outside game window)
Subscribers active:       38 beta + 0 public (closed-beta phase)
                          // post-Oct 1 reads: "<beta_count> beta + <public_count> public"
New signups yesterday:    4
Churn yesterday:          1
```

### §8.8 Outbound notifications transport

`notify()` helper in `_shared/notify.ts` routes by severity:
- Critical → Slack webhook + SMS via Twilio + email via Resend
- Warning → Slack + email
- Info → Slack only

All notifications written to `notifications_log` ledger BEFORE dispatch (so we have an audit trail even if dispatch fails).

---

## §9 — Legal + compliance

### §9.1 Terms of Service structure

Single ToS document. Version-stamped. Subscriber acceptance recorded in `user_preferences.tos_accepted_version` + `tos_accepted_at`. When ToS changes, subscribers see an interstitial "Accept updated Terms" on next login before they can use the app.

Required sections:
1. Definitions
2. Service description (AI sports analytics + projections platform, **NOT** financial advice, **NOT** betting advice, **NOT** a sportsbook)
3. Eligibility (18+ in jurisdictions where 18 is the age of majority for entering contracts; US + Canada residents at v1 per §9.3 broad-state launch; not state-restricted at launch — counsel-flagged jurisdictions monitored per §9.3)
4. Subscription terms (price, billing, trial, cancellation, refund policy)
5. Disclaimer of warranties + limitation of liability
6. User conduct (no scraping, no resale, no automated access)
7. Intellectual property (algorithm output © SharpAI; subscriber data theirs)
8. Termination + account suspension grounds
9. Dispute resolution (binding arbitration, Florida law)
10. Modifications + contact

Initial draft owed before Aug 1. Legal review BEFORE first paid subscriber.

### §9.2 Privacy policy

GDPR/CCPA-compliant. Structure:

1. What we collect (email, IP, geo, bet logs, browsing within app)
2. Why we collect (provide service, billing, analytics, fraud prevention)
3. How we share (Stripe for payments, Supabase for infra, email provider — explicit subprocessor list)
4. How long we retain (subscriptions: lifetime + 7y for tax; analytics events: 2y; user_preferences: until deletion)
5. Your rights (access, deletion, portability, correction, opt-out of marketing)
6. Cookies / tracking (first-party only; no third-party trackers)
7. Children (not for under-18 per §9.1 item 3; under-21 messaging reserved for jurisdictions where age-of-majority for our service warrants it — counsel-driven)
8. International (US + Canada at launch per §9.3; cross-border data flow disclosed; GST/HST handled via Stripe Tax)
9. Changes
10. Contact

### §9.3 State availability + positioning posture

**CEO §14 Q5 decision (D-192-A.1, 2026-05-16):** Broad launch across **all 50 US states + Canada** at v1.

**Positioning posture:** SharpAI is positioned as an **AI sports analytics + projections platform**, not a betting service, sportsbook, or financial advisor. Subscribers receive statistical projections + confidence scores; betting decisions are theirs to make on third-party books. This positioning is what supports the broad-state launch — the product is information/analytics, not a wagering platform.

**Disclaimer prominence (load-bearing for the posture):** the "not financial or betting advice" wording is rendered prominently on **every subscriber-facing surface** — see §9.4 + §10.6 enforcement. This is the legal underpinning of the broad-state strategy.

**Server-side**: geo-IP capture continues for analytics + future per-jurisdiction policy work, but no state-based access blocks at launch. The previous waitlist flow is removed for v1.

**Restricted-state monitoring**: counsel-flagged jurisdictions (Washington + Hawaii historically DFS-restrictive) surface in the admin dashboard for proactive review if the regulatory landscape shifts. No subscriber-facing impact at launch.

**Canada**: GST/HST collected via Stripe Tax (Canadian provinces enabled). Privacy policy §9.2 item 8 covers cross-border data flow disclosure.

### §9.4 "Not financial or betting advice" disclaimer

Prominently displayed on (load-bearing for §9.3 broad-state launch):
- Landing page (hero footer + every CTA proximity)
- Signup page (above "I agree" checkbox)
- Dashboard footer (always visible — never scrolled off)
- Every pick detail modal
- Every email (including transactional)
- Every push notification (1-line short form)
- ToS section 5

Standard copy:
> SharpAI is an AI sports analytics platform — **not financial or betting advice**. Picks are statistical projections, not guaranteed outcomes. You are solely responsible for any bets you place. Gambling involves financial risk and can be addictive. If you have a gambling problem, call 1-800-GAMBLER (US) or 1-866-531-2600 (ConnexOntario, Canada).

### §9.5 Subscriber agreement on analytical nature

Above + reinforced in onboarding email: "SharpAI predicts. You decide. We don't place bets for you."

### §9.6 Affiliate program terms

Framework §22 supersedes. Top-level rules:
- US-only affiliates v1
- Commission on first paid month only (no recurring) in v1; recurring in v2
- Right-to-ban clause for spam / fraudulent attribution
- 1099 issuance for any affiliate earning >$600/year
- See framework §22.1-22.16 for full terms

### §9.7 Responsible gambling features

- Prominent 1-800-GAMBLER link in footer
- "Track your bets" framing encourages awareness, not deeper play
- No "you must bet to use SharpAI" copy ever
- Subscribers can set a bankroll cap in Settings — surfacing that bankroll across the app reinforces responsible sizing

### §9.8 Data retention schedule

| Data class | Retention |
| --- | --- |
| Subscriber identity (auth.users, user_preferences) | Until deletion + 30d grace |
| Bets | Until subscriber deletion |
| pick_history | Permanent (algorithm output, no PII once user_id removed) |
| Subscriptions / invoices | 7 years (tax) |
| Analytics events with user_id | 2 years |
| Analytics events post-deletion (hashed user_id) | 2 years from event date |
| error_log | 90 days |
| run_log | 1 year |
| Email logs | 90 days |

---

## §10 — Brand + copy

### §10.1 SharpAI brand

- Name: SharpAI (post-D-037 rebrand)
- Logo: existing `/public/logo.png` — wordmark + small sigil
- Color palette: zinc-950 background, zinc-800 cards, white text, accent emerald (positive), accent amber (warning), accent rose (negative). Tailwind defaults.
- Typography: system font stack (no custom font load) — performance first

### §10.2 Voice and tone

- Direct, confident, honest. We say "70+ Good Pick," not "could be promising."
- Subscriber-first plain English. No jargon unless explained on hover.
- Never overclaim. "Algorithm scored 92" beats "guaranteed winner." Calibration banner is the truth surface.
- Self-aware about uncertainty. "Confidence 70 means we believe this hits 56% of the time at -110 — break-even is 52.4%, so this has a real edge but isn't a lock."

### §10.3 Email templates

#### §10.3.1 Welcome (post-signup, before checkout)
Subject: "Welcome to SharpAI"
Body: One-line welcome → 7-day trial countdown → "Your first picks are loading" CTA → safety reminder → FAQ link

#### §10.3.2 Trial ending (day 5 of 7)
Subject: "Your SharpAI trial ends in 2 days"
Body: Personal calibration vs algorithm in their window → "Pick a plan to keep your access" CTA → contact link

#### §10.3.3 Payment succeeded
Subject: "Your SharpAI subscription is active"
Body: Receipt details → "What's next" tour → refer-a-friend CTA

#### §10.3.4 Payment failed
Subject: "We couldn't process your SharpAI payment"
Body: Reason (card declined / expired / etc.) → "Update payment method" Stripe portal link → grace period explanation

#### §10.3.5 Refund processed
Subject: "Your SharpAI refund is on the way"
Body: Refund amount → expected days to land → "We'd love your feedback" link

#### §10.3.6 Account deleted (confirmation)
Subject: "Your SharpAI account has been deleted"
Body: Confirmation → data export attachment if requested → "We hope to see you again" copy → no marketing

#### §10.3.7 Daily morning digest (opt-in)
Subject: "Today's SharpAI picks — {{count}} at 70+"
Body: Top 3 picks teaser → calibration banner → "Open Dashboard" CTA

### §10.4 Push notification templates (Phase 2)

- "🔥 New 85+ pick: D. Mitchell points 25.5"
- "Good morning — 12 picks ready"
- "Calibration check: this week's algorithm is hitting 68%"

### §10.5 In-app copy patterns

- Loading states: "Loading picks…" (NOT "Spinning up your data juju")
- Empty states: explicit + helpful. "No 70+ picks yet today — check back at 2pm ET" beats a sad face.
- Error states: explain + offer action. "We couldn't load your bet history. Refresh, or contact support@sharpai.app."
- Confirmation modals: "Delete my account" not "Yes" — verb match the action.

### §10.6 Disclaimer placement (see also §9.3 broad-state posture + §9.4 standard copy)

Hard rule: every page renders the "not financial or betting advice" footer disclaimer. No exceptions, including mobile, including admin views. This is **load-bearing for the §9.3 broad-state launch** — it's what positions SharpAI as analytics + projections rather than wagering advice, and is what counsel signed off on for the all-50-states + Canada posture.

CI gate: an automated lint runs at deploy time (Vercel build step) that greps for the disclaimer string in every rendered HTML route. Missing-disclaimer commits fail the deploy.

Email + push templates carry the disclaimer too — see §10.3 (every email body) and §10.4 (push 1-line short form).

### §10.7 Error boundary fallback UI

```
┌──────────────────────────────────────────────────────────────┐
│ Something went wrong on our end                                │
│                                                                │
│ We've been notified and are looking into it. Try refreshing —  │
│ if the problem persists, email support@sharpai.app.            │
│                                                                │
│ [ Refresh page ]                                               │
└──────────────────────────────────────────────────────────────┘
```

### §10.8 Subscription portal copy

When CEO opens Settings → Manage subscription, Stripe Portal copy is set in Stripe Dashboard. Configured:
- Header logo: SharpAI
- Privacy + ToS links: app links
- Allowed actions: update payment method, cancel, view invoices, switch plan (Phase 2)

---

## §11 — Launch promotional structure

### §11.1 First 50 closed-beta invites (Aug 1 – Sept 30, 2026)

Per §14 Q7 (D-196, 2026-05-17): the original "first 100 free week" promo is superseded by a 50-invite closed beta at $49/mo with grandfather migration to $99/mo at Apr 1, 2027 (§11.4).

Mechanics:
- Beta access by invitation only. Two entry paths:
  - **Referral code:** existing beta subscriber shares their `SHARP-XXXX` code (per §1.13) — referred friend lands on `/beta-access?invite=SHARP-XXXX`. Validated server-side against `referral_codes`; if active, subscriber proceeds to a closed-beta Stripe Checkout for `pro_beta_49`.
  - **Waitlist approval:** unauth visitors join `/waitlist` form (email + state); CEO reviews + invites in batches. Approved waitlist signups receive a single-use invite code by email that resolves the same `/beta-access?invite=<code>` flow.
- Beta-cohort tracked via `promotional_grants` row with `grant_type='closed_beta_aug2026'`, `granted_at = signup_time`, `expires_at = '2027-05-01'` (matches the §11.4 grandfather end date).
- Implementation: `stripe-webhook` handler on `customer.subscription.created` for `pro_beta_49` — if no `promotional_grants` row exists yet for the user, insert one keyed on `(user_id, 'closed_beta_aug2026')`. The 7-day trial is BYPASSED for beta signups (subscribers are paying $49/mo from day 1; lower price is the value exchange instead of a free trial).
- Display: Settings page shows "🎉 Closed beta — $49/mo through May 1, 2027. New pricing $99/mo starts at your first renewal after that. [Cancel anytime via portal →]"
- Cap: 50 active `pro_beta_49` subscriptions concurrent. `create-checkout-session` for `pro_beta_49` returns 403 with "Closed beta is full; join the waitlist" when the cap is reached.

### §11.2 Affiliate/referral program (v1 light)

See §1.13 + §9.6. Mechanics:
- Each subscriber gets a `SHARP-XXXX` code on signup (Phase 1 generated by `assign-referral-code` trigger on `auth.users` insert)
- Referred friend uses link → `?ref=SHARP-XXXX` persisted to session → on signup, insert `referrals_made` row with status `pending`
- Friend completes first paid month → status `paying` + insert `referral_credits` for referrer ($20) + apply Stripe coupon to friend ($20 off first month)
- Credits applied to referrer's next invoice automatically (Stripe customer balance)

### §11.3 Twitter/X posting automation

Gated on sustained 70% WR — explicit thresholds:
- 14 consecutive days of rolling-7d 70+ tier WR ≥ 70%
- AND zero §8.5 calibration drift alerts active

When unlocked: a `tweet-daily-picks` cron (jobid 20, daily 11:30 UTC) posts:
- Top 3 picks at 75+ confidence
- Yesterday's results recap

Initially gated off. Unlock via admin toggle in `incident_status`-style flag table.

### §11.4 Grandfather pricing timeline (D-196 Path C, 2026-05-17)

Path C launch sequence supersedes the v1 friend-allowlist grandfather plan ($79 lifetime). New structure:

**Aug 1, 2026 — Closed beta opens.** 50 closed-beta subscribers locked at `pro_beta_49` ($49/mo). Beta access by invitation only per §11.1. NBA Finals + MLB Beta calibration window in progress; beta cohort serves as real-money calibration sample per §13.1.

**Oct 1, 2026 — Public launch.** `pro_monthly_99` ($99/mo) activates for public-flow signups. Existing `pro_beta_49` cohort stays at $49/mo with no change at this point — they're locked in at beta pricing through the grandfather end date.

**Apr 1, 2027 — Grandfather migration begins.**
- 30-day advance notice email goes out 2027-03-01 to every active `pro_beta_49` holder: "Your beta pricing ends May 1, 2027. New pricing $99/mo unless you cancel via your Stripe portal."
- Settings page banner for beta cohort flips to: "Your beta pricing ends {{end_date}}. New pricing $99/mo unless you cancel."
- Stripe webhook handler on `invoice.upcoming` (preview event, ~5 days before each invoice) checks: if `subscriptions.plan_id = 'pro_beta_49'` AND `current_period_end > '2027-04-01'`, call `stripe.subscriptions.update({ items: [{ price: 'pro_monthly_99' }], proration_behavior: 'none' })` so the NEXT charge lands at $99.
- Cancel-anytime window is fully respected — subscribers retain Stripe portal access throughout. Anyone who hits "Cancel subscription" before the renewal lands at $99 keeps their access through `current_period_end` and then drops off.

**Q2 2027 onward — `pro_monthly_129` ($129/mo) for new public subscribers** per the 3-Year Plan Phase 4 pricing escalation. `create-checkout-session` for public-launch flows (no beta invite) returns the `pro_monthly_129` price after 2027-04-01. Existing migrated-from-beta subscribers retain `pro_monthly_99` indefinitely (or until they cancel) — the price escalation hits new acquisitions only.

**Trade-off documented (decision durability):** Option 2 lifetime-grandfather ($49 forever for beta cohort) was considered + REJECTED. The lifetime concession would have lost ~$2,500/mo in MRR over the 12 months following Apr 1, 2027 at the 3-Year Plan M3 scale projection (50 beta subscribers × $50/mo gap × ~85% retained at month-12 of public phase). That MRR loss exceeds the retention math benefit vs natural beta churners; the Apr 2027 6-month grandfather is the right balance between trust preservation + revenue capture. If the M3 trajectory proves softer than projected, the lifetime option can be re-evaluated as a retention lever — but the default plan is migration.

### §11.5 Refund + retention copy

- 7-day no-questions-asked refund on first month (CEO-issued via Stripe Dashboard)
- After first month, refunds case-by-case via support@
- Churn email (post-cancellation): "Sorry to see you go. If you'd ever like to come back, your bet history is preserved — just re-subscribe with the same email."

---

## §12 — Pick presentation (high-leverage subscriber surface)

### §12.1 The five metrics every pick card displays

After research + framework + analytics best practices, the five canonical metrics are:

1. **Confidence + tier label** — "92 · ELITE" — the headline number
2. **Projection vs line** — "Projected 28.1 vs line 25.5" — the most subscriber-intuitive evidence
3. **EV in dollars at recommended stake** — "EV +$8.20 @ $50 stake" — the bottom-line motivator
4. **Kelly recommended stake (capped)** — "Quarter Kelly $50 (5% cap binding)" — converts edge to action
5. **Line shopping summary** — "Hard Rock -110 · Best FanDuel -105" — saves real dollars per bet

Sixth optional metric (shown when relevant, hidden otherwise):
6. **Sanity flag chips** — D-164/165/166/167 flags surfaced as small chips ("◎ coin-flip rate" / "⛒ neg stack 4") — transparency over volume

### §12.2 What's NOT on the pick card

- Full factor breakdown — moved to expanded modal
- AI analysis text — moved to expanded modal
- Pick history for similar picks — moved to expanded modal
- Algorithm version tag — debug info, not subscriber-facing

This is intentional. The card is a 5-second decision surface. The modal is a 30-second study surface.

### §12.3 Sort order

Default: confidence DESC, secondary sort sport ASC (NBA first), tertiary game start time ASC.

Subscriber can re-sort by: confidence, EV, Kelly stake, game time. Filter by: prop type, confidence tier, sport.

### §12.4 Highlight rules (visual emphasis)

- Elite (90+) picks: emerald accent border, bigger card padding
- Strong (80-89): standard card, no special accent
- Good (70-79): standard card
- Lean (60-69): de-emphasized (text-zinc-400) — only shown when filter explicitly includes
- Pick with `unbettable_juice_flag = true`: red "⚠ unbettable juice" chip prevents subscriber from logging the bet without confirmation
- Pick with `negative_stacking_flag = true`: amber chip "neg stack N" — transparency surface
- Pick with `is_secondary_market = true`: hidden by default, surfaced only when "Show all markets" toggle on

### §12.5 Real-time updates

Dashboard re-fetches from `recommendations_cache` every 5 minutes when tab is visible. Uses Supabase real-time subscription on `recommendations_cache` for instant updates (post-launch — current implementation is polling).

### §12.6 Pick freshness

`recommendations_cache.expires_at` set to game start time. Once a game starts, picks for that game are filtered out of Dashboard. Game-in-progress picks may exist (live betting Phase 3) but not in v1.

---

## §13 — Sport coverage at launch (NBA + MLB)

### §13.1 NBA (canonical)

- Algorithm: post-D-186 phase 4 + D-189 w_opp_defense + D-101 verdict labels
- Status: live, calibration ~50% organic post-megadeploy at 70+ tier (D-123 honest number)
- **Two-stage calibration target per §14 Q7 (D-196, 2026-05-17):**
  - **Aug 1, 2026 closed-beta launch:** ≥60% rolling-30d at 70+ tier. Lower threshold than public-launch target reflects beta cohort's role as the real-money calibration window (lower price + transparent calibration updates = appropriate expectation calibration).
  - **Aug 1 – Sept 30 closed-beta verification window:** calibration tracked daily; beta subscribers receive weekly transparency updates. **Safety gate:** if 70+ tier WR falls below 55% for 14 consecutive days during the beta period, beta pricing is extended past Apr 1, 2027 AND public launch is postponed past Oct 1, 2026 per §8.5 calibration-drift alert protocol. CEO §19.3 required to override the safety gate.
  - **Oct 1, 2026 public launch:** ≥65% rolling-30d at 70+ tier required. Two-month verification window between Aug 1 and Oct 1 is the proof window — public-phase $99/mo pricing anchored against demonstrated calibration not promised calibration.
- Key remaining work to launch:
  - Calibration drift fix (Tier 1-4 plan in framework §15.8)
  - Tier 4 #11 tier-aware scoring (§4.10)
  - Auto-optimizer re-enable (§4.6)
  - §15.1 critical bugs C7, C8, C13 (algorithm losing money + optimizer ≠ production + dead factors)

NBA regular season returns October 2026 — alignment between NBA tip-off + the §14 Q7 public-launch date is intentional (NFL Week 1 + NBA tip-off both feed the Oct 1 public launch story). Algorithm tuning continues during NBA Finals (May 30 – June 16 window), MLB Stretch (July-September), and the closed-beta calibration window (Aug 1 – Sept 30).

### §13.2 MLB (Beta at launch per CEO §14 Q6 decision, D-192-A.1, 2026-05-16)

**Decision**: MLB ships as a **Beta sport at Aug 1 launch**, not deferred to October. Picks visible to subscribers but flagged "Beta — algorithm learning" on every surface (Dashboard pick card, pick detail modal, email, push). WR target during Beta period: **≥60%** at 70+ tier (relaxed vs NBA's 65% target — explicit subscriber-trust accommodation for a calibrating sport). Full algorithm parity with NBA targeted by **October 2026** (NBA preseason restart window) — at which point the Beta flag drops and MLB joins the canonical sport-coverage set.

**Beta surface treatment (load-bearing for subscriber trust):**
- Pick card: 'Beta · MLB' chip in addition to tier badge ("Beta · 82 · STRONG")
- Pick detail modal: explicit Beta banner — "MLB is in Beta — our algorithm is still calibrating. Track these picks alongside NBA picks, but expect more variance until October parity."
- Email digest: MLB picks grouped under "MLB (Beta)" subhead, NBA under "NBA"
- Calibration banner (§1.4): MLB has its own banner row separate from NBA, e.g. "MLB Beta calibration: 58% rolling-30d (target 60%)"
- Performance page: MLB has its own tier table; sport filter present so subscribers can isolate
- Sanity flags fire same as NBA (§4-style) — coin_flip, negative_stacking, unbettable_juice all rendered

**Two-layer beta framing during Aug 1 – Sept 30, 2026 closed-beta window (D-196, 2026-05-17):** subscribers on the `pro_beta_49` cohort see BOTH the "Closed Beta" platform-level indicator (cohort posture, $49/mo, calibration transparency per §13.1) AND the "Beta · MLB" sport-level indicator on MLB picks. The two beta layers serve different purposes and are not collapsed — Closed Beta communicates the platform's invitation-only + price-locked + calibration-window status; Beta · MLB communicates the sport's specific calibration-still-converging status. Settings page surfaces both clearly under separate Status sections. After Oct 1, 2026, the Closed Beta indicator drops for subscribers (replaced by the standard subscription panel), but the Beta · MLB sport-level chip persists until MLB hits the Oct 2026 parity exit gate.

**Beta period scope:**
- Active: Aug 1 launch → Oct 2026 NBA preseason restart
- Volume: MLB regular season runs through Sept 28, postseason through end of Oct
- WR floor enforcement: §8.5 calibration-drift alerts adapted — MLB **AMBER** fires below 60% (not 65% NBA threshold), **RED** below 55%
- Beta-to-canonical exit gate: ≥60% rolling-30d 70+ WR for 14 consecutive days AND zero open critical calibration drift alerts AND CEO §19.3 approval. Same shape as NBA's framework §15.8 promotion gate, just lower numeric thresholds.

**Implementation lift to get from DORMANT → Beta-ready by Aug 1:**
- Replace v0 pitcher-strikeouts-only with multi-factor scoring (pitcher K-rate, opposing batter K-rate, ballpark factor, umpire K%, weather, batting-order pos)
- Add batter props (HR, hits, total bases, RBIs) — Beta launch covers pitcher strikeouts + batter HR + batter hits at minimum; remaining props phased in
- Wire to MLB Stats API + BDL Baseball
- Apply §1.17 schema audit + §1.12 verification + D-118 calibration loop on every shipped sub-piece
- Beta starts as soon as calibration baseline is established (first ~4 weeks of organic post-deploy picks produce the baseline that subsequent calibration-drift alerts reference)

This is the autonomous loop's largest workstream between now and Aug 1 — see /docs/loop/criteria/mlb_beta.md (Step B.1 deliverable) for the per-sub-piece criteria.

### §13.3 NFL (build effort, deferred flag if Aug 1 too tight)

- Currently no code. NFL preseason starts August 2026; regular season Sept.
- If Aug 1 launch ships with NBA off-season + MLB live, NFL can launch September 7 (Week 1) as v1 sport-coverage expansion.
- Build scope: ~80% MLB pattern reuse, NFL-specific scoring + data source (NFL Stats API).
- Decision gate: if NBA + MLB calibration solid by July 15, start NFL. Else defer.

### §13.4 NHL (deferred, no launch dependency)

- Deferred to 2027. No build effort allocated.

---

## §14 — CEO architectural decisions log (RESOLVED — D-192-A.1, 2026-05-16)

All six §14 questions resolved by CEO on 2026-05-16. Decisions encoded throughout the architecture document at the relevant sections; this log preserves the decision history for auditability.

### Q1 — Stripe vs Stripe + LemonSqueezy? — **RESOLVED: Stripe direct + Stripe Tax**

**Decision:** Stripe direct payments + Stripe Tax for jurisdiction handling. No merchant-of-record provider (LemonSqueezy ruled out).
**Rationale:** Lower fees, fewer moving parts, Stripe Tax covers US states + Canadian GST/HST adequately for the §9.3 broad-state + Canada launch posture.
**Encoded at:** §6.2.1 product config, §9.3 state availability (Canada GST/HST line).

### Q2 — Email provider: Resend, Postmark, or SendGrid? — **RESOLVED: Resend**

**Decision:** Resend for all transactional + notification email.
**Rationale:** Cleanest API, React templates align with our codebase, sufficient deliverability for launch-scale volume.
**Encoded at:** §8.2 (notify() critical-severity email leg), §8.8 transport, §10.3 templates.

### Q3 — Sentry: Team plan or self-hosted? — **RESOLVED: Sentry Team plan**

**Decision:** Sentry Team plan ($26/mo, 50K events/mo, 30d retention) at launch.
**Rationale:** Ops burden of self-hosted not justified pre-1000-subscribers.
**Re-evaluation trigger:** Revisit at 1000+ subscribers (volume + retention sufficient?).
**Encoded at:** §8.1.1 + §8.1.2 (DSN config), §8.2 retention line.

### Q4 — Mobile app — defer or v1? — **RESOLVED: PWA v1, native deferred**

**Decision:** PWA + add-to-homescreen prompt in v1. Native iOS/Android deferred to post-1000-subscriber milestone.
**Rationale:** Architecture already PWA-capable (responsive, magic-link auth works on mobile). Native = 3-6 months extra work; not justified pre-launch.
**Encoded at:** §1 product surfaces (mobile rules sub-screen), §5 infrastructure (no native build pipeline at v1).

### Q5 — State availability scope at launch — **RESOLVED: Broad launch — all 50 US states + Canada**

**Decision:** Launch in **all 50 US states + Canada at v1**. NOT the cautious FL + TX + TN + NV + MS + IA + IN list previously recommended.
**Rationale:** Position SharpAI as an **AI sports analytics + projections platform**, NOT a betting service or financial advisor. Disclaimer prominence (§9.4 + §10.6) is load-bearing for this posture — it's what makes the broad-state launch defensible.
**Posture rule:** "Not financial or betting advice" disclaimer renders on every subscriber-facing surface — landing, signup, dashboard footer, every pick modal, every email, every push, ToS section 5. CI-gated at deploy (§10.6).
**Re-evaluation trigger:** Counsel-flagged jurisdictions (Washington, Hawaii historically DFS-restrictive) surface in admin dashboard for proactive review if regulatory landscape shifts.
**Encoded at:** §9.1 ToS eligibility (rewrote from "21+, US residents, state-restricted" to "18+, US + Canada, not state-restricted at launch"), §9.2 privacy policy item 8 (rewrote "US-only" → "US + Canada"), §9.3 (full rewrite to broad-state posture), §9.4 (disclaimer copy updated to lead with "not financial or betting advice" + added Canadian helpline), §10.6 (placement reinforced + CI gate).

### Q6 — MLB launch posture — **RESOLVED: Beta at launch**

**Decision:** MLB ships as a **Beta sport at Aug 1 launch**. Picks visible to subscribers but flagged "Beta — algorithm learning" on every surface. WR target during Beta period: ≥60% at 70+ tier (relaxed vs NBA's 65%). Full algorithm parity targeted by October 2026 (NBA preseason restart).
**Rationale:** Multi-sport story strengthens launch positioning; Beta flag protects subscriber trust by signaling calibration-in-progress; lower WR threshold during Beta sets honest expectations.
**Encoded at:** §13.2 (full rewrite from "DORMANT, rebuild required" → "Beta at launch" with Beta surface treatment + exit gate + implementation lift), §8.5 (calibration-drift alerts adapted with MLB-specific 60%/55% thresholds), §1.4 (calibration banner gets MLB row), §12 (pick card "Beta · MLB" chip rule).

### Q7 — Launch phase structure — **RESOLVED 2026-05-17 (D-196): Two-phase Path C launch**

**Decision:** Two-phase launch sequence with grandfather migration.

| Phase | Date | Price ID | Cohort | Notes |
| --- | --- | --- | --- | --- |
| Closed beta | Aug 1, 2026 | `pro_beta_49` ($49/mo) | 50 invited subscribers | NBA Finals + MLB Beta + algorithm calibration window |
| Public launch | Oct 1, 2026 | `pro_monthly_99` ($99/mo) | Public flow | NFL Week 1 + NBA tip-off; full sport coverage; 7-day trial |
| Grandfather migration | Apr 1, 2027 | `pro_beta_49` → `pro_monthly_99` | Beta cohort | 30-day advance notice + cancel-anytime window respected |
| New-public price escalation | Q2 2027 onward | `pro_monthly_129` ($129/mo) | New public subscribers only | Per 3-Year Plan Phase 4; migrated-from-beta retain $99 |
| Exit decision | M4-M5 of 3-Year Plan | n/a | n/a | Sale vs continue per M3 trajectory |

**Rationale:** Two-phase launch resolves the August 1 push vs October 1 plan tension. Beta phase de-risks the algorithm by exposing it to real subscribers at lower price + lower expectations (≥60% target vs ≥65% for public launch per §13.1 two-stage gate). Public phase launches with NFL + NBA both live, $99/mo anchored against a proven 2-month track record from beta. Grandfather migration at 6 months preserves trust without forever-lost MRR per §11.4 trade-off documentation. Exit math aligns with 3-Year Plan M3-M5 trajectory.

**Safety gate (per §13.1):** if 70+ tier WR falls below 55% for 14 consecutive days during the Aug 1 – Sept 30 closed-beta window, beta pricing is extended past Apr 1, 2027 AND public launch is postponed past Oct 1, 2026. CEO §19.3 required to override.

**Encoded at:** §1.1 (dual-phase landing page with `launch_phase` config flag + `/beta-access?invite=<code>` variant), §2.3 (`subscriptions.plan_id` enum expanded), §3.3 (`create-checkout-session` validates plan_id against active price catalog at current `launch_phase`), §6.2.1 (full Stripe price catalog + Apr 2027 migration logic), §8.7 (daily CEO digest splits subscriber count beta + public), §11.1 ("First 50 closed-beta invites" replaces "First-100 free week"), §11.4 (full rewrite to grandfather migration timeline + Option 2 lifetime trade-off documentation), §13.1 (two-stage NBA calibration target + safety gate), §13.2 (two-layer beta framing — Closed Beta platform + Beta · MLB sport), §14 (this row).

---

**These decisions are now load-bearing for Step B (autonomous loop framework).** Step B's criteria docs reference them — see /docs/loop/criteria/.

Any subsequent change to these decisions must:
1. Update the affected section(s) in this document
2. Add a new row to this §14 log with new date + rationale
3. Sweep cross-references (especially §9.3 + §13.2 — they're the most cross-referenced).

---

## Appendix A — Cardinal Rules carried into loop work

The 17 Cardinal Rules from framework §1.1–1.17 apply to every loop iteration. Top reminders for the loop:

- **§1.1 NEVER GUESS** — read actual code before proposing changes
- **§1.5 Code verification standard** — grep / read before fixing
- **§1.10 Trace before fixing** — read full chain
- **§1.12 Migration complete = one production cycle observed** — every schema change paired with verification migration
- **§1.13 Tooling availability check** — verify CLI binaries before specifying
- **§1.14 CREATE OR REPLACE VIEW resets security** — re-apply security_invoker + GRANTs
- **§1.15 Honest-stop discipline** — don't fabricate fixes for non-bugs
- **§1.16 Scope-growth ≠ stop signal** — finish in-session if cause is "I found more work," stop only on hard blockers
- **§1.17 Schema change audit protocol** — every column add audits all writer paths

---

## Appendix B — Migration discipline

Every migration file must:
1. Be tracked on disk in `supabase/migrations/` with `YYYYMMDDHHMMSS_<topic>.sql` naming
2. Have a `_preaudit.sql` companion if it modifies multi-writer tables
3. Have a `_verification.sql` companion documenting the §1.12 24h re-check queries
4. NOT be deleted after read — kept on disk per D-138

Migrations that fail in production:
1. Do NOT amend the failed migration file — write a new corrective migration
2. Document the failure in the corrective migration's header comment
3. Run the §1.12 cycle on the corrective migration before declaring resolved

---

## Appendix C — Build + deploy commands

Frontend: `cd ~/Desktop/betting-deploy/betgenius && npm run build && git add -A && git commit -m "..." && git push && vercel --prod`
Edge function: `cd ~/Desktop/betting-deploy/betgenius && git add -A && git commit -m "..." && git push && npx supabase functions deploy <name> --no-verify-jwt`
Rollback: `git revert HEAD && git push && redeploy`

---

## Appendix D — Glossary

- **Tier 1/2/3/4:** framework §15.8 algorithm fix priorities — Tier 1 highest, Tier 4 future
- **D-NNN:** framework §17.4 approved decisions log
- **§1.12 verification:** the discipline of confirming a migration's behavior end-to-end via a paired verification migration that documents the 24h re-check queries
- **C-band:** framework §15.1 critical issue tag (C7, C8, C13, etc.)
- **Failure Mode A/B/C/D:** D-119 algorithm audit failure-mode taxonomy (hot streak chase, etc.)
- **Reference #1/2/3/4:** D-123 calibration cohort taxonomy (synthetic, pre-megadeploy organic, post-megadeploy rescored, post-megadeploy live)
- **MoR:** merchant-of-record (relevant to §14 Q1)
- **CTO:** Claude in this project (per framework header)

---

*End of D-192-A master architecture document.*

*Word count target was 8000-15000 — this draft lands in range.*

*Amended 2026-05-16 as D-192-A.1 — CEO §14 decisions encoded into §6.2.1, §8.2, §9.1, §9.2, §9.3, §9.4, §10.6, §13.2, §14. Six open questions closed; document is now decision-locked input for Step B.*

*Next: Step B autonomous loop framework executes against this spec section by section.*
