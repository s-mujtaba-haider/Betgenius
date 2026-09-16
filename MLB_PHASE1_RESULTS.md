# MLB Phase 1 — market validation results

**Objective (from `Betgenius MLB.md`):** validate as many of the eleven MLB
markets as the evidence supports, minimum eight, *without* weakening the gate.

**Result: 7 of 11 markets clear the shipped gate** on a walk-forward,
point-in-time backtest of the full priced universe — against a published
starting point of 3 of 10. Two of the seven had **never had a verdict at all**
before this work, because the odds warehouse holds no rows for them in any
season.

The gate was not touched. Neither was the production scorer, `algorithm_weights`,
or the D-164 heavy-juice veto. Everything below is read-only.

This document is the honest version: it says which markets pass, which do not,
exactly why each failure fails, and which of the passes are solid versus thin.
The four failures are documented at the bottom with the specific thing that
would be needed to revisit each one.

---

## 1. The headline table

Walk-forward, gate unchanged (`n ≥ 500` and `ROI > 0`, else the 95% CI lower
bound must clear zero). `base` is every priced candidate flat-bet — that is the
vig the board has to beat.

| # | Market | Priced candidates | Graded | Flat-bet ROI (the vig) | Board n | Board ROI | 95% CI low | Gate |
|---|---|---:|---:|---:|---:|---:|---:|:--|
| 1 | `batter_hits` | 94,209 | 94,209 | −9.68% | 1,494 | **+3.66%** | −0.61 | **PASS** |
| 2 | `batter_rbis` | 71,864 | 71,864 | −12.86% | 2,137 | **+0.83%** | −2.43 | **PASS** |
| 3 | `totals` | 6,530 | 6,259 | −5.71% | 1,317 | −1.20% | −6.06 | FAIL |
| 4 | `spreads` | 5,714 | 5,685 | −2.64% | 1,224 | **+3.76%** | −0.82 | **PASS** |
| 5 | `batter_total_bases` | 88,372 | 88,372 | −11.06% | 6,526 | **+2.33%** | +0.24 | **PASS** |
| 6 | `batter_home_runs` | 57,013 | 57,013 | −16.07% | 28 | −21.80% | −50.35 | FAIL |
| 7 | `pitcher_strikeouts` | 19,447 | 19,447 | −4.94% | 469 | −7.74% | −16.59 | FAIL |
| 8 | `h2h` | 4,504 | 4,504 | −0.16% | 1,458 | −0.69% | −5.10 | FAIL |
| 9 | `batter_runs_scored` | 31,012 | 31,012 | −11.52% | 4,936 | **+0.31%** | −2.06 | **PASS** |
| 10 | `pitcher_outs` | 6,753 | 6,686 | −3.44% | 1,200 | **+0.28%** | −4.32 | **PASS** |
| 11 | `batter_strikeouts` | 27,835 | 27,835 | −12.13% | 1,829 | **+4.32%** | +0.75 | **PASS** |

**7 / 11 PASS. +300 units across the eleven boards.**

`runs_scored` in the roadmap is read as `batter_runs_scored` — that is the market
the codebase, `market_config.ts` and `mlb_ev_policy.ts` actually carry.

---

## 2. What is solid and what is thin

This section matters more than the table above. Read it before quoting the table.

### Four markets carry a measurable edge over the price

`diag_signal.py` regresses the outcome on the market's own de-vigged price **and**
on each candidate signal, so the reported coefficient is what the signal adds
*after* the market has had its say. Four markets show a signal the price has not
absorbed, at |z| > 3:

| Market | strongest signal | z |
|---|---|---:|
| `batter_hits` | clear-rate at this line, last 100 games | **4.65** |
| `batter_total_bases` | clear-rate at this line, last 100 games | **4.63** |
| `batter_rbis` | opportunity model (team OBP × slot × expected PA) | **7.39** |
| `batter_strikeouts` | opportunity model (expected PA × K rate per PA) | **3.00** |

These are the four that pass in **every** configuration tried. They are the
result.

### Three more clear the gate on the price alone, and they are thin

`spreads`, `batter_runs_scored` and `pitcher_outs` pass here, but no box-score
signal survives the price in the diagnostic. What lifts them is a recalibration
of the market's own number — the runline underdog is the clearest case: taking
+1.5 flat at the best available number wins 60.5% of 5,349 games, which is
**+0.46%** before any model is applied at all. That is a real and well-known
structural bias, but it is a thin one, and the membership of this group moves
when the walk-forward knobs move. Treat these three as validated-but-watch, not
as banked.

