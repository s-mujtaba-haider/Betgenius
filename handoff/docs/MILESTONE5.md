# Milestone 5 — Poisson + EV Market Expansion

**Date:** 2026-07-21  
**Window (warehouse):** 2026-04-25 → 2026-05-24 (M3-comparable)  
**Window (pick_history):** runs_scored 2026-06-01 through 2026-07-15; pitcher_outs 2026-06-13 through 2026-07-08  
**Scope:** Port D-691 Poisson win-prob + EV pipeline to 6 remaining harness MLB markets; per-market ev_filtered gate; production surface only on PASS  
**Status:** Delivered — **0 / 6 markets PASS** (harness scoring ported; no M5 production deploy)  
**Prior:** [MILESTONE3.md](MILESTONE3.md) · [MILESTONE4.md](MILESTONE4.md)

---

## Executive summary

Milestone 5 extends the M3/M4 Poisson + EV stack to all remaining harness markets:

| Market | Scorer change | Gate |
|---|---|---|
| `batter_total_bases` | Poisson path in shared `scoreBatterMarket` (`totalBases`) | **FAIL** |
| `batter_home_runs` | Poisson path (`homeRuns`; rare-event approximation) | **FAIL** |
| `batter_rbis` | Poisson path (`rbi`) | **FAIL** |
| `pitcher_strikeouts` | D-695 win-prob + `evPerUnit` export | **FAIL** |
| `batter_runs_scored` | Poisson path in `scoreBatterRunsScored` (pick_history) | **FAIL** |
| `pitcher_outs` | Poisson path in `scorePitcherOuts` (pick_history) | **FAIL** |

**Only `batter_hits` (M3/M4) clears the ev_filtered gate** — see [`out/batter_hits_m3_clv_fix.json`](out/batter_hits_m3_clv_fix.json) (+7.15%, n=1,125). Per plan: do **not** deploy M5 scorer changes to production until a market passes gate and receives CEO approval.

Harness infrastructure: `evaluateEvGate()` + `ev_gate` in reports for any market with `evPerUnit` picks (M5.0). UI columns from M4 apply to any market that eventually passes.

---

## Gate matrix — `ev_filtered / all`

| Market | Source | Graded n | ROI | 95% CI | Over ROI | Under ROI | Verdict |
|---|---|---:|---:|---|---:|---:|---|
| `batter_hits` | warehouse (M3/M4) | 1,125 | **+7.15%** | [1.58%, 12.79%] | −1.66% | +11.91% | **PASS** |
| `batter_total_bases` | warehouse | 4,012 | −2.70% | [−5.42%, −0.07%] | −5.23% | +4.42% | **FAIL** |
| `batter_home_runs` | warehouse | 5 | +195%* | [−100%, +555%] | +195%* | n=0 | **FAIL** |
| `batter_rbis` | warehouse | 310 | −9.28% | [−20.61%, +2.33%] | −16.47% | −4.08% | **FAIL** |
| `pitcher_strikeouts` | warehouse | 81 | −5.38% | [−25.09%, +16.53%] | +8.26% | −18.05% | **FAIL** |
| `batter_runs_scored` | pick_history | 462 | +5.50% | [−1.50%, +12.39%] | n=0 | +5.50% | **FAIL** |
| `pitcher_outs` | pick_history | 62 | −25.34% | [−48.19%, −1.84%] | −66.21% | −21.75% | **FAIL** |

\* `batter_home_runs`: only **5** ev_filtered picks in window — ROI not meaningful; gate fails on n < 500 and CI.

### Gate criteria (unchanged from M3)

- `ev_filtered` graded n ≥ 500 **and** ROI > 0% → **PASS**
- Else ROI 95% CI lower bound > 0% → **PASS**
- Otherwise → **FAIL**

---

## Per-market notes

### `batter_total_bases` — FAIL

- Artifact: [`out/batter_total_bases_gate_m5.json`](out/batter_total_bases_gate_m5.json) / [`.csv`](out/batter_total_bases_gate_m5.csv)
- Large n (4,012) but **negative aggregate ROI**; under-positive / over-negative split insufficient vs hits.
- **Production:** Hold Poisson TB scorer until refit or distribution upgrade.

### `batter_home_runs` — FAIL

- Artifact: [`out/batter_home_runs_gate_m5.json`](out/batter_home_runs_gate_m5.json) / [`.csv`](out/batter_home_runs_gate_m5.csv)
- Poisson on HR is a pilot approximation; ev_filtered volume **5 picks**.
- **Production:** Hold; consider negative-binomial in a future milestone.

### `batter_rbis` — FAIL

- Artifact: [`out/batter_rbis_gate_m5.json`](out/batter_rbis_gate_m5.json) / [`.csv`](out/batter_rbis_gate_m5.csv)
- n=310, ROI −9.28%; both sides negative in ev_filtered slice.
- **Production:** Hold.

