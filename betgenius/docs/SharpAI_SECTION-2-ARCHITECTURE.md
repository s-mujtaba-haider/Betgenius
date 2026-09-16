# SharpAI — SECTION 2: ARCHITECTURE (LOCKED MASTER SPEC)

**Document status:** LOCKED. This is the source-of-truth architecture document. Current-state facts are sourced from the actual codebase as of 2026-06-09 (commit `3ba637b`, framework v4.13). Ideal-target sections describe the designed end-state. The gap between them is the open roadmap.

**How to use this doc:**
- Read 2.1 first to orient on what SharpAI is.
- 2.2-2.8 describe the CURRENT state — every fact sourced from a real file path or command. **As of D-495 (2026-06-09) every previously-[UNVERIFIED] item has been resolved** via live DB schema dumps (3 retroactive migrations added) + full cron enumeration + test-framework confirmation; remaining items that are genuinely vendor-dashboard-only carry precise "CEO-confirm: <dashboard URL>" pointers (not bare unknowns).
- 2.9 describes the IDEAL state + the gap as roadmap.
- Future batches execute against this doc. Discrepancies between this doc and reality at batch-start mean THIS DOC is updated FIRST, with the discrepancy filed.

**Last refreshed:** 2026-06-09 by D-494 (post-consolidation close).

---

## 2.1 ARCHITECTURE OVERVIEW

### What SharpAI is

SharpAI is a multi-sport betting analytics platform. The product generates daily algorithm-driven pick recommendations for paid subscribers across NBA and MLB markets, with NFL and NHL planned. Picks are sourced by fetching real-time odds from The Odds API and combining them with player statistics from ESPN + BallDontLie (NBA) and the MLB Stats API + Baseball Savant + Statcast (MLB). A 23-26 factor scoring algorithm — tuned via T11 corpus sweeps (D-364 / D-367 / D-372) — produces a confidence score (0-100) and verdict (Elite / Premier / Strong / Lean / Skip) per pick. AI analysis prose is added via Anthropic Sonnet 4.6 per pick.

The frontend is a React 19 + TypeScript Vite SPA hosted on Vercel. The backend is Supabase (PostgreSQL + Deno edge functions). The frontend talks directly to Supabase via `@supabase/supabase-js` — there is no intermediate API layer.

Subscription is $99-149/month (when launched). Current state is pre-launch: algorithm tuning + the consolidation refactor (D-485 through D-493) just completed; the architecture doc (this file) is the unblocked deliverable that gates the next phase of customer-facing work.

### One-line system flow

```
Odds + stats fetch  →  scoring algorithm  →  unified writer  →  pick_history  +  recommendations_cache
                                                                    ↓                        ↓
                                                              (settled by              (read by Dashboard,
                                                              resolve-picks)            Games, Evaluator,
                                                                                        BetTracker,
                                                                                        Performance)
```

### Current logical system diagram

```
                     ┌─────────────────────────────────────────┐
                     │           DATA SOURCES (paid + free)    │
                     │ ─────────────────────────────────────── │
                     │  The Odds API ($59/100K req/month)      │
                     │  ESPN (player/game stats, free)         │
                     │  BallDontLie (NBA, free tier)           │
                     │  MLB Stats API (free)                   │
                     │  Baseball Savant + Statcast (scraped)   │
                     └────────────┬────────────────────────────┘
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────┐
        │                FETCHING LAYER (17 fns)                  │
        │   fetch-odds[-mlb] · fetch-ballpark-factors             │
        │   fetch-baseball-savant-weekly · fetch-statcast-snapshot│
        │   fetch-mlb-{batter-splits, boxscores, bullpen,         │
        │     pitcher-splits, pitcher-stats, team-stats}          │
        │   fetch-team-advanced-stats · fetch-umpire-stats        │
        │   fetch-weather · snapshot-opp-stats                    │
        │   refresh-mlb-scoreboard-status · register-game-schedule│
        └────────────┬────────────────────────────────────────────┘
                     │
                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │            PRODUCTION SCORING (4 fns)                   │
        │   process-games (NBA cron) ─────┐                       │
        │   process-games-mlb (MLB cron) ─┤                       │
        │   process-single-game-mlb ──────┼─→ writes via writer   │
        │   analyze-pick (UI evaluator) ──┘                       │
        └────────────┬────────────────────────────────────────────┘
                     │  (D-487/488/489 unified write path)
                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │         _shared/pick_history_writer.ts                  │
        │         ── HOUR 0: client-side validation               │
        │            (REQUIRED_FIELDS + sport enum +              │
        │             mlb_market_type CHECK mirror)               │
        │         ── POST to upsert_pick_history RPC              │
        │         ── best-effort failure log to error_log         │
        └────────────┬────────────────────────────────────────────┘
                     │
                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │         POSTGRES (Supabase gzuzuqxvfjszlfclhcfz)        │
        │   pick_history (CHECK + ON CONFLICT — D-204/D-446/      │
        │                  D-481 last-line server defense)         │
        │   pick_history_real (view: WHERE hit IS NOT NULL)        │
        │   wr_by_tier (view: HR by confidence tier)               │
        │   recommendations_cache (8,569+ rows; Dashboard reads)   │
        │   bets · health_status · sonnet_usage_log                │
        │   algorithm_weights · mlb_scoring_progress · error_log   │
        │   + ~30 supporting tables                                │
        └────────────┬────────────────────────────────────────────┘
                     │
            ┌────────┴────────────────────┐
            │                             │
            ▼                             ▼
   ┌─────────────────┐         ┌──────────────────────┐
   │  RESOLUTION     │         │   FRONTEND (Vercel)  │
   │  (resolve-picks │         │  betgenius-eight.    │
   │   settles vs    │         │     vercel.app       │
   │   actuals)      │         │  React 19 SPA        │
   │  audit-         │         │  reads Supabase      │
   │   resolution-   │         │  directly (no API)   │
   │   coverage      │         │  Pages: Dashboard,   │
   └─────────────────┘         │   Games, Evaluator,  │
                               │   BetTracker,        │
                               │   Performance, Stats,│
                               │   Settings, Admin,   │
                               │   Landing, Subscribe │
                               └──────────────────────┘
                     │
        ┌────────────┴────────────────────────────────────┐
        │           MONITORING LAYER (4 fns)              │
        │  sonnet-health-monitor (HOURLY, 6 checks):      │
        │    sonnet_probe / sonnet_400_rate /             │
        │    mlb_cron_freshness / mlb_write_velocity /    │
        │    rpc_failed_rate / pick_history_validation_   │
        │    failed_rate                                  │
        │  health-monitor (generic infra, D-302 era)      │
        │  health-check / dashboard-health-check          │
        │                                                 │
        │  Writes to public.health_status                 │
        └─────────────────────────────────────────────────┘

                     CRON LAYER (pg_cron + pg_net)
                     ┌─────────────────────────────────┐
                     │  37 active jobs                 │
                     │  - process-games crons          │
                     │  - resolve-picks crons          │
                     │  - fetch-* recurring crons      │
                     │  - sonnet-health-monitor (7 * * * *)│
                     │  - daily report / orchestrator  │
                     │  - calibration snapshot         │
                     │  - savant weekly · statcast     │
                     │  - audit-resolution-coverage    │
                     └─────────────────────────────────┘
```

### Why this architecture

- **Direct-to-Supabase frontend** (no intermediate API): minimizes hops, lowers latency, single auth surface (Supabase RLS). Acceptable because every read endpoint is public-by-design (recommendations + pick_history WHERE shown) and every write is gated by service-role keys in edge functions.
- **Edge functions instead of a long-running worker**: fits the cron-driven cycle (one tick = one slice of work + bounded runtime). The 150s Supabase edge timeout (D-472) is the operative ceiling — drives the D-473 sharding pattern in process-games-mlb.
- **Three production writers funneled into one writer helper**: prevents the D-446 / D-480 silent-failure class (one path = one set of rules, one bug fix lands everywhere). Defense-in-depth at 4 layers means even a regression in the helper gets caught at HOUR 1 by health checks.
- **Picks live in two tables (`pick_history` + `recommendations_cache`)** by intentional split: `pick_history` is the audited write target (used for HR/ROI metrics, optimizer training, real-only views); `recommendations_cache` is the Dashboard-render-target with denormalized display columns. The unified writer hits both atomically.
- **Singleton `algorithm_weights` table**: 26-30 weight columns in one row. Optimizers update this row; scorers read it. Trivial to read; trivial to roll back via a single UPDATE.

---

## 2.2 THE TECH STACK

### 2.2.1 Frontend (Vercel + Vite + React)

