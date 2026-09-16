# Milestone 3 — Win-prob / EV Pipeline (batter hits)

**Date:** 2026-07-11  
**Market:** `batter_hits`  
**Window:** 2026-04-25 → 2026-05-24  
**Scope:** D-691 Poisson win-prob path + EV-based `recommendation_shown` parity in harness  
**Status:** Delivered — **gate PASS**

---

## Executive summary

Milestone 3 replaces D-823 isotonic confidence for `batter_hits` with a **D-691 Poisson win-probability pipeline**: projection + factor-adjusted λ → P(win|line) → shrunk confidence → `edgeVsImplied` → `evPerUnit` → production `recommendation_shown`.

The harness now exposes an **`ev_filtered`** tier matching the live surface (`ev_pass` + `evPerUnit > 0`). On the same Apr–May warehouse window used in M1/M2, the EV-filtered slice clears the go/no-go gate with **n=1,125 graded** and **+7.15% ROI-after-vig** (95% CI lower bound +1.58%).

**Verdict: PASS** — proceed with batter hits pricing; gate cleared at meaningful n.

---

## What was built

### Production scorer (D-691 — already shipped)

| Step | Implementation (`scoring_mlb_v2.ts`) |
|---|---|
| Projection | `projectedStat = (0.55×L10 + 0.45×season) × pitcherAdj × parkAdj` from game log |
| Distribution | Poisson(λ); `λ = projectedStat × clamp(1 + factorSum×0.002, 0.65, 1.40)` |
| Win prob | `winProb = winProbPoissonK(λ, line, side)` |
| Confidence | `round(winProb × 100)` with shrinkage above 60% |
| Edge / EV | `edgeVsImplied = winProb − impliedProb(odds)`; `evPerUnit = winProb × decimal(odds) − (1 − winProb)` |
| Surface | `batterRecommendationShown()`: conf≥60 ∧ ¬unbettable juice ∧ ¬over-BE flag ∧ **evPerUnit > 0** |

### Harness (this milestone)

| Component | Change |
|---|---|
| `harness/lib/metrics.ts` | `isEvFilteredPick()`, `isRecommendationShownPick()`, `evaluateM3Gate()` |
| `harness/lib/report.ts` | **`ev_filtered`** tier; M3 gate block in console/CSV/JSON |
| `harness/test/run_smoke_tests.ts` | 118 offline tests passing |
| `harness/README.md` | M3 tier documentation |

### Tier definitions

| Tier | Filter |
|---|---|
| `recommendable` / `ev_pass` | conf≥60, not unbettable under juice, overs clear implied BE (M2) |
| **`ev_filtered`** | ev_pass **+** `evPerUnit > 0` (production `recommendation_shown` parity) |

---

## Harness run

| Metric | Value |
|---|---|
| Odds rows fetched | 48,704 |
| Candidate groups | 22,666 |
| Scored picks | 7,669 |
| Gradeable (win/loss) | 7,171 |
| Voids | 498 |
| conf≥60 picks | 3,605 |
| ev_filtered picks | 1,227 (1,125 graded) |

**Model:** shipped weights + D-691 Poisson win-prob (replaces D-823 isotonic for hits).  
**Data source:** `cache_mlb_historical_odds` (warehouse mode).

---

## Primary deliverable — `ev_filtered / all`

| Metric | Value |
|---|---|
| **Graded n** | **1,125** |
| **ROI-after-vig** | **+7.15%** [1.58%, 12.79%] |
| **Win rate** | 56.71% [53.80%, 59.58%] |
| **Avg CLV** | 0.00% (n=1,227) |
| **% positive CLV** | 0.00% |

Side breakdown:

| Side | Graded n | WR | ROI |
|---|---:|---:|---:|
| all | 1,125 | 56.71% | **+7.15%** |
| over | 395 | 58.73% | −1.66% |
| under | 730 | 55.62% | **+11.91%** |

