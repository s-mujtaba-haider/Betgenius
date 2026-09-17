# Milestone 2 — Over Breakeven Gate (batter hits harness)

**Date:** 2026-07-10  
**Market:** `batter_hits`  
**Window:** 2026-04-25 → 2026-05-24  
**Scope:** Harness-only (no production `recommendation_shown` changes)  
**Status:** Delivered — **gate FAIL** → proceed to M3 (M3 gate **PASS** — see [MILESTONE3.md](MILESTONE3.md))

---

## Executive summary

Milestone 2 adds an **over-side EV gate** to the Phase 1 backtest harness, symmetric to the existing unbettable-under juice filter from M1. Overs are only counted in `recommendable` / `ev_pass` tiers when **calibrated win rate clears implied break-even** at the offered entry odds.

On the same batter-hits window used in M1, the gate **filters aggressively** (12 conf≥60 overs → 3 survivors) but **does not improve ROI** on the recommendable slice. Both pass criteria are missed.

**Verdict: FAIL** — do not expand the gate alone; proceed to Milestone 3.

---

## What was built

| Component | Change |
|---|---|
| `harness/lib/oddsmath.ts` | `passesOverBreakeven(confidence, odds)` — `confidence/100 >= impliedProb(odds)` |
| `harness/lib/metrics.ts` | `isEvPassPick()` + extended `isRecommendablePick()` (identical filter) |
| `harness/lib/report.ts` | New **`ev_pass`** tier (alias of updated `recommendable`) |
| `harness/test/run_smoke_tests.ts` | 109 offline tests passing |
| `harness/README.md` | Tier documentation updated |

### Gate rules (recommendable / ev_pass)

| Side | Rule |
|---|---|
| **All** | `confidence >= 60` |
| **Under** | Not flagged unbettable juice (D-164 tiers: 60+/-200, 70+/-250, 80+/-300, 90+/-350) |
| **Over** | Calibrated WR ≥ implied break-even at entry odds (D-823 confidence as win-rate estimate) |

`all` and confidence-threshold tiers (`60+`, `70+`, etc.) are **unchanged** — they still show the full scored universe for baseline comparison.

---

## Harness run

| Metric | Value |
|---|---|
| Odds rows fetched | 48,704 |
| Candidate groups | 22,666 |
| Scored picks | 7,669 |
| Gradeable (win/loss) | 7,171 |
| Voids | 498 |
| conf≥60 picks | 12 (all over; 0 under) |

**Model:** shipped weights + D-823 isotonic calibration, no refitting.  
**Data source:** `cache_mlb_historical_odds` (warehouse mode).

---

## Before / after ROI

Baseline (M1): [`out/batter_hits_2026-04-25_to_2026-05-24_pre_m2.json`](out/batter_hits_2026-04-25_to_2026-05-24_pre_m2.json)  
Post-M2: [`out/batter_hits_2026-04-25_to_2026-05-24.json`](out/batter_hits_2026-04-25_to_2026-05-24.json)  
CSV: [`out/batter_hits_2026-04-25_to_2026-05-24.csv`](out/batter_hits_2026-04-25_to_2026-05-24.csv)

| Slice | Before n (graded) | Before WR | Before ROI | After n (graded) | After WR | After ROI | Δ ROI |
|---|---:|---:|---:|---:|---:|---:|---:|
| **all / all** | 7,171 | 60.7% | **-2.89%** | 7,171 | 60.7% | **-2.89%** | 0 |
| **all / over** | 5,811 | 60.0% | **-5.50%** | 5,811 | 60.0% | **-5.50%** | 0 |
| **all / under** | 1,360 | 63.8% | **+8.31%** | 1,360 | 63.8% | **+8.31%** | 0 |
| **recommendable / all** | 11 | 72.7% | **+0.44%** | 2 | 0.0% | **-100.00%** | -100.44pp |
| **recommendable / over** | 11 | 72.7% | **+0.44%** | 2 | 0.0% | **-100.00%** | -100.44pp |
| **ev_pass / all** | — | — | — | 2 | 0.0% | **-100.00%** | new tier |
| **ev_pass / over** | — | — | — | 2 | 0.0% | **-100.00%** | new tier |