| Layer | Tech | Version | Where verified |
|---|---|---|---|
| Framework | React | 19.2.0 | `package.json` |
| Build | Vite | 7.3.1 | `package.json` + build log |
| Language | TypeScript | tsc -b (project refs) | `tsconfig.app.json`, `tsconfig.node.json` |
| CSS | Tailwind CSS | 4.x (`@tailwindcss/vite ^4.1.18`) | `package.json` |
| UI primitives | shadcn/ui (New York, dark) | per CLAUDE.md | `src/components/ui/` (currently empty, staging) |
| Charts | Recharts | 3.7.0 | `package.json` |
| Icons | lucide-react | 0.563.0 | `package.json` |
| Error tracking | Sentry React | 10.52.0 | `@sentry/react` |
| Supabase client | @supabase/supabase-js | 2.93.3 | `package.json` |
| Hosting | Vercel | project `betgenius` (URL: betgenius-eight.vercel.app) | `.vercel/project.json` |

**Routing:** NO router library. `App.tsx` is a `useState<Page>` state machine over 5 primary pages (Dashboard, Evaluator, BetTracker, Performance, Stats) with conditional renders for Admin, Games, Landing, Settings, Subscribe.

### 2.2.2 Backend (Supabase + Deno edge functions)

| Layer | Tech | Note | Where verified |
|---|---|---|---|
| Platform | Supabase | project ref `gzuzuqxvfjszlfclhcfz` | CLAUDE.md + every edge fn |
| Runtime | Deno (via Supabase) | `jsr:@supabase/functions-js/edge-runtime.d.ts` | every fn header |
| Database | PostgreSQL | Supabase-managed | migrations |
| Cron | `pg_cron` extension | 37 active jobs | `list_active_crons()` RPC |
| HTTP from SQL | `pg_net.http_post` | every cron uses it | every cron migration |
| Vault | Supabase Vault | `decrypted_secrets` read for `BACKFILL_AUTH_TOKEN` | every cron migration |
| JWT | disabled per fn (`--no-verify-jwt`) | per CLAUDE.md | every deploy command |
| Auth model | service-role key OR vault BACKFILL_AUTH_TOKEN | matches D-313 / D-361 / D-365 pattern | health-check fn header |

### 2.2.3 Database

- **PostgreSQL via Supabase.** Schema lives in 348 migration files. The `supabase/schema.sql` file is a 2.8KB stub from project genesis and is not authoritative for current state.
- 7 tables are confirmed retroactively created (`*_retroactive_*` migrations from D-272): `recommendations_cache`, `algorithm_weights`, `bets` (implied), and others were created out-of-band before formal migration discipline.
- See §2.4 for the full schema.

### 2.2.4 Data APIs

| API | Tier | Cost | Use |
|---|---|---|---|
| The Odds API | 100K req / month | **$59 / month** | Live odds + events for NBA + MLB |
| ESPN | scraped + public endpoints | free | NBA player stats, game logs, injuries |
| BallDontLie API | free tier (no API key needed in deploy commands or fn source) | free | NBA stats supplement |
| MLB Stats API | free public API | free | MLB lineups, scores, schedule, game results |
| Baseball Savant | scraped | free | Statcast metrics for MLB |
| MLB Statcast | scraped | free | Exit velocity, launch angle, pitch tracking |

### 2.2.5 AI

| Use | Model | Rate | Source |
|---|---|---|---|
| MLB pick analysis | Anthropic Sonnet 4.6 (`claude-sonnet-4-6`) | $3/Mtok in, $15/Mtok out | `sonnet_usage_log` default rates |
| NBA player analysis | Anthropic Sonnet 4.6 | (same rate) | `process-games/index.ts:1755` per sonnet_usage_log comment |
| NBA game analysis | Anthropic Sonnet 4.6 | (same rate) | `process-games/index.ts:1825` per sonnet_usage_log comment |
| Orchestrator per-turn | Anthropic Sonnet 4.6 | (same rate) | `orchestrator-execute/index.ts:322` per sonnet_usage_log comment |
| Secondary AI | Google Gemini (`gemini-2.0-flash`) | actively used in `analyze-pick/index.ts:1253` for the UI evaluator path | `generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent` |

**Real Anthropic spend (D-462 measurement):** ~$64/month per CEO console; sonnet_usage_log table (D-463) was added to reconcile measured vs estimated spend at SQL-query level.

### 2.2.6 CI / Build

```
$ npm run build
1. lint:disclaimer    — validates 4 disclaimer surfaces (Landing, Subscribe, AuthGate,
                        ErrorBoundary) carry the §10.6 compliance disclaimer
2. tsc -b             — TypeScript build (project refs)
3. vite build         — production bundle to dist/
```

**Test framework IS configured AND IS used** (resolved D-495). `vitest.config.ts` (D-195 TECH-02 era) sets node environment + setup file `./tests/setup.ts` + include glob `tests/**/*.test.ts` + v8 coverage targeting `_shared/scoring.ts` (thresholds: ≥80% line, ≥75% branch). One active test file: `tests/scoring.test.ts` (pure-function unit coverage for `_shared/scoring.ts` NBA scorer). CLAUDE.md's "No test framework is configured" line is stale — the framework is real; coverage is just narrow (NBA scorer only). Expanding coverage to the writer helper and the MLB scorer is §2.9b.6 + §2.9b.9 (both still valid roadmap items).

Every push to `claude/sports-betting-app-setup-quspT` (main) gates CI via GitHub Actions.

### 2.2.7 Monetary stack (estimated all-in monthly cost)

| Line | Cost | Verified? |
|---|---|---|
| The Odds API (100K plan) | $59 | YES (CLAUDE.md) |
| Anthropic Sonnet 4.6 | ~$64 (current measured) | YES (D-462 CEO console) |
| Vercel hosting | tier in dashboard | CEO-confirm: `vercel.com` usage dashboard (path redacted) |
| Supabase | tier in dashboard | CEO-confirm: `supabase.com/dashboard/project/gzuzuqxvfjszlfclhcfz/settings/billing` |
| Sentry | tier in dashboard | CEO-confirm: `sentry.io` dashboard for the SharpAI org |
| Stripe | per-transaction (~2.9% + $0.30) | depends on revenue |
| BallDontLie | free tier (no API key needed) | inferred from absence of `BALLDONTLIE_API_KEY` in deploy commands / fn source |
| **Confirmed line items** | **~$123/mo** | |
| **All-in estimate** | **$130-200/mo pre-revenue** | |

At launch revenue scale (e.g. 100 subs × $99 = $9,900/mo gross), the marginal cost scales primarily with Sonnet usage + Stripe fees + Supabase tier.

---

## 2.3 FOLDER & FILE ARCHITECTURE

### Frontend (`src/`)

```
src/
├── App.tsx                         (5-page state-machine root)
├── main.tsx                        (entry + Sentry init)
├── index.css                       (Tailwind v4)
├── components/
│   ├── AuthGate.tsx                (PIN-gated wrapper around app)
│   ├── CalibrationSection.tsx
│   ├── ErrorBoundary.tsx           (Sentry + user-friendly fallback)
│   ├── PickCard.tsx                (the pick render unit)
│   ├── SanityChips.tsx             (sanity-check flags on picks)
│   ├── SelectionBiasSection.tsx
│   ├── SportSelector.tsx           (NBA / MLB toggle)
│   ├── SubscriptionBanner.tsx
│   └── ui/                         (shadcn/ui staging — currently empty)
├── hooks/
│   └── useSubscriptionGate.ts      (subscription-state hook)
├── lib/
│   ├── ai_modifier.ts              (Claude-driven confidence modifier client-side)
│   ├── ai_verdict.ts               (verdict resolution helpers)
│   ├── auth.ts                     (auth helpers + PIN gate)
│   ├── confidence.ts               (NBA client-side scoring algo)
│   ├── etDate.ts                   (ET timezone helper)
│   ├── formatGameTime.ts
│   ├── kelly.ts                    (Kelly criterion utils; `sharpai_kelly_fraction` key)
│   ├── kelly_action.ts
│   ├── signup_attribution.ts
│   ├── sport.ts                    (sport selector; `betgenius_user_sport` LS key — see §2.4j)
│   ├── supabase.ts                 (client init)
│   ├── user_preferences.ts         (books + discretionary stake)
│   └── utils.ts                    (general utilities)
├── pages/
│   ├── Admin.tsx                   (PIN-gated admin console)
│   ├── BetTracker.tsx              (user-logged-bet ledger; reads from `bets` table)
│   ├── Dashboard.tsx               (LIVE picks — reads from recommendations_cache)
│   ├── Evaluator.tsx               (single-prop eval flow; calls analyze-pick)
│   ├── Games.tsx                   (game cards w/ spread/total/h2h; D-369/D-370 fix)
│   ├── Landing.tsx                 (unauth landing)
│   ├── Performance.tsx             (HR + ROI viz; reads pick_history_real + wr_by_tier)
│   ├── Settings.tsx                (books selector + preferences)
│   ├── Stats.tsx                   (player stats explorer)
│   └── Subscribe.tsx               (Stripe subscription entry; "SharpAI Pro — $99/mo")
└── types/                          (empty currently)
```

### Backend (`supabase/`)

