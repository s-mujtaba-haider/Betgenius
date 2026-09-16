# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

SharpAI — live sports betting prediction platform (rebranded from BetGenius on Apr 29, 2026;
filesystem paths, the Vercel domain, the GitHub repo, and `package.json`'s `name` still say
"betgenius"/legacy pending a deferred infra-rename). Covers MLB, NBA, NFL, and NHL prop and team
markets. Algorithm picks ship to paid subscribers ($99-149/month). This is not a toy — code
changes affect real betting decisions. The product **recommends** picks only; it never places
bets with a sportsbook itself. Users log their own bets into the `bets` table manually, and
`resolve-picks` settles them against actual results afterward.

## Cardinal rules — non-negotiable

1. **Never guess.** Read the actual code before proposing changes.
2. **Never change scoring/algorithm logic** — especially
   `supabase/functions/_shared/scoring_mlb_v2.ts` — without presenting a plan and getting
   explicit approval first. This includes anything touching `algorithm_weights`.
3. Infrastructure/UI/feature work can proceed autonomously; use the self-grading protocol below.
   Autonomous scope covers reading any file, grep/find/ls/cat exploration, editing files under
   `src/` and `supabase/functions/`, `npm run build`, `supabase functions deploy`,
   `git add/commit/push`, `vercel --prod`, and read-only DB queries via the Supabase CLI. Ask
   first before: UPDATE/DELETE/ALTER on any table, changing `algorithm_weights` or scoring
   logic, deleting files, installing new dependencies, or anything touching payment processing
   or API credentials.
4. **Never run production SQL** (UPDATE/DELETE/ALTER) without documenting a rollback.
5. **One deploy, one change.** Verify each deploy boots before moving to the next.
6. **Test locally before deploying** — `npm run build` must pass before `git push`.
7. **Never hardcode database credentials, API keys, or connection strings anywhere in this
   repo.** Always read them from environment variables.
8. Edit existing files; don't create new ones unless clearly needed.
9. Never run two backtest harness processes concurrently — the `harness_readonly` Postgres role
   has a connection limit of 10.

## Self-grading protocol

After completing any task, grade yourself A+, A, B, C, D, or F against:
1. **Correctness** — does it actually work end-to-end? Did you verify?
2. **Cardinal rules compliance**
3. **Error handling** — edge cases, failures, null values covered?
4. **Integration** — doesn't break existing functionality?
5. **Deployability** — build passes, deploy succeeds, function boots?

If the grade is below A, identify what's weak, fix it, and re-grade. Don't report "done" until
you hit A/A+. If you can't reach A after 3 iterations, stop and say what's blocking you.

## Build & dev commands

```bash
npm run dev             # Vite dev server with HMR
npm run build           # lint:disclaimer + weight/payload wiring checks + write-build-info + tsc -b + vite build
npm run lint             # ESLint (non-blocking in CI — ~217 pre-existing no-explicit-any errors)
npm run preview          # Preview production build locally
npm run test             # Vitest run (frontend/shared scoring tests)
npm run test:watch       # Vitest watch mode
npm run test:coverage    # Vitest with v8 coverage (thresholds in vitest.config.ts)
```

Run a single test file or case:
```bash
npx vitest run tests/scoring.test.ts
npx vitest run -t "some test name"
```

Supabase edge functions (Deno runtime):
```bash
supabase link --project-ref gzuzuqxvfjszlfclhcfz
supabase functions serve                                   # Run all functions locally
supabase functions deploy <function-name> --no-verify-jwt  # Deploy a single function
```

CI (`.github/workflows/ci.yml`, `betgenius/` as working directory) runs lint (non-blocking),
`npm run build`, then `npm test` on every push and on PRs into `main`.

## Architecture

**Frontend:** React 19 + TypeScript SPA built with Vite. Tailwind CSS v4 + shadcn/ui (New York
style, dark theme). Charts via Recharts. No router library — `App.tsx` uses `useState<Page>` to
switch between pages (Dashboard, Evaluator, BetTracker, Performance, Stats, Games, Admin,
Settings, Landing, Subscribe).

**Backend:** Supabase (PostgreSQL + Deno edge functions, `supabase/functions/`). The frontend
talks directly to Supabase via `@supabase/supabase-js` — there is no intermediate API layer.
Edge functions disable JWT verification (`verify_jwt = false`) and call out to The Odds API,
ESPN, Baseball Savant/Statcast, and Google Gemini / Anthropic Claude.

**Deployment:** Vercel (frontend) + Supabase (database & edge functions).

**Path alias:** `@/*` → `src/*` (configured in `tsconfig.app.json` and `vite.config.ts`).