### `pitcher_strikeouts` — FAIL

- Artifact: [`out/pitcher_strikeouts_gate_m5.json`](out/pitcher_strikeouts_gate_m5.json) / [`.csv`](out/pitcher_strikeouts_gate_m5.csv)
- D-695 win-prob existed; M5 adds `evPerUnit` / `edgeVsImplied`. n=81; ROI −5.38%.
- **Production:** Hold EV export deploy until gate clears.

### `batter_runs_scored` — FAIL (marginal)

- Artifact: [`out/batter_runs_scored_gate_m5.json`](out/batter_runs_scored_gate_m5.json) / [`.csv`](out/batter_runs_scored_gate_m5.csv)
- pick_history Jun 1 – Jul 15, 2026; n=462, ROI +5.50% but **CI lower −1.50%**.
- All ev_filtered picks are **under** side (over n=0 in slice).
- **Production:** Hold; re-gate when ev_filtered n ≥ 500.

### `pitcher_outs` — FAIL

- Artifact: [`out/pitcher_outs_gate_m5.json`](out/pitcher_outs_gate_m5.json) / [`.csv`](out/pitcher_outs_gate_m5.csv)
- pick_history Jun 13 – Jul 8, 2026; n=62, ROI −25.34%.
- **Production:** Hold.

---

## What was built

### Scoring (`scoring_mlb_v2.ts`)

- `computeEvFromWinProb()`, `shrinkPoissonConfidence()`, `isPoissonBatterStat()`
- Shared batter Poisson block: `hits`, `totalBases`, `homeRuns`, `rbi`
- `scorePitcherStrikeouts`: exports `winProb`, `edgeVsImplied`, `evPerUnit`
- `scoreBatterRunsScored` / `scorePitcherOuts`: Poisson + EV (replaces isotonic paths)

### Production gate (`process-games-mlb/index.ts`)

- `mlbRecommendationShown()`: conf≥60, not unbettable juice, not over-BE, **evPerUnit > 0**
- Applied to batter + pitcher rec_cache / pick_history writes
- **M5 markets:** scoring changes remain **harness-only** until per-market CEO approval + PASS gate

### Harness

- `evaluateEvGate()` (+ `evaluateM3Gate` alias)
- `ev_gate` / `m3Gate` in JSON/CSV/console for any market with `evPerUnit`
- Sequential runner: [`scripts/run_block1_sequential.sh`](scripts/run_block1_sequential.sh)
- Gate summary: [`scripts/summarize_gates.py`](scripts/summarize_gates.py)
- CLV audits: [`scripts/audit_clv_snapshots.ts`](scripts/audit_clv_snapshots.ts), [`scripts/audit_snapshot_counts.ts`](scripts/audit_snapshot_counts.ts)

### UI (M4 foundation — no M5 migration)

Dashboard / PickCard keyed on `recommendation_shown` and `ev_per_unit`. Performance shows aggregate avg CLV; Admin shows per-row CLV + M4 monitor.

---

## Testing

| Check | Result |
|---|---|
| Harness smoke tests | **120 passed, 0 failed** |
| Per-market gate runs | 6/6 complete — see matrix |
| Frontend build | **`npm run build` OK** |

---

## Artifacts (client delivery pack)

| Market | JSON | CSV |
|---|---|---|
| Total bases | `out/batter_total_bases_gate_m5.json` | `out/batter_total_bases_gate_m5.csv` |
| Home runs | `out/batter_home_runs_gate_m5.json` | `out/batter_home_runs_gate_m5.csv` |
| RBIs | `out/batter_rbis_gate_m5.json` | `out/batter_rbis_gate_m5.csv` |
| Pitcher K | `out/pitcher_strikeouts_gate_m5.json` | `out/pitcher_strikeouts_gate_m5.csv` |
| Runs scored | `out/batter_runs_scored_gate_m5.json` | `out/batter_runs_scored_gate_m5.csv` |
| Pitcher outs | `out/pitcher_outs_gate_m5.json` | `out/pitcher_outs_gate_m5.csv` |

**Reference (PASS):** `out/batter_hits_m3_clv_fix.json` / `.csv` — in-sample batter hits baseline from M3/M4.

---

## Recommended next steps

1. **`batter_hits` only** — production surface remains the validated EV market (M3/M4 PASS).
2. **`batter_runs_scored`** — closest marginal FAIL; revisit when pick_history ev_filtered n ≥ 500.
3. **`batter_total_bases`** — large n negative ROI; investigate Poisson λ vs isotonic D-789.
4. **Distribution upgrades** — HR/RBI may need negative-binomial; out of Block 1 scope.
5. **Warehouse multi-snapshot backfill** — unlocks harness CLV for 2026 windows (see [MILESTONE4.md](MILESTONE4.md)).