```
supabase/
├── schema.sql                      (stub 2.8KB — NOT authoritative; see migrations)
├── migrations/                     (348 .sql files; authoritative schema source)
└── functions/
    ├── _shared/                    (21 helper modules, ~9,947 LOC)
    │   ├── pick_history_writer.ts  (254  — THE D-487 unified writer)
    │   ├── scoring.ts              (1237 — NBA scorer)
    │   ├── scoring_mlb_v2.ts       (3286 — active MLB scorer; framework v3.46)
    │   ├── scoring_mlb.ts          (1844 — legacy MLB scorer; still on disk)
    │   ├── anthropic_mlb.ts        (378  — Sonnet integration for MLB picks)
    │   ├── historical_context_router*.ts (3 files; pre-game context fetch)
    │   ├── mlb_weights.ts          (129  — MLB DB-read helper: loadMlbWeightsFromDB reads algorithm_weights row 1 w_mlb_* cols)
    │   ├── mlb_venues.ts           (83   — park factors)
    │   ├── statcast.ts             (250  — Statcast helpers)
    │   ├── sonnet_usage_log.ts     (76   — per-call usage logger)
    │   ├── notify.ts               (251  — notification dispatch)
    │   ├── email.ts                (227  — email templates)
    │   ├── cron_heartbeat.ts       (117  — run_log helpers)
    │   ├── function_lock.ts        (91   — distributed lock)
    │   ├── error_handling.ts       (129  — structured errors)
    │   ├── sentry.ts               (49)
    │   ├── stripe.ts               (53)
    │   └── string_normalize.ts     (74   — name normalization)
    │
    └── <58 function directories>   (each has its own index.ts)
        ├── production scoring (4): analyze-pick, process-games,
        │                            process-games-mlb, process-single-game-mlb
        ├── frontend api (3):       get-live-games, get-player-stats, team-stats
        ├── fetching (17):          fetch-*, snapshot-opp-stats,
        │                            refresh-mlb-scoreboard-status,
        │                            register-game-schedule
        ├── backfill (4):           backfill-bdl-historical, backfill-historical,
        │                            replay-historical-mlb, rescore-backfill-picks
        ├── historical infra (5):   fetch-historical-events-mlb,
        │                            fetch-historical-odds-mlb,
        │                            fetch-historical-outcomes-mlb,
        │                            refresh-historical-outcomes-mlb,
        │                            ingest-catcher-framing-csv
        ├── resolution (2):         audit-resolution-coverage, resolve-picks
        ├── optimizer (4):          optimize-weights-nba, optimize-weights-mlb,
        │                            run-optimizer, run-optimizer-v2
        ├── monitoring (4):         sonnet-health-monitor, dashboard-health-check,
        │                            health-check, health-monitor
        ├── backtest (2):           backtest, backtest-mlb-v3-historical
        ├── orchestration (3):      job-dispatcher, orchestrator-daily-report,
        │                            orchestrator-execute
        ├── payment / email (6):    create-checkout-session, customer-portal-session,
        │                            process-deletion-requests,
        │                            send-trial-ending-emails, stripe-webhook,
        │                            send-daily-digest† (disk-only)
        ├── calibration (1):        write-calibration-snapshot
        └── probes (3, all disk-only†): bdl-injuries-probe,
                                         bdl-player-injuries-probe,
                                         odds-api-injuries-probe

         † 4 disk-only functions NOT deployed to the platform (see §2.5)
```

### Other top-level

```
docs/                  Loop / batch reports (d###_*.md), playbooks,
                        architecture reference (this file)
scripts/               Offline data analysis + algorithm tuning scripts
                        (Python + .mjs).
                        NOT part of the build.
supabase/migrations/   348 migration files — authoritative schema
.vercel/project.json   Vercel project config (projectName: "betgenius" —
                        infra, kept per D-493 rebrand scope)
package.json           name: "sharpai" (post-D-493)
CLAUDE.md              Project instructions for Claude Code
BetGenius_Framework.md Versioned framework + decision history
                        (filename intentionally unchanged per D-493 —
                        renaming would churn 400+ historical doc-trail refs)
```

---

## 2.4 DATABASE SCHEMA

### 2.4a `pick_history` — the canonical pick log

**Original migration:** `supabase/migrations/001_pick_history.sql` (~50 base columns at creation, NBA-focused). 23 separate migration files add columns over time (D-204, D-307, D-446, D-481, etc.).

```sql
CREATE TABLE pick_history (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Player & game context
  player_name     TEXT NOT NULL,
  team            TEXT,
  opponent        TEXT,
  game_time       TEXT,
  is_home         BOOLEAN,

  -- Prop details
  prop_type       TEXT NOT NULL,
  line            NUMERIC NOT NULL,
  pick_side       TEXT NOT NULL,
  odds            INTEGER,

  -- 24 NBA scoring factors (subset shown)
  score_l5            INTEGER,
  score_l10           INTEGER,
  score_season        INTEGER,
  score_floor_ceiling INTEGER,
  ...                                -- see migration 001 for full set

  -- Final output
  confidence      INTEGER NOT NULL,
  verdict         TEXT,           -- 'Elite' | 'Premier' | 'Strong' | 'Lean' | 'Skip'
  ai_analysis     TEXT,           -- Sonnet-generated prose

  -- Outcome (filled by resolve-picks)
  actual_value    NUMERIC,
  hit             BOOLEAN,
  resolved_at     TIMESTAMPTZ,

  -- MLB extensions (D-204+)
  sport               TEXT NOT NULL,    -- 'nba' | 'mlb'
  mlb_market_type     TEXT,             -- see CHECK below
  is_mlb_beta         BOOLEAN,

  -- D-379 audit JSONB (per-factor breakdown)
  breakdown           JSONB,
  ...
);

-- D-481 (2026-06-08) extended CHECK — 10 allowed mlb_market_type values + NULL
ALTER TABLE pick_history
  ADD CONSTRAINT pick_history_mlb_market_type_check CHECK (
    mlb_market_type IS NULL OR mlb_market_type IN (
      -- D-204 originals:
      'pitcher_k', 'batter_hits', 'batter_hr', 'batter_total_bases',
      'batter_rbis', 'game_side', 'game_total',
      -- D-474 / D-475 / D-476 additions:
      'batter_strikeouts', 'batter_runs_scored', 'pitcher_outs'
    )
  );
```

**Required (NOT NULL) per the unified writer** (`_shared/pick_history_writer.ts` REQUIRED_FIELDS):
- `player_name`, `prop_type`, `line`, `pick_side`, `odds`, `confidence`, `verdict`, `sport`

### 2.4b `pick_history_real` (view)

```sql
-- D-477 hardened view; canonical real-only filter
CREATE OR REPLACE VIEW public.pick_history_real AS
SELECT * FROM public.pick_history
WHERE hit IS NOT NULL;
```

The documented hit-rate / ROI surfaces (Performance.tsx, optimizer training, framework HR metrics) all SHOULD use this view. Excludes:
- Unresolved picks (no outcome yet)
- Synthetic / dry-run / mint rows (D-358 / D-359 history)

Source: `supabase/migrations/20260607000008_d477_wr_view_harden.sql`.

### 2.4c `wr_by_tier` (view)

Used by Performance.tsx to render HR-by-confidence-tier. Originally D-469; hardened in D-477. Tiers: Elite (≥80), Premier (≥75), Strong (≥70), Lean (≥65), Skip (<65).

### 2.4d `upsert_pick_history` (RPC)

`supabase/migrations/20260509000013_c40_upsert_pick_history_rpc.sql` (original) + `20260515000001_d172a_upsert_pick_history_full_column_set.sql` (full column set). This is the canonical write RPC; the unified writer POSTs against it.

Uses `jsonb_populate_record` to accept any pick_history column flexibly. The RPC enforces server-side CHECK + ON CONFLICT.

### 2.4e `recommendations_cache`

`supabase/migrations/20260520000003_d272_inf3_retroactive_recommendations_cache.sql` (retroactive — table existed before formal migration discipline).

- **8,569+ rows** as of 2026-05-20.
- ~100 columns mirroring pick_history (denormalized for fast Dashboard render).
- Dashboard.tsx reads from this table directly via `@supabase/supabase-js`.
- Written by process-games (NBA) + process-games-mlb (MLB) in the same write tick as pick_history.

### 2.4f `algorithm_weights`

`supabase/migrations/20260520000005_d272_inf3_retroactive_algorithm_weights.sql`.