**Scoring core:** `supabase/functions/_shared/scoring_mlb_v2.ts` is the single production scorer
— per-market functions (`scoreBatterHits`, `scoreBatterTotalBases`, `scoreBatterHomeRuns`,
`scoreBatterRbis`, `scoreBatterRunsScored`, `scorePitcherStrikeouts`, `scorePitcherOuts`,
`scoreGameSide`, `scoreGameTotal`) consumed by both the live edge functions and the offline
backtest harness. `tests/scoring.test.ts` covers it directly; coverage thresholds are enforced
via `vitest.config.ts` (lines 85% / branches 55% / functions 90% / statements 80%).

## Key data flow

1. Scheduled cron edge functions (`process-games`, `fetch-odds`, `get-recommendations`, plus the
   sport-specific `*-mlb` variants) run daily/hourly to pull odds and stats and populate
   `recommendations_cache` via `scoring_mlb_v2.ts` + shipped `algorithm_weights`.
2. Dashboard/Games pages read `recommendations_cache` and display picks with confidence scores.
3. Users log their own bets → `bets` table. `resolve-picks` settles them against results written
   by `fetch-mlb-boxscores` / historical outcome functions.

## Backtest harness (`harness/`)

Standalone Deno CLI that independently re-scores historical candidates through the **real**
production scorer (`scoring_mlb_v2.ts`) and shipped weights — no refitting, read-only, no DB
writes — to answer "does the model beat the vig on clean, point-in-time data?" See
`harness/README.md` for the full market/data-source table and milestone reports
(`harness/MILESTONE{2..6}.md`).

```bash
cp harness/.env.example harness/.env    # set HARNESS_DATABASE_URL (harness_readonly role)

# From betgenius/ (Windows: single line, no `\` continuations)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=batter_hits --limit=50

# Offline smoke tests (no DB)
deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts
```

Two data sources per market: `warehouse` (full priced universe from
`cache_mlb_historical_odds`) or `pick_history` (for `batter_runs_scored` / `pitcher_outs`, where
the warehouse has no historical odds — CLV is N/A in this mode).

**Pass/fail gate** (`ev_gate` / `ev_gate_all|over|under` sections of the report, on
`ev_filtered` picks — `ev_pass` + `evPerUnit > 0`, production `recommendation_shown` parity):
- graded n ≥ 500 **and** ROI > 0 → PASS
- otherwise, ROI 95% CI lower bound > 0 → PASS
- otherwise → FAIL

Never run two harness backtests at the same time — `harness_readonly` has a Postgres connection
limit of 10; the M6 sweep scripts already sequence markets for this reason.

## Autonomous builder/evaluator loop (`loop/`) — shadow only

An adversarial three-role harness (Planner writes `task.json` with a hard rubric → Builder
subagent does the work → Evaluator subagent, separate context, defaults to FAIL and must
actively try to break the result) used for autonomous dev iterations, logged one row per
iteration to `loop_run_log`. Full design in `loop/README.md`.

**It is shadow-only and never touches production scoring state.** A pre-flight check in
`loop/scripts/run_iteration.sh` greps proposed work and refuses to proceed if it references
`algorithm_weights`, `pick_history`, `recommendations_cache`, `cron.job`,
`scoring_mlb_v2.ts`, or `process-games-mlb/index.ts`. Writes are confined to `loop_run_log`,
`loop_kill_switch`, `pick_history_shadow`, `/tmp/`, or `loop/examples/`. Before any autonomous
use, the evaluator must catch all four `loop/trust_gate/known_lies/*.json` historical failure
fixtures — if it passes any of them, the rubric is too soft; fix the rubric before running
autonomously. `loop/kill_switch/` polls a stop signal (`loop_kill_switch.stop`).

## Database

PostgreSQL via Supabase (`supabase/schema.sql` for core tables: players, games,
player_game_logs, props, picks, bets, cache, results). Notable tables added via migrations:
- `recommendations_cache` — cron-generated daily picks
- `algorithm_weights` — tunable scoring parameters (cardinal rule 2 applies)
- `api_usage` — Odds API quota tracking
- `cron_progress` — batch job processing status
- `pick_history` — production pick log with stored side/line/odds/breakdown, used by both the
  optimizer and the harness's pick_history data source
- `loop_run_log`, `loop_kill_switch` — see the loop section above

## Environment variables

Frontend (`.env.local`):
```
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Edge functions (`supabase secrets set`):
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
THE_ODDS_API_KEY, BALLDONTLIE_API_KEY
ANTHROPIC_API_KEY, GEMINI_API_KEY
```

Harness (`harness/.env`, git-ignored):
```
HARNESS_DATABASE_URL   # harness_readonly role, read-only, connection limit 10
```

## Python scripts

Root-level `*.py` files are offline data analysis / algorithm-tuning scripts — not part of the
build.

## Current project state (last refreshed D-370, 2026-05-30)

