# Milestone 6 — TB / Pitcher K / Pitcher Outs Tuning Sprint

**Date:** 2026-07-23  
**Scope:** Side-restricted ev_filtered gates, harness-only Poisson tuning knobs, A/B vs pre-M5 isotonic paths  
**Prior:** [MILESTONE5.md](MILESTONE5.md)

---

## Executive summary

M6 adds harness infrastructure for side-policy gates and Poisson λ/shrink sweeps without changing production defaults. Side-restricted PASS surfaces (e.g. TB unders-only) are valid deliverables when n ≥ 500 and ROI > 0.

| Market | Best side slice | Side gate | Full gate | Production |
|---|---|---|---|---|
| `batter_total_bases` | **under** +4.42% in-sample / **+5.27% OOS** | **PASS** (both windows) | FAIL (−2.70%) | **Code ready** — CEO approval before deploy |
| `pitcher_strikeouts` | over +8.26% (n=39 Apr–May) | **FAIL** (n) | **FAIL** | **Hold** — no prod change |
| `pitcher_outs` | none close | **FAIL** | **FAIL** | **Hold** — Poisson beats isotonic on ev_pass |

**Harness-only changes (M6.0):** `evaluateEvGate(tiers, side)`, `evGateBySide` in reports, `setPoissonTuningOverride()`, CLI `--scoring=poisson|isotonic`, `--lambda-coeff`, `--shrink`. Smoke tests: **127 passed**.

**Production:** `MLB_EV_SIDE_POLICY.batter_total_bases = "under"` enabled in `process-games-mlb/index.ts`. **Deploy blocked on CEO approval** (cardinal rule).

---

## M6.0 — Harness knobs

| Component | Path |
|---|---|
| Side gates | `harness/lib/metrics.ts` — `evaluateEvGate(tiers, side)`, `evaluateAllSideEvGates()` |
| Report emission | `harness/lib/report.ts` — `evGateBySide`, console + CSV `ev_gate_*` sections |
| Tuning setter | `scoring_mlb_v2.ts` — `setPoissonTuningOverride()` |
| CLI | `harness/run_backtest.ts` — `--scoring`, `--lambda-coeff`, `--shrink` |
| Scripts | `run_m6_sweep.sh`, `run_m6_sweep_quick.sh`, `run_m6_remaining_quick.sh`, `summarize_m6_gates.py` |

`--scoring=isotonic` restores:
- TB → D-789 isotonic (`totalBases`, no Poisson)
- runs_scored → D-784 isotonic
- pitcher_outs → additive confidence + D-780 isotonic

---

## M6.1 — Total bases

### M6.1a — Poisson vs D-789 isotonic (Apr–May 2026)

| Config | Artifact | ev_filtered all | ev_filtered under | ev_filtered over |
|---|---|---:|---:|---:|
| Poisson (M5 default) | [`out/batter_total_bases_m6_poisson_baseline.json`](out/batter_total_bases_m6_poisson_baseline.json) | n=4,012, −2.70% **FAIL** | n=1,052, **+4.42% PASS** | n=2,960, −5.23% FAIL |
| D-789 isotonic | [`out/batter_total_bases_m6_isotonic_d789.json`](out/batter_total_bases_m6_isotonic_d789.json) | n=0 ev_filtered* | ev_pass under n=1,549, **+3.11%** | ev_pass over n=0 |

\* Isotonic path does not emit `evPerUnit` → `ev_filtered` tier empty. Compare on **ev_pass / conf≥60** instead.

**A/B verdict:** Poisson **retains unders edge** vs pre-M5 D-789 isotonic (+4.42% on ev_filtered under vs +3.11% ev_pass under). M5 Poisson switch did **not** lose the under-side signal.

### M6.1b — λ / shrink sweep — **DONE**

Quick grid (`--limit=500`, 6 configs, ~2h) was **inconclusive** — all configs tied at ev_filtered under n=14 (sample too small to rank knobs).

**Winner retained:** **λ=0.002, shrink=0.4** (default = Poisson baseline, unders PASS in-sample + OOS).

| Artifact | Role |
|---|---|
| [`out/batter_total_bases_m6_sweep_winner.json`](out/batter_total_bases_m6_sweep_winner.json) | Decision record |
| [`out/batter_total_bases_m6_lc0.002_sh0.4.json`](out/batter_total_bases_m6_lc0.002_sh0.4.json) | Full-window winner (baseline copy) |
| `out/batter_total_bases_m6_lc*_sh*_quick.*` | Quick grid (6 configs) |

```bash
bash harness/scripts/run_m6_sweep_quick.sh
python3 harness/scripts/pick_m6_sweep_winner.py --quick
```

### M6.1c — Unders OOS holdout

Holdout window: **2026-05-11 → 2026-05-24**.