```sql
CREATE TABLE algorithm_weights (
  id                 INTEGER PRIMARY KEY DEFAULT 1,    -- singleton
  updated_at         TIMESTAMPTZ DEFAULT NOW(),

  -- 26 NBA factor weights
  w_l5               NUMERIC DEFAULT 1.0,
  w_l10              NUMERIC DEFAULT 0.0,
  w_season           NUMERIC DEFAULT 1.75,
  w_floor_ceiling    NUMERIC DEFAULT 1.5,
  w_recent_form      NUMERIC DEFAULT 1.5,
  w_home_away        NUMERIC DEFAULT 0.0,
  w_minutes_trend    NUMERIC DEFAULT 0.0,
  w_pace             NUMERIC DEFAULT 0.5,
  w_opp_defense      NUMERIC DEFAULT 0.0,
  w_rest             NUMERIC DEFAULT 0.0,
  w_b2b              NUMERIC DEFAULT 2.25,
  w_prop_type        NUMERIC DEFAULT 0.25,
  w_z_score          NUMERIC DEFAULT 0.25,
  w_role_change      NUMERIC DEFAULT 2.0,
  w_vig_filter       NUMERIC DEFAULT 0.0,
  w_usg_rate         NUMERIC DEFAULT 1.0,
  w_regression       NUMERIC DEFAULT 1.0,
  w_market_conf      NUMERIC DEFAULT 2.0,
  w_ha_split         NUMERIC DEFAULT 0.0,
  w_minutes_floor    NUMERIC DEFAULT 2.5,
  w_consistency      NUMERIC DEFAULT 1.0,
  w_stale_data       NUMERIC DEFAULT 2.25,
  w_player_injury    NUMERIC DEFAULT 0.75,
  w_low_min_risk     NUMERIC NOT NULL DEFAULT 1.0,
  w_blowout_risk     NUMERIC NOT NULL DEFAULT 1.0,
  w_line_movement    NUMERIC NOT NULL DEFAULT 1.0,

  -- Backtest summary
  backtest_win_pct   NUMERIC,
  backtest_roi       NUMERIC,
  backtest_picks     INTEGER
);
```

Consumed by `_shared/scoring.ts:loadWeightsFromDB()` (NBA path) AND by `_shared/mlb_weights.ts:loadMlbWeightsFromDB()` (MLB path — D-340/T6, May 2026). The MLB scorer reads 54 unique `w_mlb_*` columns from the same `algorithm_weights` row 1 every cron tick (`process-games-mlb/index.ts:2587-2588` → `setMlbWeights()` mutates module-scope W/W_BATTER/W_GAME in `scoring_mlb_v2.ts:2800`). The MLB optimizer (`optimize-weights-mlb`) PATCHes the same row at `optimize-weights-mlb/index.ts:426-427`. **No code change or redeploy is required to tune MLB weights** — same model as NBA. Defaults in `getMlbDefaultWeights()` are the fallback for DB-unreachable failure modes only. _(The D-494 architecture doc incorrectly claimed MLB weights were TypeScript constants — that was wrong, corrected by D-497-R.)_

### 2.4g `sonnet_usage_log`

`supabase/migrations/20260605000002_d463_sonnet_usage_log.sql`. Per-Anthropic-call ground-truth spend table:

```sql
CREATE TABLE sonnet_usage_log (
  id                          bigserial PRIMARY KEY,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  source                      text NOT NULL,    -- 'mlb_pick' | 'nba_player' | 'nba_game' | 'orchestrator'
  model                       text NOT NULL,    -- e.g. 'claude-sonnet-4-6'
  input_tokens                integer NOT NULL,
  output_tokens               integer NOT NULL,
  cache_creation_input_tokens integer NOT NULL DEFAULT 0,
  cache_read_input_tokens     integer NOT NULL DEFAULT 0,
  input_rate_usd_per_mtok     numeric NOT NULL,  -- Sonnet 4.6 default: 3.00
  output_rate_usd_per_mtok    numeric NOT NULL   -- Sonnet 4.6 default: 15.00
);
```

Best-effort writes (try/catch swallow + log) per D-463; usage-logging failure must never break pick generation.

### 2.4h `health_status`

`supabase/migrations/20260606000002_d459_sonnet_health.sql`. Append-only health-check log:

```sql
CREATE TABLE health_status (
  id          bigserial PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  check_name  text NOT NULL,    -- e.g. 'sonnet_probe', 'mlb_cron_freshness', etc.
  status      text NOT NULL CHECK (status IN ('ok','warn','fail','info')),
  detail      text NOT NULL,
  metadata    jsonb DEFAULT '{}'::jsonb
);
```

Indexes: `created_at DESC`, `(check_name, created_at DESC)`, `(status) WHERE status IN ('warn','fail')`.

Written hourly by `sonnet-health-monitor` (1 row per `(check_name, run)` × 6 checks = 6 rows per hour = ~144 rows/day).

### 2.4i `mlb_scoring_progress`

`supabase/migrations/20260607000001_d473_mlb_scoring_progress.sql`. D-473 cron-shard state:

```sql
CREATE TABLE mlb_scoring_progress (
  id          bigserial PRIMARY KEY,
  game_date   text NOT NULL,    -- YYYYMMDD
  game_pk     integer NOT NULL, -- MLB Stats API gamePk
  scored_at   timestamptz NOT NULL DEFAULT now(),
  tick_label  text              -- e.g. function invoke timestamp tag
);
CREATE UNIQUE INDEX uniq_mlb_scoring_progress_date_gamepk
  ON mlb_scoring_progress(game_date, game_pk);
```

Used by process-games-mlb to shard game scoring across cron ticks (N=2 unscored games per tick, sorted by gameTime ASC). Fix for D-472's 142s near-timeout near the 150s Supabase edge ceiling. D-502 (2026-06-10) kept N=2 (proven-safe envelope) and raised cron cadence from `5,35 17-23,0-4 * * *` (every 30 min) to `*/5 17-23,0-4 * * *` (every 5 min) so a 15-game slate clears in ⌈15/2⌉=8 ticks × 5 min = 40 min instead of 4 hours — see d502_applied.md.

### 2.4j Previously-undocumented tables (resolved by D-495 — schema-as-code complete)

D-494 flagged 4 tables as `[UNVERIFIED]` because no creation migration was found. D-495 dumped each from the live database via a read-only RAISE NOTICE inspection migration and added retroactive `CREATE TABLE IF NOT EXISTS` migrations matching the live schema exactly (all 3 applied as no-ops against production — confirmed via `NOTICE 42P07 ... already exists, skipping`).

#### `error_log` — 36,283 rows

```sql
CREATE TABLE public.error_log (
  id              bigserial PRIMARY KEY,
  created_at      timestamptz DEFAULT now(),
  function_name   text NOT NULL,
  phase           text,
  error_type      text,
  error_message   text NOT NULL,
  context         jsonb DEFAULT '{}'::jsonb,
  resolved        boolean DEFAULT false
);
```

Append-only structured error log. Written by every edge fn via `_shared/error_handling.ts` + the writer's `logFailure` path (D-487). Read by `sonnet-health-monitor`'s `rpc_failed_rate` (D-481) + `pick_history_validation_failed_rate` (D-489) checks. Retroactive migration: `20260609000005_d495_retroactive_error_log.sql`.

#### `bets` — 7 rows (pre-launch volume)

```sql
CREATE TABLE public.bets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id         uuid,
  player_name     text NOT NULL,
  prop_type       text NOT NULL,
  line            numeric NOT NULL,
  pick_side       text NOT NULL,
  odds            integer NOT NULL,
  stake           numeric NOT NULL,
  book            text DEFAULT 'hard_rock'::text,
  status          text DEFAULT 'pending'::text,
  result_value    numeric,
  payout          numeric,
  placed_at       timestamptz DEFAULT now(),
  settled_at      timestamptz,
  user_id         uuid,
  sport           text NOT NULL DEFAULT 'nba'::text
);
CREATE INDEX idx_bets_pick_id ON public.bets(pick_id) WHERE pick_id IS NOT NULL;
CREATE INDEX idx_bets_status  ON public.bets(status);
CREATE INDEX idx_bets_user_id ON public.bets(user_id);
```

User-logged bet ledger. Written by `BetTracker.tsx` via the Supabase client. Settled by `resolve-picks` against actuals. `pick_id` references the recommendations_cache or pick_history row the user followed. Retroactive migration: `20260609000006_d495_retroactive_bets.sql`.

#### `run_log` — 3,678 rows

```sql
CREATE TABLE public.run_log (
  id                  bigserial PRIMARY KEY,
  created_at          timestamptz DEFAULT now(),
  function_name       text NOT NULL,
  duration_ms         integer,
  games_found         integer DEFAULT 0,
  props_fetched       integer DEFAULT 0,
  players_loaded      integer DEFAULT 0,
  players_skipped     integer DEFAULT 0,
  opp_stats_found     integer DEFAULT 0,
  opp_stats_failed    integer DEFAULT 0,
  props_scored        integer DEFAULT 0,
  recommendations     integer DEFAULT 0,
  ai_generated        integer DEFAULT 0,
  ai_failed           integer DEFAULT 0,
  errors_count        integer DEFAULT 0,
  status              text DEFAULT 'success'::text,
  notes               text,
  cache_write_errors  integer DEFAULT 0
);
```

Per-cron-fn-tick observability table written by `_shared/cron_heartbeat.ts`. Read by `sonnet-health-monitor`'s `mlb_cron_freshness` check (looks for last `process-games-mlb` row vs expected interval) and `health-monitor`'s generic-infra checks. Retroactive migration: `20260609000007_d495_retroactive_run_log.sql`.