---

## Before / after comparison

Artifacts:
- Pre-M2 (D-823): [`out/batter_hits_2026-04-25_to_2026-05-24_pre_m2.json`](out/batter_hits_2026-04-25_to_2026-05-24_pre_m2.json)
- Post-M2 only (D-823 + over-BE gate): [`out/batter_hits_2026-04-25_to_2026-05-24.json`](out/batter_hits_2026-04-25_to_2026-05-24.json)
- Post M2+M3 (D-691 + gates): [`out/batter_hits_m2m3_2026-04-25_to_2026-05-24.json`](out/batter_hits_m2m3_2026-04-25_to_2026-05-24.json)  
  CSV: [`out/batter_hits_m2m3_2026-04-25_to_2026-05-24.csv`](out/batter_hits_m2m3_2026-04-25_to_2026-05-24.csv)

| Slice | Pre-M2 n | Pre-M2 ROI | Post-M2 n | Post-M2 ROI | Post-M3 n | Post-M3 ROI |
|---|---:|---:|---:|---:|---:|---:|
| **all / over** | 5,811 | −5.50% | 5,811 | −5.50% | 5,811 | −5.50% |
| **recommendable / all** | 11 | +0.44% | 2 | −100.00% | 1,137 | +7.38% |
| **ev_pass / all** | — | — | 2 | −100.00% | 1,137 | +7.38% |
| **ev_filtered / all** | — | — | — | — | **1,125** | **+7.15%** |

**Caveat:** M3 replaces D-823 isotonic with Poisson win-prob for hits. Confidence distribution shifts dramatically (12 → 3,605 conf≥60 picks). Tier before/after counts are **not** pure gate-only deltas — they reflect the full scoring rebuild.

---

## Gate verdict

| Criterion | Target | Result |
|---|---|---|
| ev_filtered graded n | ≥ 500 (meaningful n) | **1,125** — **PASS** |
| ev_filtered ROI | > 0% at n ≥ 500 | **+7.15%** — **PASS** |
| ROI CI lower bound | > 0% if n < 500 | n/a (n ≥ 500) |
| Bonus: avg CLV > 0 | Positive avg CLV | **0.00%** — not achieved |

**Gate verdict: PASS**

**Decision:** Batter hits EV-filtered surface clears 0% ROI at meaningful n. Do **not** close batter pricing work based on this window.

---

## Interpretation

1. **D-691 unlocks a large conf≥60 surface.** Poisson win-prob produces 3,605 conf≥60 picks vs 12 under D-823 isotonic — the prior M2 gate verdict on n=2 was not representative of the M3 pipeline.
2. **EV filter is the production surface.** `ev_filtered` (1,125 graded) is the harness mirror of `recommendation_shown`. Combined M2 gates + positive EV yields +7.15% ROI with CI lower bound +1.58%.
3. **Structural over bleed persists at full universe.** `all/over` remains −5.50% at 60.0% WR — the unfiltered scored universe still shows false-edge. Production only surfaces the EV-filtered slice.
4. **Unders carry the edge.** ev_filtered under ROI +11.91% (n=730); over ROI −1.66% (n=395) — still negative on overs within the filtered surface, but combined slice passes gate.
5. **CLV is flat at 0%.** Closing odds in the warehouse snapshot appear identical to entry for this window (no line movement captured). CLV bonus criterion not met; ROI gate is the operative pass signal.

---

## Out of scope (this milestone)

- Negative-binomial distribution (D-691 design option; shipped Poisson pilot)
- Scorer / weight refitting
- Other markets
- `pick_history` replay for batter_hits

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
  --end=2026-05-24 \
  --out=batter_hits_m2m3_2026-04-25_to_2026-05-24 \
  --format=both
```

---

## Next step

Gate passed — batter hits pricing validated on Apr–May warehouse window. Consider expanding win-prob pipeline to additional markets only after per-market gate runs on the same harness framework.