`all/over` ROI is unchanged by design — M2 only filters the recommendable surface, not the full backtest universe.

---

## Gate cohort detail (conf≥60)

**12** picks at conf≥60. Gate keeps **3**, excludes **9**.

### Kept (pass over breakeven)

| Player | Date | Odds | Cal WR | Implied BE | Result |
|---|---|---:|---:|---:|---|
| Jung Hoo Lee | 2026-04-30 | -155 | 64% | 60.8% | LOSS |
| Jung Hoo Lee | 2026-04-30 | -163 | 64% | 62.0% | LOSS |
| Nolan Schanuel | 2026-05-13 | -159 | 64% | 61.4% | VOID |

Graded survivors: **0W / 2L** → -100% ROI on n=2.

### Excluded (calibrated 64% < implied 67–79%)

| Player | Date | Odds | Implied BE | Result |
|---|---|---:|---:|---|
| Ben Rice | 2026-05-03 | -210 | 67.7% | WIN |
| Jacob Wilson | 2026-05-05 | -375 | 78.9% | WIN |
| Chase DeLauter | 2026-05-05 | -257 | 72.0% | WIN |
| Chandler Simpson | 2026-05-07 | -323 | 76.4% | WIN |
| Otto Lopez | 2026-05-08 | -275 | 73.3% | WIN |
| Jackson Chourio | 2026-05-08 | -245 | 71.0% | WIN |
| Chase DeLauter | 2026-05-09 | -206 | 67.3% | LOSS |
| Samuel Basallo | 2026-05-15 | -225 | 69.2% | WIN |
| Carson Benge | 2026-05-20 | -256 | 71.9% | WIN |

Among graded exclusions: **7W / 1L**. The gate correctly identifies minus-money overs where D-823 calibrated WR sits below book break-even, but on this tiny window it filters mostly winners and retains the two Jung Hoo Lee losses.

---

## Pass / fail criteria

| Criterion | Target | Result |
|---|---|---|
| recommendable / over ROI | ≥ 0% | **-100.00%** (n=2) — **FAIL** |
| recommendable / all ROI | ≥ 0% | **-100.00%** (n=2) — **FAIL** |

**Gate verdict: FAIL**

**Decision:** Proceed to **Milestone 3**. Do not widen or relax the over breakeven gate alone.

---

## Interpretation

1. **Structural over problem persists.** Full-universe over ROI remains **-5.50%** at 60.0% WR — classic false-edge (high hit rate, negative ROI after vig).
2. **Gate logic is working as specified.** It removes overs where calibrated confidence (64%) is below implied break-even on heavy juice lines.
3. **Sample is too thin for structural claims.** Only 12 conf≥60 picks in this window; post-gate n=2 graded. ROI CIs are meaningless at this size — verdict is directional only.
4. **D-823 calibration ceiling matters.** Most high-raw picks land at calibrated 64%; at minus-money over odds the breakeven gate will continue to filter aggressively until calibration or scoring improves.

---

## Out of scope (this milestone)

- Production `recommendation_shown` / Dashboard surfacing changes
- Scorer, weights, or calibration refitting
- Other markets (pitcher K, total bases, etc.)

---

## Reproduce

```bash
# Offline tests
deno run --no-check --allow-env --allow-read --allow-write \
  harness/test/run_smoke_tests.ts

# Full backtest (requires harness/.env HARNESS_DATABASE_URL)
cd betgenius
deno run --no-check --allow-net --allow-env --allow-read --allow-write \
  harness/run_backtest.ts \
  --market=batter_hits \
  --start=2026-04-25 \
  --end=2026-05-24
```

---

## Next step

**Milestone 3** — address the underlying over-side edge problem (scoring/calibration/factors), not gate expansion alone.