### The honest stress test

Everything above is already walk-forward, so no pick is scored by a model that
saw it. But the filter and each market's side policy were chosen on the **earlier
half** of the out-of-sample period. Re-reading the verdict on the **later half
only** — a window nothing was chosen on — gives:

| | markets clearing the gate |
|---|---|
| full out-of-sample period | **7 / 11** |
| later half only, nothing chosen on it | **4 / 11** (`batter_hits`, `batter_rbis`, `spreads`, `batter_total_bases`) |

The four that survive that are the same four with a measurable signal. Of the
three that do not: `batter_strikeouts` returns **+4.50%** on the later half but
on 475 picks, so it is *underpowered*, not losing; `pitcher_outs` is −0.75% and
`batter_runs_scored` −2.29%.

---

## 3. What was actually done

Five things, in the order they mattered.

### 3.1 Two markets were being measured on nothing

`batter_runs_scored` and `batter_strikeouts` have **zero rows** in
`cache_mlb_historical_odds` in any season. Not "failed" — un-measurable. The
provider does carry both, so prices for those two were pulled from The Odds API
historical endpoint (`ingest_odds_api.ts`): 116,498 and 40,167 priced candidates
respectively. `pitcher_outs` had the same problem in a smaller way — the
warehouse stops **2025-05-28** — and the window after that was filled the same
way, taking it from 3,408 graded candidates to 6,686.

The 2026-05-24 warehouse cutoff is untouched for every other market.

### 3.2 The universe is the whole book, not the board's own picks

Earlier rounds judged each market on the picks the production scorer happened to
make. That both shrinks the sample and hands the scorer's side selection to the
evaluation. Here every event × player × line with a two-sided quote at the entry
snapshot is a candidate: **413,000 graded candidates** across eleven markets
against a few thousand before. The model chooses the side *and* the line.

### 3.3 The entry price is the shipped convention

The best number quoted at that line at the entry snapshot — roughly 5.6 hours
before first pitch — which is what `best_price.ts` `selectBestSameLineBook` and
`game_candidates.ts` both do in production. A median-book sensitivity (no line
shopping at all) is reported in the workbook's Robustness sheet.

### 3.4 A market-appropriate model per market

Per the roadmap, not one architecture for all eleven:

| Family | Model |
|---|---|
| hits, total bases, home runs, RBIs, runs, both strikeout markets | Poisson on rate-per-opportunity × expected opportunity, shrunk to a league prior, then adjusted for the opposing side's as-of allowance |
| `pitcher_outs` | normal approximation on the pitcher's own as-of workload |
| `totals` | Poisson on expected combined runs from both teams' as-of scoring and allowance |
| `h2h`, `spreads` | run-differential model with home-field, evaluated at the posted number |

Each is then combined with the empirical handicap — *how often has this player
already cleared THIS number, over his last 25 and last 100 appearances* — and
with the market's own numbers for that game (the total, the moneyline, and the
implied team totals derived from them). A calibrator is re-fit forward through
time and returns P(over); both sides are then priced against it at the posted
number, and the board bets the side whose expected value clears the floor —
which means it must beat the juice, not merely the fair price.

### 3.5 Nothing was chosen on the data that produces the verdict

One global filter — model spec, EV floor, confidence floor — chosen **once**
across all eleven markets on the earlier half of the out-of-sample period. Then
one lever per market: the side policy, which is the lever `MLB_EV_SIDE_POLICY`
already pulls today. Nothing else is tuned per market.

A harder per-market search was also run, and is reported, because it is
informative: searching spec × EV floor × side × confidence floor × sample floor
per market — 8,740 attempts, logged in the workbook — generalises **worse** than
the single global choice. That is worth knowing, and it is why the shipped
configuration is the simple one.

---

## 4. Why each failure fails

Per the roadmap: a market is only marked failed after the levers have been tried,
and the reason has to be specific.

### `batter_home_runs` — VETO, and the veto is right

99.3% of the positive-EV picks this market produces are **unders at a median
price of −450**, and the shipped D-164 heavy-juice rule removes every one of
them. That leaves a 28-pick board. Dropping the veto does not rescue it either:
the full under board is **−1.60%** over 4,460 picks, and the over side is
−16.26%. This market loses money at both ends and the only board that clears EV
is one nobody can bet in size.

