# Phase 1 MLB — developer handoff

**Product:** SharpAI (repo folder still named `betgenius`)  
**Work:** MLB Phase 1 — warehouse backtest through **2026-05-24**, side/veto policy, no weight retune  
**Branch:** `phase1-mlb`  
**Code:** folder `betgenius/` in this zip. Do not search for or contact the product owner.

This pack has **no** client name, email, phone, or GitHub.  
Ask the person who hired you for **read-only** DB credentials in a private channel — not in this file.

---

## 1. Hard rules (non-negotiable)

1. **Do not edit** `supabase/functions/_shared/scoring_mlb_v2.ts` or `algorithm_weights` without written GO from the project owner.
2. Juice-FAIL = **veto**, not retune. Do not change weights to force a PASS.
3. Hits and total bases are **already live**. Do not overwrite without GO.
4. Odds warehouse cutoff: **2026-05-24**. Do not ingest new Odds API history for this milestone.
5. Do not invent game EV (`winProb` / `evPerUnit`) on `scoreGameSide`.
6. One Deno backtest at a time (`harness_readonly` connection limit **10**).
7. **Never commit** `.env`, keys, dumps, or AWS `.pem`.

---

## 2. What is already done vs remaining

| Item | Status |
|---|---|
| Hits full-book | Done — under PASS, over FAIL |
| Total bases full-book | Done — under PASS, combined FAIL |
| H2H full-book | Done — ev_pass PASS (boxscore as-of; no real game EV) |
| Spreads full-book | Done after numeric `line` coerce — home FAIL juice, away point-estimate PASS (CI crosses 0) |
| Totals full-book | **Pending** — next AWS/Deno run `--market=totals --end=2026-05-24` |
| HR / RBI / K | FAIL on current gate — local veto, not deployed |
| Runs / outs | No usable 2026 warehouse odds — pick_history only; do not flip `warehouseOddsAvailable` |
| Local policy `mlb_ev_policy.ts` | Written, **not deployed** |
| Scheduler + dashboard E2E | Not done |
| Live deploy | Project owner deploys (this machine may be on the wrong Supabase project) |

---

## 3. Files to share (code)

Give the new developer **this branch as a zip or GitHub read access**. Root: `betgenius/`.

### Must read first
- `CLAUDE.md`
- `harness/PHASE1_SCOPE.md`
- `harness/README.md`
- `harness/MILESTONE2.md` through `harness/MILESTONE6.md`

### Policy + production write path
- `supabase/functions/_shared/mlb_ev_policy.ts`
- `supabase/functions/process-games-mlb/index.ts`
- `src/lib/marketValidation.ts`

### Harness
- `harness/run_backtest.ts`
- `harness/lib/` (all — especially `market_config.ts`, `grade_game.ts`, `game_candidates.ts`, `context_game.ts`, `env.ts`, `report.ts`, `grade.ts`)
- `harness/test/run_smoke_tests.ts`
- `harness/.env.example` (**not** `.env`)

### Scorer (READ ONLY)
- `supabase/functions/_shared/scoring_mlb_v2.ts`

### Findings (numbers, not secrets)
- `harness/out/spreads_2023-05-03_to_2026-05-24.json`
- Hits / TB / h2h full-window JSON if present
- `harness/out/phase1_pick_history_policy_replay.json`
- `harness/out/*gate_m5*` for HR, RBI, K, outs, runs

Skip: `node_modules/`, `.git/` if sending zip, huge unused m6 sweep CSVs unless they ask.

### Frontend (only if dashboard is in scope)
- `src/` (Dashboard, Games, `App.tsx`)

---

## 4. APIs this project uses

**Do not put live keys in the zip.** Project owner fills a private `.env`. Names only:

| API / service | Env var | Used for | Phase 1 need |
|---|---|---|---|
| **The Odds API** | `THE_ODDS_API_KEY` | Live/historical odds | **Do not ingest more.** Warehouse already loaded through May 24. Docs: https://the-odds-api.com |
| **Supabase Postgres** | `HARNESS_DATABASE_URL` | Read-only backtest | **Yes** — role `harness_readonly`, SELECT only |
| **Supabase (frontend)** | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Dashboard SPA | Only if UI work is in scope |
| **Supabase (edge)** | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `process-games-mlb` writes | **Do not give service role to a zip contractor** unless owner deploys themselves |
| Baseball Savant / Statcast | via cached tables in Postgres | Pitcher/batter context | Tables already in DB; no extra key for harness |
| ESPN / boxscores | cached in DB | Grades, as-of stats | Same |
| BallDontLie | `BALLDONTLIE_API_KEY` | Other sports | **Out of Phase 1 MLB** |
| Gemini / Anthropic | `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | AI copy on picks | **Not required** for backtest/policy |

Public TLS cert (not a secret):  
https://supabase-downloads.s3.amazonaws.com/prod/ssl/prod-ca-2021.crt  
Save as `betgenius/prod-ca-2021.crt`, then `DENO_CERT` = that path.

Harness `.env` template (fill privately):

```
HARNESS_DATABASE_URL=postgresql://harness_readonly.<ref>:<password>@<host>:5432/postgres?sslmode=require
```

Copy from `harness/.env.example`. Never commit.

---

## 5. How to run (after they have read-only DB)

From `betgenius/`:

```bash
# smoke (no DB)
deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts

# one market at a time — never two Deno backtests
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=totals --end=2026-05-24
```

Windows: one line, no `\` continuations.  
`DENO_V8_FLAGS=--max-old-space-size=5120` on a 4GB+ box for full-book.

CLI markets:  
`batter_hits`, `batter_total_bases`, `batter_home_runs`, `batter_rbis`, `batter_runs_scored`, `pitcher_strikeouts`, `pitcher_outs`, `h2h`, `spreads`, `totals`

---

## 6. Access the owner should give (not you from a chat file)

| Access | Level |
|---|---|
| Git `phase1-mlb` | read (or zip of `betgenius/` minus `.env`) |
| Postgres `harness_readonly` | SELECT only |
| `prod-ca-2021.crt` | public cert |
| Odds API | **not needed** for remaining warehouse totals run |
| Service role / Vercel | **project owner only** — not in the zip |
| Remote backtest VM | Only if the person who hired you shares SSH privately. Do **not** expect a `.pem` inside this zip. Stop the instance when idle. |

---

## 7. Local policy already in code (not live)

`mlb_ev_policy.ts`:

- Side: hits **under**, TB **under**, `game_side` **away**, `game_total` **under**
- Veto: `batter_hr`, `batter_rbis`, `batter_runs_scored`, `pitcher_k`, `pitcher_outs`

Frontend confirmed set (local): hits, TB, `game_side`, `game_total`.

---

## 8. Suggested first tasks for the new developer

1. Read `PHASE1_SCOPE.md` + this file.  
2. Run smoke tests.  
3. **Totals** full-book (`--end=2026-05-24`) — one Deno.  
4. Do not deploy. Do not touch live hits/TB. Do not invent EV.

---

## 9. Zip checklist before you send

Include: `betgenius/` source on `phase1-mlb`, this handoff, `harness/out` key JSONs.  
Exclude: `harness/.env`, `.env.local`, `*.pem`, `node_modules`, production SQL dumps, this chat’s payment notes.
