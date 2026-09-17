# SharpAI Phase 1 Backtest Harness — MLB player props

Independent, leak-safe backtest of SharpAI MLB batter and pitcher prop markets. Answers:
**does the model beat the vig on clean, point-in-time data?** — with
ROI-after-vig and CLV (where available) reported alongside win rate, plus
an explicit false-edge flag.

Standalone Deno CLI. Reuses the real production scorer, real shipped
weights, and live calibration — no refitting, no DB writes, no new
dependencies.

## Client Q&A — data sources

### Q1: `batter_runs_scored` and historical odds

The Odds API does **not** expose `batter_runs_scored` in the historical odds
warehouse (`cache_mlb_historical_odds` has 0 rows — provider gap, not a missing
backfill). For runs_scored, use **pick_history mode**:

| | Warehouse mode (4 markets) | pick_history mode (runs_scored) |
|---|---|---|
| Entry price | Best price ~T-1h from `cache_mlb_historical_odds` | `pick_history.odds` |
| Universe | Every priced player/line | Rows already in `pick_history` |
| CLV | From pre-game closing snapshot | **N/A** |
| Side selection | D-538 agreeing-side gate | Fixed from stored pick |

**Prerequisite:** `GRANT SELECT ON pick_history TO harness_readonly` (not in
the default 11-table grant set). Events resolved via `(game_date, team,
opponent)` → `cache_mlb_historical_events`.

### Q2: Which markets have full warehouse backtests?

| `--market` | Warehouse rows | Scorer |
|---|---|---|
| `batter_hits` | ~4.68M | `scoreBatterHits` |
| `batter_total_bases` | ~5.7M | `scoreBatterTotalBases` |
| `batter_home_runs` | ~3.6M | `scoreBatterHomeRuns` |
| `batter_rbis` | large | `scoreBatterRbis` |
| `batter_runs_scored` | **0** — use `--source=pick_history` | `scoreBatterRunsScored` |
| `pitcher_strikeouts` | ~510K | `scorePitcherStrikeouts` |
| `pitcher_outs` | **0** — use `--source=pick_history` | `scorePitcherOuts` |

**Recommended Phase 1 start:** `--market=batter_hits`

## What it does (Phase 1)

1. **Warehouse mode:** loads the full candidate universe from
   `cache_mlb_historical_odds` — every player/line the market priced.
2. **pick_history mode:** loads production picks from `pick_history` with
   stored side/line/odds (`batter_runs_scored`, `pitcher_outs`).
3. Builds strict **leak-safe, point-in-time context** per candidate.
4. Scores through the real production scorer with shipped weights.
5. Grades against `cache_mlb_boxscore_player_stats`.
6. Writes JSON report + console summary (tiers, ROI, CLV or N/A, calibration,
   drawdown, baselines, false-edge flag).

## Prerequisites