**Algorithm performance (post D-364 + D-366 + D-367 T11 tuning):**
- MLB validated synthetic corpus: 56,315 picks (D-358 1,587 + D-359 600 + D-360-FIX 1,438 +
  D-363 14,022 + D-368 38,668)
- MLB post-T11 sweep on 13,671-pick eval set: objective HR 67.27% → 69.82% (+2.55pp); good-tier
  56.06% → 66.67% (+10.61pp) — D-366
- NBA recent 200 picks at conf≥70: 91.67% on n=12 pre-D-367 weights / 67.86% on n=28 post-D-367
  weights (volume-over-precision trade applied, watching live data for 30 days)
- NBA lifetime "609 picks at 70+, 49.6% HR, -$1,254 / -12.54 units" is a stale early-period
  average; not the operative rate post-T11

**Known critical bugs (live state):**
1. **(D-367 resolved 2026-05-29):** `auto_optimize_weights()` SQL cron reports 66.2% on
   synthetic backfill vs 49.6% production-lifetime on real picks — diagnosed as (a)
   synthetic-vs-real population mismatch (SQL function defaults `is_synthetic_filter=true`) and
   (b) cap-ordering drift between TS and SQL (per-pick p50=0, p90=4pt, max=19pt). Replacement TS
   optimizer `d367-optimize-nba` is deployed; D-367 SHIP 6 applied 2 unanimous proposals
   (`w_l10` 0.75→2.5, `w_minutes_trend` 0→1.5) per CEO direction. No further changes without
   explicit CEO GO.
2. **(D-367 SHIP 2 reframed)** 7 of 23 scoring factors fire <5% of the time — confirmed
   by-design (vig_filter, market_conf, role_change, player_injury are edge-case modifiers;
   score_rest 0% is consistent with the formula). **Not buggy.**
3. **(Still open)** `score_home_away` shows a 4.6pt hit-rate gap but weight is 0.0 — real signal
   currently ignored. Candidate for a future T11 NBA re-tune.
4. **(D-369 resolved 2026-05-29; D-370 swept 2026-05-30):** Spread card team-flip bug (D-270-C1
   class) — `Games.tsx` assumed `r.team = home` for `game_total` rows, but the backend writes
   `team` artificially for totals (over→homeTeam, under→awayTeam); PostgREST row order gave a
   ~50% chance of an inverted home/away label. Fixed with is_home as primary anchor + sorting
   spread/h2h before game_total. D-370 sweep confirmed no other consumers share this pattern.
5. **(D-406 confirmed stale, resolved via D-379 SHIP 2 on 2026-05-31)** `pick_history.breakdown`
   JSONB was NULL for pre-D-379 MLB picks; the column + `upsert_pick_history` RPC were updated,
   and post-D-379 rows are populated. `resolve-picks` only PATCHes
   `actual_value`/`hit`/`resolved_at`/`ai_analysis`, so breakdown survives resolution.
6. **(D-365 lesson, encoded)** Auth-conflation bug class: edge functions that make outgoing
   PostgREST calls AND read `BACKFILL_AUTH_TOKEN` as the apikey will 401 when BACKFILL is a
   UUID. Swept clean via D-365 + D-366 SHIP 5.

**Recently shipped:**
- **D-520-APPLY (2026-06-13)** — CEO §19.3 approved. Largest scoring change to date: 9 batter
  weights sign-flipped (handedness_matchup, weather_wind, lineup_consistency, weather_temp,
  wind_direction_hr, pitcher_quality, form_power, recent_ab, babip — each ×-1) + new D-517 v2
  `score_batter_line_hit_rate` factor (weight 2.0, penalty-only on l10). Dry-run: 80+ batter WR
  43.85→75.63% (n=677, +31.78pp). Watch plan + rollback in
  `docs/loop/reports/d520apply_chained_final.md`; pre-apply SHA `4b1eb99`, snapshot table
  `algorithm_weights_d520apply_snapshot`.
- Performance.tsx v2 (accuracy fix)
- Odds API upgraded to 100K/month plan ($59), resets 1st of month at 12AM UTC
- `api_usage` table + `logApiUsage()` wired into `fetch-odds`, `process-games`,
  `get-recommendations`

**Infrastructure:**
- Frontend: betgenius-eight.vercel.app
- Supabase project: `gzuzuqxvfjszlfclhcfz`
- Deploy dir: `~/Desktop/betting-deploy/betgenius`
- Git: (redacted in contractor pack — ask the person who hired you)
- Primary sportsbook: Hard Rock Bet

## Deploy commands

```bash
# Frontend
cd ~/Desktop/betting-deploy/betgenius && git add -A && git commit -m "desc" && git push && vercel --prod

# Edge function
cd ~/Desktop/betting-deploy/betgenius && git add -A && git commit -m "desc" && git push && npx supabase functions deploy [function-name] --no-verify-jwt

# Rollback
git revert HEAD && git push && redeploy
```