#### `notifications_log` (NOT `notification_log` — name correction)

D-494 named this `notification_log` (singular). The actual table is plural `notifications_log` and has a creation migration since `20260506000007_notifications_log_refactor.sql` (the singular table was DROP'd in that same May 2026 refactor). The stale singular name persisted only in a doc comment inside `20260606000002_d459_sonnet_health.sql:13`.

```sql
CREATE TABLE public.notifications_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  severity        text NOT NULL CHECK (severity IN ('critical','warning','info')),
  title           text NOT NULL,
  message         text NOT NULL,
  metadata        jsonb,
  delivered_via   text CHECK (delivered_via IN ('sms','log','both')),
  twilio_response jsonb,
  twilio_error    text
);
CREATE INDEX idx_notifications_log_created       ON notifications_log(created_at DESC);
CREATE INDEX idx_notifications_log_severity      ON notifications_log(severity, created_at DESC);
CREATE INDEX idx_notifications_log_title_created ON notifications_log(title, created_at DESC);
```

6 live rows (low alert volume). SMS path via Twilio when `delivered_via='sms'`; the `notify()` helper uses `idx_notifications_log_title_created` for rate-limiting (15 min critical / 60 min warning per the migration comment).

#### `cron.job` / `cron.job_run_details`

System tables provided by the `pg_cron` extension (not user-created). NOT a gap.

### 2.4k localStorage keys (client-side persisted data)

Treated as DATA identifiers (analogous to DB columns) per D-493 rebrand scope. Renaming = wipe existing users' preferences.

| Key | Set/read at | Purpose | Brand-asymmetry |
|---|---|---|---|
| `betgenius_user_sport` | `src/lib/sport.ts:15`; read in Dashboard, Games, Evaluator, BetTracker, Performance | User-selected sport (NBA / MLB) | `betgenius_*` (preserved per D-493) |
| `betgenius_user_books` | `src/lib/user_preferences.ts:41`; read in Settings, Dashboard, Evaluator | User-selected sportsbooks | `betgenius_*` (preserved per D-493) |
| `betgenius_recommendations` | `src/pages/Dashboard.tsx:432` (legacy backward-compat) | Older recommendations cache | `betgenius_*` (preserved per D-493) |
| `betgenius_recommendations_${sport}` | `src/pages/Dashboard.tsx:184` | Per-sport recommendations cache | `betgenius_*` (preserved per D-493) |
| `sharpai_kelly_fraction` | `src/lib/kelly.ts:88` | Kelly fraction selection | `sharpai_*` (new — added post-rebrand) |
| `sharpai_betting_bankroll` | `src/lib/kelly.ts:126` | Bankroll size | `sharpai_*` (new) |
| `sharpai_discretionary_stake` | `src/lib/user_preferences.ts:56` | Discretionary stake amount | `sharpai_*` (new) |

The split is intentional: old keys preserved (user data safe), new keys take the SharpAI prefix. A future migration could read-old/write-new for a transition period — see §2.9.

---

## 2.5 EDGE FUNCTION ARCHITECTURE

### 2.5a Function inventory (58 on disk; 54 deployed)

`supabase/functions/` contains **58 function directories** as of D-494. Of those, **54 are actively deployed to the Supabase platform** (D-492-B reconciled). The **4 not-deployed** are intentionally disk-only:

| Disk-only fn | Status | Notes |
|---|---|---|
| `bdl-injuries-probe` | Disk only | D-485 marked as one-shot probe; should be deleted next cleanup batch |
| `bdl-player-injuries-probe` | Disk only | Same as above |
| `odds-api-injuries-probe` | Disk only | Same as above |
| `send-daily-digest` | Disk only | Deprecated digest fn. Was wired to a daily cron (jobid=24) that fired against a 404 every day — UNSCHEDULED via D-496 migration `20260609000008`. Now confirmed harmless. |

### 2.5b Function role groupings

(re-derived from `docs/loop/reports/d485_grouped.md` taxonomy + current state)

| Role | Count | Functions |
|---|---|---|
| Production Scoring | 4 | analyze-pick, process-games, process-games-mlb, process-single-game-mlb |
| Frontend API | 3 | get-live-games, get-player-stats, team-stats |
| Fetching | 17 | (see §2.1 diagram + §2.3 tree) |
| Backfill | 4 | backfill-bdl-historical, backfill-historical, replay-historical-mlb, rescore-backfill-picks |
| Historical Infrastructure | 5 | fetch-historical-{events,odds,outcomes}-mlb, refresh-historical-outcomes-mlb, ingest-catcher-framing-csv |
| Resolution | 2 | audit-resolution-coverage, resolve-picks |
| Optimizer | 4 | optimize-weights-nba (was d367), optimize-weights-mlb (was d372), run-optimizer, run-optimizer-v2 |
| Monitoring | 4 | sonnet-health-monitor (was d459), dashboard-health-check, health-check, health-monitor |
| Backtest | 2 | backtest, backtest-mlb-v3-historical |
| Orchestration | 3 | job-dispatcher, orchestrator-daily-report, orchestrator-execute |
| Payment / Email | 6 | create-checkout-session, customer-portal-session, process-deletion-requests, send-trial-ending-emails, stripe-webhook, send-daily-digest† |
| Calibration | 1 | write-calibration-snapshot |
| Probes (disk-only) | 3 | bdl-injuries-probe†, bdl-player-injuries-probe†, odds-api-injuries-probe† |
| **Total** | **58** | (54 deployed; 4 marked † disk-only) |

### 2.5c The unified write path (D-487 / D-488 / D-489)

The **single most important architectural artifact** in SharpAI: 3 production writers route their pick_history writes through one helper.

```
                ┌──────────────────────────────┐
                │   process-games (NBA cron)   │
                │   process-games-mlb (MLB)    │ ──┐
                │   analyze-pick (UI/admin)    │   │
                └──────────────────────────────┘   │
                                                   │
                                                   ▼
                ┌─────────────────────────────────────────────┐
                │  _shared/pick_history_writer.ts (D-487)     │
                │  ─────────────────────────────────────────  │
                │  writePickHistory(payload, opts):           │
                │    1. validatePayload(p) → [errors]         │
                │       - REQUIRED_FIELDS not null            │
                │       - sport in {nba,mlb}                  │
                │       - confidence in [0,100]               │
                │       - mlb_market_type in ALLOWED set      │
                │       - types match                         │
                │    2. if errors → return CLIENT_VALIDATION  │
                │    3. POST upsert_pick_history RPC          │
                │    4. if RPC fails → log to error_log       │
                │       + return RPC_FAILED with pgCode       │
                │  ─────────────────────────────────────────  │
                │  return { ok: true } |                      │
                │         { ok: false, code: 'CLIENT_VALIDATION', errors } | │
                │         { ok: false, code: 'RPC_FAILED', status, body, pgCode? } │
                └─────────────────────────────────────────────┘
                                                   │
                                                   ▼
                ┌─────────────────────────────────────────────┐
                │  Postgres upsert_pick_history RPC           │
                │  ─────────────────────────────────────────  │
                │  - jsonb_populate_record (flexible columns) │
                │  - ON CONFLICT clause (idempotency)         │
                │  - CHECK constraint (D-481 10-value set)    │
                │  - NOT NULL constraints                     │
                └─────────────────────────────────────────────┘
                                                   │
                                                   ▼
                                            pick_history table
                                            recommendations_cache (separate write)
```

**Why this matters:** before D-487, each writer had its own validation logic (or none). The D-446 bug (silent pick loss from a NULL field) and the D-480 bug (silent pick loss from a CHECK violation on a new market type) both happened because one writer didn't know what another writer's rules were. After D-487/488/489, ANY constraint change updates ALLOWED_MLB_MARKET_TYPES + REQUIRED_FIELDS in one place; every writer benefits; failure logging is uniform; HOUR 1 health checks have a single error_type to count.

### 2.5d Cron topology — all 37 active jobs (verified D-495)

Full enumeration sourced from a live `SELECT jobid, jobname, schedule, command FROM cron.job ORDER BY jobid` query (via D-495's RAISE NOTICE inspection migration; jobid numbering has gaps where since-unscheduled jobs left holes).

| jobid | jobname | schedule (UTC) | Target fn |
|---|---|---|---|
| 1 | resolve-picks-daily | `0 15 * * *` | resolve-picks |
| 2 | resolve-picks-cleanup | `30 15 * * *` | resolve-picks |
| 3 | resolve-picks-nightly | `30 5 * * *` | resolve-picks |
| 6 | fetch-odds-every-15min | `*/15 * * * *` | fetch-odds |
| 7 | fetch-odds-tomorrow | `0 */2 * * *` | fetch-odds |
| 9 | process-games-progressive | `*/15 * * * *` | process-games (NBA) |
| 10 | health-monitor | `*/30 * * * *` | health-monitor |
| 12 | auto-optimizer-weekly | `0 11 * * 0` (Sun) | run-optimizer-v2 |
| 13 | calibration-snapshot-daily | `15 11 * * *` | write-calibration-snapshot |
| 14 | fetch-team-advanced-stats-daily | `0 13 * * *` | fetch-team-advanced-stats |
| 15 | fetch-mlb-pitcher-stats-daily | `0 12 * * *` | fetch-mlb-pitcher-stats |
| 16 | fetch-mlb-team-stats-daily | `30 12 * * *` | fetch-mlb-team-stats |
| 17 | fetch-ballpark-factors-weekly | `0 11 * * 1` (Mon) | fetch-ballpark-factors |
| 18 | fetch-umpire-stats-daily | `30 11 * * *` | fetch-umpire-stats |
| 19 | fetch-weather-4h | `0 3,9,15,19,23 * * *` | fetch-weather |
| 20 | fetch-odds-mlb-30min | `0,30 17-23,0-4 * * *` | fetch-odds-mlb |
| 21 | process-games-mlb-30min | `*/5 17-23,0-4 * * *` (D-502: was `5,35 17-23,0-4 * * *`) | process-games-mlb |
| 22 | send-trial-ending-emails-daily | `0 9 * * *` | send-trial-ending-emails |
| 23 | process-deletion-requests-daily | `0 10 * * *` | process-deletion-requests |
| ~~24~~ | ~~send-daily-digest-daily~~ | ~~`0 13 * * *`~~ | **RETIRED D-496** — silent 404 against non-deployed send-daily-digest; unscheduled via migration `20260609000008`. Cron count: 37 → 36. |
| 25 | snapshot-opp-stats | `0 12 * * *` | snapshot-opp-stats |
| 26 | fetch-statcast-snapshot | `0 8 * * *` | fetch-statcast-snapshot |
| 27 | audit-resolution-coverage | `0 14 * * *` | audit-resolution-coverage |
| 28 | fetch-baseball-savant-weekly | `0 8 * * 0` (Sun) | fetch-baseball-savant-weekly |
| 29 | fetch-mlb-batter-splits | `0 9 * * *` | fetch-mlb-batter-splits |
| 30 | fetch-mlb-bullpen-stats | `5 9 * * *` | fetch-mlb-bullpen-stats |
| 31 | dashboard-health-check-2h | `15 15-23/2,1-3/2 * * *` | dashboard-health-check |
| 32 | orchestrator-daily-report | `0 13 * * *` | orchestrator-daily-report |
| 33 | orchestrator-execute | `*/30 * * * *` | orchestrator-execute |
| 34 | job-dispatcher-1min | `* * * * *` (every minute) | job-dispatcher |
| 35 | register-game-schedule-hourly | `15 * * * *` | register-game-schedule |
| 36 | refresh-historical-outcomes-mlb-daily | `0 4 * * *` | refresh-historical-outcomes-mlb |
| 37 | fetch-mlb-boxscores-daily | `30 4 * * *` | fetch-mlb-boxscores |
| 38 | refresh-mlb-scoreboard-status-daily | `0 6 * * *` | refresh-mlb-scoreboard-status |
| 39 | fetch-odds-mlb-morning | `0 9 * * *` | fetch-odds-mlb |
| 40 | fetch-mlb-pitcher-splits | `30 5 * * *` | fetch-mlb-pitcher-splits |
| 42 | sonnet-health-monitor-hourly | `7 * * * *` | sonnet-health-monitor |

**Count: 36** (was 37 pre-D-496; jobid=24 unscheduled). The most aggressive schedule is `job-dispatcher-1min` (every minute); the least frequent are the Sun-08:00 weekly jobs (`fetch-baseball-savant-weekly`, `auto-optimizer-weekly`). D-496 confirmed via full sweep that NO other cron targets a non-deployed function — all 32 remaining unique target fns map to deployed functions.

### 2.5e Runtime constraints (the operative ceiling)

- **Supabase edge function timeout: 150s** (the D-472 finding).
- process-games-mlb hit 142.7s on slate days (D-472). D-473 introduced sharding (mlb_scoring_progress + N=2-per-tick) to stay under the ceiling permanently. D-502 (2026-06-10) kept N=2 and raised the cron cadence to every-5-min (`*/5 17-23,0-4 * * *`) to clear a 15-game slate in ~40 min (was 4 hours). Empirical: ad-hoc trigger scored 2 games in ~55s (~35% of ceiling).
- The 150s ceiling is the architectural lever that PREVENTS the merge clusters D-486 SHIP 2 evaluated (process-games + analyze-pick can't merge; the cron-driven scorer would exceed 150s when called with a single UI pick's needs).

---

## 2.6 SELF-HEALING / MONITORING INFRASTRUCTURE

### 2.6a CURRENT — defense-in-depth (live)

| Layer | When | What it catches | Owner module |
|---|---|---|---|
| 1. **HOUR 0 client-side validation** | every writePickHistory() call | bad payload before RPC roundtrip (saves a server hop) | `_shared/pick_history_writer.ts:validatePayload` |
| 2. **ALWAYS server-side constraints** | every INSERT into pick_history | malformed payloads HOUR 0 missed (defense-in-depth) | Postgres CHECK + NOT NULL + ON CONFLICT (D-204 / D-446 / D-481) |
| 3. **HOUR 1a — RPC failure rate** | hourly @ :07 UTC | rate of `error_log WHERE error_type=rpc_failed` last 60min; warn=10/h, fail=50/h | sonnet-health-monitor :: rpc_failed_rate (D-481) |
| 4. **HOUR 1b — validation failure rate** | hourly @ :07 UTC | rate of HOUR 0 validation rejections last 60min; warn=5/h, fail=25/h | sonnet-health-monitor :: pick_history_validation_failed_rate (D-489 STAGE 5) |
| 5. **Sonnet probe** | hourly @ :07 UTC | Anthropic API outage / billing failure (would have caught D-457 outage at hour 1 not hour 46) | sonnet-health-monitor :: sonnet_probe (D-459) |
| 6. **Sonnet 400 rate** | hourly @ :07 UTC | count `sonnet_http_error` rows last 60min; warn=1, fail=5 | sonnet-health-monitor :: sonnet_400_rate |
| 7. **MLB cron freshness** | hourly @ :07 UTC | last process-games-mlb run_log timestamp vs expected interval | sonnet-health-monitor :: mlb_cron_freshness |
| 8. **MLB write velocity** | hourly @ :07 UTC | count pick_history rows last 60min during MLB cron window; expect ≥10 | sonnet-health-monitor :: mlb_write_velocity |
| 9. **Generic infra** | per `health-monitor` schedule | error_log accumulation, run_log freshness for NBA process-games, silent_failure_pattern detection | health-monitor (D-302) |
| 10. **Dashboard widget** | on Admin page load | last 24h health-status rollup | dashboard-health-check |
| 11. **CI gate** | every push | build + tsc + lint:disclaimer | npm run build |
| 12. **Sentry client errors** | every client error | uncaught JS errors → Sentry React | `@sentry/react` |

**Worked example: how the D-480 silent-failure class is now caught.**

Before D-487: a writer wrote a new mlb_market_type the CHECK didn't allow. Postgres rejected with code 23514. The writer caught the error silently. The Dashboard kept showing yesterday's row. No alert fired. ~560 picks lost over 24 hours before manual detection.

After D-487/488/489:
1. HOUR 0 helper would have caught it (the new value isn't in ALLOWED_MLB_MARKET_TYPES if not added — the helper is now the authoritative client-side mirror).
2. If HOUR 0 missed it, ALWAYS server-side CHECK rejects.
3. If both 1 + 2 fired silently, HOUR 1a would alert at warn=10 (well under 60min of misfires).
4. If somehow the HOUR 0 fail wasn't logged, HOUR 1b catches the validation-fail rate.

Four layers; one bug class structurally closed.

### 2.6b CURRENT — known gaps (honest)

| Gap | Severity | Notes |
|---|---|---|
| **No E2E tests; thin unit-test coverage** | High | Vitest IS configured (`vitest.config.ts` from D-195 TECH-02) and 1 unit test file exists (`tests/scoring.test.ts` — pure-function coverage for the NBA scorer `_shared/scoring.ts` with ≥80% line / ≥75% branch threshold). 0 tests for `_shared/pick_history_writer.ts` (the highest-blast-radius module), 0 for `_shared/scoring_mlb_v2.ts`, 0 for any UI component, 0 E2E. CLAUDE.md's "No test framework is configured" line is stale prose — the gap is coverage breadth, not configuration. |
| **No synthetic monitoring** | High | No Datadog / Pingdom / Better Uptime probe of `betgenius-eight.vercel.app`. Health checks are server-side only; if Vercel goes down nothing alerts. |
| **No external alerting destination** | High | health_status rows with status=fail accumulate in DB. There's no SMS / email / Slack push wired to them. CEO checks them manually. Sentry handles CLIENT errors only. |
| **No per-feature kill switches** | Medium | No centralized feature-flag layer. Currently any rollback requires a code revert + deploy. |
| **No automated backup verification** | Medium | Supabase runs daily backups; no test of restore-from-backup has been performed. |
| **No load testing** | Low | Current scale is single-CEO + dev-mode; pre-launch this is fine, but pre-customer-onboarding it's a gap. |
| **Disclaimer-lint only covers 4 surfaces** | Low | Should expand to any new auth-walled surface. |
| ~~**MLB optimizer tunes only 46 of 54 weights**~~ **CLOSED D-498** | — | The 8-column gap surfaced by D-497-R was closed by D-498: `optimize-weights-mlb`'s `era` type union was extended from `"D340" \| "D362"` to also accept `"D347" \| "D348" \| "D349" \| "D354"`, and 8 new `WeightSpec` entries were added to `ALL_WEIGHTS` with market routing matched to each column's `_shared/mlb_weights.ts` namespace (5 batter / 3 pitcher). Optimizer's tunable set is now 54 of 54 = full coverage. The 8 weights remain at their seed values (verified via BEFORE/AFTER migrations `20260609000009`/`20260609000010` — byte-identical); D-498 added eligibility only. A re-tune (D-499) is the separate CEO-run step that would evaluate moving them; until that runs, scoring is unchanged from pre-D-498. |

### 2.6c TARGET — designed self-healing layer

The complete self-healing layer should add the following to the current 12 layers:

| New layer | What it adds | Why |
|---|---|---|
| **E2E test suite** | Playwright/Cypress smoke tests of the 5 primary user flows: load dashboard / log a bet / view performance / subscribe / settings save | Catches UI-render regressions (like the D-369/D-370 spread-card flip bug) before deploy |
| **Synthetic uptime monitoring** | External cron probing `/` + `/Subscribe` + key API endpoints. Page CEO on 2-min outage. | Vercel / DNS / cert failures must alert outside SharpAI infra |
| **External alert routing** | Wire fail-status rows in health_status to PagerDuty / Twilio SMS / email | CEO doesn't manually poll the DB |
| **Per-feature kill switches** | Edge Config / Supabase row-level feature flags read at every fn entry; fast-fail when off | Lets us disable a broken market or a degraded path without code revert |
| **Backup verification cron** | Weekly restore-test in a staging Supabase project | Catches silent backup corruption |
| **Vitest unit + integration tests** | Real coverage of `_shared/pick_history_writer.ts` (the highest-blast-radius module), scoring formulas, helpers | Catches helper regressions; informs the disclaimer-lint pattern |
| ~~**Extend MLB optimizer to the missing 8 weights**~~ — **DONE D-498** | (8 entries added + era union extended) | (gap closed; optimizer tunable set 46 → 54) |

### 2.6d Gap = roadmap

The 6 new layers + the 8-column MLB-optimizer extension = a 7-item self-healing roadmap. Sequence by leverage:

1. **External alert routing first** (highest leverage; biggest gap exposed by D-457: 46h Anthropic outage with no automatic page)
2. **Synthetic uptime monitoring** (2nd biggest leverage; insulates against Vercel/DNS failure)
3. **E2E test suite** for the 5 user flows (cheapest insurance against UI regressions; D-369/D-370 worked example)
4. **Extend MLB optimizer to the 8 missing weights** (closes the column-coverage gap so D-347/D-348/D-349/D-354 era weights are evaluable in re-tunes; the broader MLB DB-tunability is ALREADY live since D-340/T6)
5. **Per-feature kill switches** (enables fast rollback without git churn)
6. **Vitest unit tests** of the writer helper (highest-blast-radius module)
7. **Backup verification cron** (final insurance layer)

---

## 2.7 KILL SWITCHES & INCIDENT RESPONSE

### 2.7a CURRENT kill switches

| Switch | Where | Trigger |
|---|---|---|
| `BACKFILL_AUTH_TOKEN` vault rotation | Supabase Vault | Manual — invalidates every backfill / cron call until rotated |
| Cron unschedule | `cron.unschedule(jobid)` | Manual SQL — stops any individual cron firing |
| Anthropic API key swap | env var rotation | Manual — kills all AI analysis prose generation; picks still produced (templates fall back) |
| Frontend rollback | Vercel UI / `vercel rollback` | Manual — reverts to prior deploy |
| Edge function rollback | redeploy from prior git SHA | Manual |

There is **no automated kill-switch layer** today. Every rollback is manual via SQL / Vercel UI / git.

### 2.7b TARGET kill switches (per-feature)

| Feature-flag key | Default | Effect when OFF |
|---|---|---|
| `enable_mlb_picks` | ON | process-games-mlb skips writes; Dashboard hides MLB tab |
| `enable_nba_picks` | ON | process-games skips writes; Dashboard hides NBA tab |
| `enable_sonnet_analysis` | ON | Picks ship without ai_analysis prose; template fallback used |
| `enable_signup` | ON | Subscribe page renders "Coming soon" instead of Stripe |
| `enable_<each_new_market>` | OFF until soak | Each new mlb_market_type can be turned off if it regresses |
| `mlb_optimizer_apply_mode` | dry_run | Switching to "live" requires explicit flip + audit log |

Implementation suggestion: Supabase row-level (single `feature_flags` table) so any fn can read it; default to ON if row missing.

### 2.7c INCIDENT PLAYBOOK (worked examples)

**Example 1: Anthropic outage (D-457 worked example)**

What happened (D-457, 2026-06-06): Anthropic billing zeroed out; Sonnet API returned 401s. process-games-mlb's analysis prose calls silently fell into the template fallback. Picks still shipped. CEO didn't notice for 46 HOURS.

How it's now caught (post-D-459 + D-492):
1. `sonnet_probe` health check runs HOURLY at :07 — direct Anthropic API call.
2. On non-200: writes `health_status` row with `status='fail'`, `check_name='sonnet_probe'`, metadata includes HTTP code + error body.
3. At HOUR 1 — within 60 min of the outage.

**Response playbook:**
- Check `health_status WHERE status='fail' AND created_at > NOW() - INTERVAL '1 hour'`.
- If `sonnet_probe` fails: check Anthropic console → billing status → API key validity.
- If valid: rotate API key, redeploy affected fns.
- If billing: top up + verify probe returns ok next hour.

**Example 2: Silent pick loss (D-480 worked example)**

What happened (D-480, 2026-06-07): D-474/D-475/D-476 added 3 new mlb_market_types. The existing pick_history CHECK constraint from D-204 (7 values) rejected them with code 23514. The MLB writer caught the error silently. ~560 picks were lost across 24 hours before manual detection via the D-477 read-layer audit.

How it's now caught (post-D-481 + D-487/488/489):
1. HOUR 0 — `_shared/pick_history_writer.ts:validatePayload` mirrors the CHECK constraint client-side. If a new market type is written that isn't in ALLOWED_MLB_MARKET_TYPES, the helper rejects pre-RPC and returns CLIENT_VALIDATION.
2. ALWAYS — Postgres CHECK still rejects server-side as last-line defense (D-481 extended to 10 values).
3. HOUR 1a — `rpc_failed_rate` check counts `error_log WHERE error_type='rpc_failed'` last 60 min; warn=10, fail=50.
4. HOUR 1b — `pick_history_validation_failed_rate` counts HOUR 0 rejections; warn=5, fail=25.

**Response playbook:**
- Check `health_status WHERE check_name='rpc_failed_rate' OR check_name='pick_history_validation_failed_rate' AND status IN ('warn','fail')`.
- Read the metadata.payloadSummary on recent error_log rows.
- If new market type: add to `ALLOWED_MLB_MARKET_TYPES` in helper + ALTER CONSTRAINT in a new migration; deploy + apply.
- If existing market type: investigate the scorer that wrote the bad row.

---

## 2.8 DISASTER RECOVERY & VENDOR LOCK-IN

### 2.8a Backups

| Asset | Backup | Where | Tested? |
|---|---|---|---|
| Code | git (origin: github.com/redacted/Betting) | GitHub | YES (every push + revert demonstrated) |
| Database | Supabase daily automated backups | Supabase-managed | NO restore test performed [GAP per §2.6d.7] |
| Migration history | git + supabase/migrations/ | GitHub | YES (re-applyable on fresh project) |
| Secrets | Supabase Vault (encrypted) | Supabase | partial — manual rotation tested |
| Vercel deploys | Vercel keeps prior deploys reversible via UI | Vercel | YES (rollback demonstrated) |

### 2.8b Vendor risks + mitigation

| Vendor | Risk | Mitigation today | Target mitigation |
|---|---|---|---|
| Supabase | platform outage → entire app down (frontend, fns, DB) | none (single-vendor) | Long-term: read-replica on Neon for warm-failover [§2.9 ideal] |
| Vercel | hosting outage → frontend down | could re-deploy to alternative host (Netlify / Cloudflare Pages) from same git | scripted alternate-host deploy [§2.9 ideal] |
| The Odds API | rate-limit / outage / pricing hike | cached odds in recommendations_cache (delayed but available) | Secondary odds API (DraftKings odds scraping?) [§2.9 ideal] |
| Anthropic | billing / API outage (D-457 happened) | template fallback in fn code | Multi-AI router (Gemini / GPT-5 secondary) [§2.9 ideal] |
| Stripe | payment outage | none — subscriptions block | (acceptable risk; Stripe outages are rare and short) |
| BallDontLie | free-tier rate-limit | scraped fallback via ESPN | (acceptable — multiple NBA stat sources) |

### 2.8c Vendor lock-in audit

| Concern | Status |
|---|---|
| Database portability | Postgres-standard schema; 348 migrations re-apply on any Postgres. Supabase-specific: `vault`, `cron.job`, `net.http_post`. Migration would require: pg_cron + pgvault + replacement HTTP-from-SQL pattern (1-2 wk) |
| Edge fn portability | Deno runtime; portable to Deno Deploy / Cloudflare Workers (1-2 wk per fn × 54 fns = nontrivial) |
| Auth portability | Supabase Auth lightly used (PIN gate is client-side); migration straightforward |
| Frontend portability | Vite SPA — fully portable (deploy artifact = static dist/) |

---

## 2.9 IDEAL TARGET ARCHITECTURE + GAP ROADMAP

### 2.9a The IDEAL target (designed end-state)

**Function count: ~44-54** (per D-486 SHIP 2 "true floor" analysis, which pressure-tested D-484's 35-target against the 150s runtime ceiling and concluded ~44 is the practical floor; current is 54 deployed, so there's modest residual room for thoughtful consolidation but the big sprawl is gone).

**Sports coverage: 4 sports** (NBA + MLB currently; NFL + NHL planned).

**Monitoring: 19 layers** (current 12 + the 7 new from §2.6c).

**Database: schema-as-code complete (achieved D-495).** Every referenced table now has a creation migration: `error_log`, `bets`, `run_log` via D-495 retroactives (20260609000005/000006/000007); `notifications_log` via the existing D-CEO migration (20260506000007). The 4 previously-undocumented tables in D-494 are now documented.

**MLB optimizer column-complete (achieved D-498)**: 54 of 54 `w_mlb_*` columns the scorer reads are now evaluable by the optimizer. The 8 D-347/D-348/D-349/D-354 era weights — read in production at seed defaults but historically excluded from `ALL_WEIGHTS` per the `era: "D340" \| "D362"` type union — were added in D-498. The broader DB-tunability has been live since D-340/T6 (both NBA and MLB scorers read `algorithm_weights`; both optimizers PATCH the same row). D-498 was tunability-only — values unchanged (BEFORE/AFTER migrations bracketed the deploy and proved byte-identical). A full T11 re-tune using the new 54-column set is queued as D-499 (CEO-triggered; CEO reviews before apply).

**Feature flags everywhere**: every market, every sport, every external dependency behind a kill switch.

**External alerting in place**: PagerDuty / SMS path for any `status='fail'` row.

**Rebranding complete**: when CEO chooses to do the DNS cutover, the assets are pre-staged.

### 2.9b The gap as ordered roadmap

The consolidation program (D-485 → D-493) closed a big batch of debt. The remaining items, ordered by leverage:

| # | Item | Effort | Leverage | Phase |
|---|---|---|---|---|
| 1 | **External alert routing** (SMS / PagerDuty / Slack) wired to health_status fail rows | 2-3 sessions | HIGH — closes the "CEO must poll DB" gap; would have caught D-457 alerts immediately | Self-healing #1 |
| 2 | **Synthetic uptime monitoring** (external probe of /, /Subscribe, key URLs) | 1 session | HIGH — insulates from Vercel/DNS failure | Self-healing #2 |
| ~~3~~ DONE | ~~Document the 4 undocumented tables via retroactive migrations~~ — **completed D-495** (`error_log`, `bets`, `run_log` retroactive migrations added; `notifications_log` already had one — singular-vs-plural naming confusion resolved). Schema-as-code is now complete. | — | — | — |
| 4 | **NFL build (Market 1: passing yards / TDs / receiving yards)** | 4-6 sessions | HIGH — opens a 4-month / year revenue window | New sport |
| 5 | **NHL build (Market 1: shots on goal / goals / assists)** | 4-6 sessions | HIGH — opens a year-round multi-sport offering | New sport |
| 6 | **E2E test suite** (Playwright for 5 user flows) | 2 sessions | MEDIUM — catches UI regressions like D-369/D-370 | Self-healing #3 |
| ~~7~~ DONE | ~~Extend MLB optimizer `ALL_WEIGHTS` to the 8 missing columns + extend the `era` type union~~ — **completed D-498** (8 WeightSpec entries added: 5 batter / 3 pitcher; era union extended `"D340" \| "D362"` → `"D340" \| "D347" \| "D348" \| "D349" \| "D354" \| "D362"`; values byte-identical pre/post deploy per BEFORE/AFTER inspection migrations). **NEW follow-up D-499**: CEO-triggered T11 re-tune across all 54 columns (now-eligible 8 included), CEO reviews proposed deltas before any apply. | — | — | — |
| **NEW (D-498)** | **D-499: CEO-run T11 re-tune across all 54 MLB columns** — first re-tune to use the now-complete column set. Optimizer is dry-run by default; CEO inspects per-weight classification (APPLY / HOLD_OVERFIT / HOLD_MARKET_REGRESS / HOLD_CAP_HIT / NO_MOVE / FROZEN_AT_ZERO) before any `apply=true` call. Especially valuable for the newly-eligible 8 (currently frozen at seed defaults; T11 will surface whether any have evidence to move). | 1 session (dry-run + review) + optional follow-up apply session | MEDIUM — first chance to evaluate whether the 8 newly-tunable weights have evidence to move; safety is preserved via the D-393 classifier + dry-run-by-default gate | Optimizer use |
| 8 | **Per-feature kill switches** (feature_flags table + fn-entry read) | 2 sessions | MEDIUM — enables fast rollback without git churn | Self-healing #4 |
| 9 | **Vitest unit tests of the writer helper** (highest-blast-radius module) | 1 session | MEDIUM — first real test coverage | Self-healing #5 |
| 10 | **Backup verification cron** (weekly restore-test in staging) | 1 session | LOW — final-mile insurance | Self-healing #6 |
| 11 | **DNS cutover to sharpai.app** (subdomain alias → swap canonical) | 1 session, requires CEO timing | LOW — cosmetic; current betgenius-eight.vercel.app works fine | Infra rebrand |
| 12 | **Folder rename `betting-deploy/betgenius` → `sharpai`** (CEO local + .vercel/project.json) | 1 session | LOW — local-only; no customer impact | Infra rebrand |
| 13 | **localStorage key migration** (read `betgenius_*` + write `sharpai_*`; 2-week dual-read overlap; then drop) | 1 session | LOW — data hygiene; zero user impact if done correctly | Infra rebrand |
| 14 | **Cleanup the 4 disk-only / 3 deprecated fns** (bdl-injuries-probe × 2, odds-api-injuries-probe, send-daily-digest) | 1 session | LOW — already harmless | Cleanup |
| ~~NEW (D-495)~~ DONE | ~~Resolve `send-daily-digest` 404 silent-failure~~ — **closed D-496** via `cron.unschedule('send-daily-digest-daily')` in migration `20260609000008`. CEO chose UNSCHEDULE over deploy. Full sweep also confirmed NO other cron targets a non-deployed fn. | — | — | — |

### 2.9c Phase ordering recommendation

```
NOW           → 1 (alerting) + 2 (uptime) + 3 (schema completeness)
+1 month      → 4 (NFL) — starts the multi-sport expansion
+2 months     → 5 (NHL) — completes the 4-sport offering
+3 months     → 6 (E2E) + 7 (MLB DB) + 8 (kill switches) + 9 (vitest)
+6 months     → 10 (backup verify) + 11-13 (rebrand cutover) + 14 (cleanup)
```

**Critical insight from the consolidation program**: every batch in D-485 → D-493 was DEFENSIVE (closing debt, preventing regressions, reconciling drift). The roadmap above is the first OFFENSIVE phase — items 1-2 still close debt, but items 4-5 (NFL + NHL) start the customer-facing revenue expansion.

---

## END OF SECTION 2

**This document is the LOCKED ARCHITECTURE REFERENCE.** Future batches that touch the system should:
1. Read this doc first to orient.
2. Update it FIRST when reality diverges (with a discrepancy note + batch tag).
3. Reference its sub-section IDs (2.5c, 2.6a, etc.) when reasoning about scope.

The consolidation program (D-485 → D-493) is COMPLETE. The next phase — the §2.9 roadmap — is the offensive build-out: alerting, uptime, NFL, NHL, then the remaining self-healing layers. SharpAI now has a designed architecture; future growth is on rails.

— end of SharpAI_SECTION-2-ARCHITECTURE.md