- [Deno](https://deno.com/) (2.x).
- Read-only Postgres (`harness_readonly` role). For pick_history mode, client
  must extend grants to include `pick_history`.
- Optional (richer pitcher K context): `cache_mlb_pitcher_season_stats`,
  `cache_statcast_pitcher`, `cache_statcast_pitcher_arsenal`. Without these
  grants the harness falls back to boxscore aggregation (still valid).

## Setup

```bash
cp harness/.env.example harness/.env
# edit harness/.env — set HARNESS_DATABASE_URL
```

## Run

From `betgenius/` (Windows: single line, no `\` continuations):

```bash
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts
```

Default: `--market=batter_hits` (warehouse mode).

### CLI flags

| Flag | Default | Description |
|---|---|---|
| `--market=…` | `batter_hits` | All 7 markets (see table above) |
| `--source=…` | `warehouse` | `warehouse` or `pick_history` (runs_scored / pitcher_outs) |
| `--start=YYYY-MM-DD` | auto-detected | Window start |
| `--end=YYYY-MM-DD` | auto-detected | Window end |
| `--scoring=poisson\|isotonic` | `poisson` | M6 A/B: `isotonic` restores D-789/D-784/D-780 isotonic paths (harness-only) |
| `--lambda-coeff=N` | `0.002` | Poisson λ factor coefficient (harness tuning) |
| `--shrink=N` | `0.4` | Poisson confidence shrink above 60% (harness tuning) |
| `--out=path` | auto | Output base path or `.json`/`.csv` file |
| `--format=json\|csv\|both` | `both` | Write full JSON report and/or multi-section CSV to `harness/out/` |
| `--min-completeness=0.0-1.0` | `0` | Min context completeness |
| `--limit=N` | `0` | Cap candidates processed |

### Examples

```bash
# Phase 1 — full warehouse backtest on hits (recommended start)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=batter_hits --limit=50

# pitcher_strikeouts via warehouse (CLV computed)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=pitcher_strikeouts --limit=50

# pitcher_outs via pick_history (CLV N/A)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=pitcher_outs --source=pick_history --limit=50

# runs_scored via pick_history (CLV N/A)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts --market=batter_runs_scored --source=pick_history --limit=50

# Legacy wrapper (defaults to batter_runs_scored warehouse — will fail with provider-gap message)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest_runs_scored.ts
```

## Offline tests

```bash
deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts
```

## Layout

```
harness/
  run_backtest.ts               Unified CLI entrypoint
  run_backtest_runs_scored.ts   Deprecated wrapper → run_backtest.ts
  lib/
    market_config.ts            Per-market registry (scorer, grade column, sources)
    env.ts                      Read-only Postgres client
    weights_pg.ts               Shipped weights loader
    candidates.ts               Warehouse candidate universe
    pick_history_candidates.ts  pick_history-sourced candidates
    event_lookup.ts             pick_history → event_id resolution
    context_router_batter.ts    Point-in-time batter context router
    context_router_pitcher.ts   Point-in-time pitcher K context router
    context_router_pitcher_outs.ts  Pitcher outs context router
    context_batter.ts           Leak-safe wrapper + Statcast AS-OF
    context_pitcher.ts          Leak-safe pitcher context wrappers
    context_runs.ts             Re-exports context_batter (backward compat)
    statcast_asof.ts            Statcast AS-OF reconstruction
    grade.ts                    Outcome join + grading
    oddsmath.ts                 Implied prob / CLV math
    metrics.ts                  Tiered metrics + baselines
    report.ts                   JSON + console report
  test/run_smoke_tests.ts
  out/                          JSON reports + full multi-section CSV exports
```

CSV export (`harness/out/{market}_{dates}.csv`) uses a `section` column so each block is filterable in Excel/Sheets:

| Section | Contents |
|---|---|
| `meta` | Market, data source, CLV status, window, detected coverage |
| `coverage` | Row counts, gradeable/push/void totals, Statcast AS-OF, exclusions |
| `tiers` | Win rate, ROI-after-vig (with 95% CIs), CLV, false-edge flags per tier/side. Includes **`recommendable`** and **`ev_pass`** (identical filter: conf≥60, exclude unbettable under-side juice, overs must have calibrated WR ≥ implied break-even at entry odds). **`ev_filtered`** = ev_pass + `evPerUnit > 0` (production `recommendation_shown` parity). |
| `m3_gate` / `ev_gate` | M3/M5 go/no-go verdict when picks carry `evPerUnit`: graded n, ROI, CLV, pass/fail reason |
| `ev_gate_all` / `ev_gate_over` / `ev_gate_under` | M6 per-side ev_filtered gate verdicts (side-restricted surfaces) |
| `calibration` | Confidence bucket vs realized win rate |
| `baselines` | market_favorite, flat_bet_all, coin_flip_ev |
| `drawdown` | Cumulative units, peak, max drawdown |
| `sanity` | D-784 ceilings, false-edge tier list |
| `false_edge` | Flagged tier/side pairs (when any) |
| `excluded` | Candidates dropped before scoring |
| `picks` | Every scored pick with per-pick CLV% and unit profit |

## Scope (Phase 1)

- Fixed model: shipped weights + calibration, **no refitting**.
- Read-only end to end — no DB writes.
- Scorer import: `scoring_mlb_v2.ts` + `best_price.ts` only from `supabase/functions/_shared/`.

## Milestone reports (client delivery)

| Milestone | Report |
|---|---|
| M2 — Over breakeven gate (`batter_hits`) | [MILESTONE2.md](MILESTONE2.md) |
| M3 — Win-prob / EV pipeline (`batter_hits`) | [MILESTONE3.md](MILESTONE3.md) |
| M4 — Batter hits hardening (OOS, CLV, UI, monitor) | [MILESTONE4.md](MILESTONE4.md) |
| M5 — Poisson + EV expansion (6 markets) | [MILESTONE5.md](MILESTONE5.md) |
| M6 — TB / K / outs tuning sprint (side gates, λ sweep) | [MILESTONE6.md](MILESTONE6.md) |

### M6 sequential scripts

Run one market at a time (`harness_readonly` connection limit):

```bash
# Full M6 sweep (Poisson baseline reused from M5 artifact; see script header)
bash harness/scripts/run_m6_sweep.sh

# M6.1b quick λ/shrink sweep (--limit=500, ~1–2h total)
bash harness/scripts/run_m6_sweep_quick.sh

# M6.2 + M6.3 fast finish (~9 min; --limit=500 on full detected windows)
bash harness/scripts/run_m6_remaining_quick.sh

# M6.2 + M6.3 full confirm (~13h K + outs isotonic; optional)
bash harness/scripts/run_m6_post_oos.sh

# Summarize side gates from harness/out/*_m6_*.json
python3 harness/scripts/summarize_m6_gates.py
```