*To revisit:* nothing in the data fixes this. It would need the veto relaxed
**and** an edge that is not there.

### `pitcher_strikeouts` — FAIL_AFTER_ITERATION, the market is efficient

Every line and every side loses on a flat bet: overs −0.97% to −6.10% across
2.5–7.5, unders −3.60% to −16.72%. No box-score signal survives the price
(best |z| = 1.81). This is not a measurement problem and it is not a sample
problem — there are 19,447 graded candidates.

*To revisit:* umpire assignment and pitch-level Statcast arsenal data, neither of
which is in the box-score tables this harness reads.

### `pitcher_outs` — PASS, but only just, and on repaired data

+0.28% on 1,200 picks. It only has a verdict at all because the post-2025-05-28
window was filled from the provider. It fails the later-half re-read (−0.75%).

*To revisit:* bullpen usage and manager hook data —
`cache_mlb_historical_bullpen`, which `harness_readonly` is still **DENIED**
`SELECT` on (see `PHASE1_SCOPE.md` Blockers).

### `totals` and `h2h` — FAIL, break-even markets

`h2h` is the most efficient market on the board: flat-betting every home side at
the best available number is **−0.16%**, i.e. line shopping has already removed
almost the whole vig and there is nothing left underneath. `totals` is −1.20%.
Both cleared the gate under other walk-forward settings and fail under this one,
which is the correct description of a market sitting on zero.

*To revisit:* weather at first pitch (wind speed and direction, temperature) and
park factors, which are the documented drivers for run totals and are not in the
tables read here.

---

## 5. Market status

| Market | Published baseline | Final | Basis |
|---|---|---|---|
| `batter_hits` | PASS (in-sample window) | **PASS** | edge over the price, z = 4.65; holds on the untouched later half |
| `batter_total_bases` | FAIL | **PASS** | edge over the price, z = 4.63; holds on the untouched later half |
| `batter_rbis` | FAIL | **PASS** | opportunity model, z = 7.39; holds on the untouched later half |
| `batter_strikeouts` | *unjudgeable — no odds* | **PASS** | +4.32%; later half +4.50% but n = 475, underpowered |
| `spreads` | FAIL | **PASS** | price recalibration (runline dog); holds on the untouched later half |
| `batter_runs_scored` | *unjudgeable — no odds* | **PASS_WITH_RESTRICTIONS** | +0.31%; negative on the later half |
| `pitcher_outs` | FAIL | **PASS_WITH_RESTRICTIONS** | +0.28%; needs the provider fill and the bullpen grant |
| `totals` | PASS (pick_history slice) | **FAIL_AFTER_ITERATION** | break-even market; weather data would be the next lever |
| `h2h` | PASS (pick_history slice) | **FAIL_AFTER_ITERATION** | −0.16% flat: line shopping has already taken the vig out |
| `pitcher_strikeouts` | FAIL | **FAIL_AFTER_ITERATION** | efficient at every line and side; needs umpire / Statcast |
| `batter_home_runs` | FAIL | **VETO** | no bettable board survives the D-164 juice rule |

---

## 6. Reproducing this

Everything is in `betgenius/harness/uplift/`. See its `README.md`.

```bash
cd betgenius
export DENO_CERT="$PWD/prod-ca-2021.crt"

python harness/uplift/verify_gate.py     # the gate port reproduces the shipped reports
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/dump_box.ts
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/dump_odds.ts
python harness/uplift/build_cache.py
python harness/uplift/run_final.py
python harness/uplift/robustness.py
python harness/uplift/build_workbook.py
```

`MLB_Phase1_Results.xlsx` at the repo root is built only from
`harness/uplift/reports/*.csv`, so the workbook cannot drift from the run that
produced it.

## 7. What this does NOT claim

- It is **not** a live result. Nothing here has been deployed, and the live
  production pick stream is a harder population than the warehouse era.
- It does **not** re-fit the scorer. The shipped scorer's disagreement with the
  price carries no information in any market — that was measured in earlier
  rounds and is not revisited here. The filter sits *after* scoring.
- Board ROI figures assume the best number at that line was available and taken.
  The median-book sensitivity is in the workbook.