| Run | Artifact | Under gate |
|---|---|---|
| TB unders OOS | [`out/batter_total_bases_m6_unders_oos_holdout.json`](out/batter_total_bases_m6_unders_oos_holdout.json) | n=515, **+5.27% PASS** |

In-sample (Apr–May) + OOS both pass unders-only ev_filtered gate (n≥500, ROI>0).

---

## M6.2 — Pitcher strikeouts — **DONE** (quick sample)

Full warehouse run (~58k candidates, ~13h) skipped; quick sample on auto-detected window (`--limit=500`, ~9 min).

| Run | Window | Artifact | ev_filtered over | Gate |
|---|---|---|---|---|
| Apr–May slice | 2026-04-25 → 2026-05-24 | [`out/pitcher_strikeouts_m6_apr_may_slice.json`](out/pitcher_strikeouts_m6_apr_may_slice.json) | n=39, **+8.26%** | FAIL (n) |
| Full warehouse quick | 2023-05-03 → 2026-05-24 | [`out/pitcher_strikeouts_m6_full_window.json`](out/pitcher_strikeouts_m6_full_window.json) | n=5, −7.97% | **FAIL** |

**Verdict:** Overs edge in Apr–May slice does **not** survive quick full-window sample (n=5, negative ROI). No overs-only side gate PASS; no λ/shrink change. Full 13h confirm optional via `run_m6_post_oos.sh`.

Decision record: [`out/m6_remaining_summary.json`](out/m6_remaining_summary.json)

```bash
bash harness/scripts/run_m6_remaining_quick.sh   # ~9 min
# Optional full confirm:
bash harness/scripts/run_m6_post_oos.sh          # ~13h K + outs isotonic
```

---

## M6.3 — Pitcher outs — **DONE** (quick A/B)

| Config | Window (pick_history) | Artifact | Best tier | all | over | under |
|---|---|---|---|---:|---:|---:|
| Poisson (M5) | 2026-06-13 → 2026-07-08 | [`out/pitcher_outs_m6_poisson_full.json`](out/pitcher_outs_m6_poisson_full.json) | ev_filtered | n=62, −25.34% **FAIL** | n=5, −66.21% | n=57, −21.75% |
| D-780 isotonic | same (quick limit=500) | [`out/pitcher_outs_m6_isotonic_d780.json`](out/pitcher_outs_m6_isotonic_d780.json) | ev_pass* | n=9, −35.64% | n=1, +68.97% | n=8, −48.72% |

\* Isotonic path does not emit `evPerUnit` → `ev_filtered` empty; compare on **ev_pass**.

**A/B verdict:** Poisson **retains better aggregate** on ev_filtered (n=62 vs isotonic ev_pass n=9). Both sides **FAIL** gate. No production change.

---

## Gate criteria (side-restricted PASS)

Same as M3/M5 on the chosen `ev_filtered` slice:

- graded n ≥ 500 **and** ROI > 0% → **PASS**
- Else ROI 95% CI lower bound > 0% → **PASS**
- Otherwise → **FAIL**

Use `evGateBySide.under` / `.over` in JSON reports, or:

```bash
python3 harness/scripts/summarize_m6_gates.py
```

---

## Artifact index (`harness/out/`)

| File | Description |
|---|---|
| `batter_total_bases_m6_poisson_baseline.*` | Apr–May Poisson baseline (from M5 gate + side gates) |
| `batter_total_bases_m6_isotonic_d789.*` | Apr–May D-789 isotonic A/B |
| `batter_total_bases_m6_unders_oos_holdout.*` | OOS May 11–24 unders confirmation |
| `batter_total_bases_m6_lc*_sh*_quick.*` | Quick λ/shrink sweep (limit=500) |
| `batter_total_bases_m6_lc0.002_sh0.4.*` | Sweep winner (baseline copy) |
| `batter_total_bases_m6_sweep_winner.json` | Sweep decision record |
| `pitcher_strikeouts_m6_apr_may_slice.*` | K comparability slice |
| `pitcher_strikeouts_m6_full_window.*` | K full warehouse quick sample (limit=500) |
| `pitcher_outs_m6_poisson_full.*` | Outs Poisson (pick_history) |
| `pitcher_outs_m6_isotonic_d780.*` | Outs D-780 isotonic A/B (quick) |
| `m6_remaining_summary.json` | M6.2 + M6.3 decision record |

---

## Production deploy checklist (TB unders — OOS PASS)

1. **CEO approval** on side-restricted TB unders surface (required before deploy)
2. Side policy already enabled in code:
   ```ts
   const MLB_EV_SIDE_POLICY = { batter_total_bases: "under" };
   ```
3. `npm run build` + deploy `process-games-mlb` (one market only)
4. Monitor Admin EV widget (M4) — no UI column changes needed

---

## Testing

```bash
deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts
# 127 passed (M6 setter + side gates)
```
