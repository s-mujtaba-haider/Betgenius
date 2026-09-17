# Round 5 — final report

**Status: CLOSED WITHOUT A CHANGE TO THE TABLE.**
The round-4 result stands: **6/11 both-gates PASS**, full OOS 7/11, verdict 6/11.

Round 5 was commissioned to recover data, features and models from two research
branches and, if any of it survived honest validation, to improve the result.
The data half ran to completion and produced a definitive answer. The model half
was implemented, verified to work, and **halted before it was run**, at the
client's instruction that round 5 is unnecessary if the data has not changed.
It has not. Nothing below is estimated, projected or inferred — the experiments
that were not run are marked NOT RUN, not marked as failures.

---

## 1. The finding that closed the round

**No data changed, and none could.** Three independent checks:

| Check | Result |
|---|---|
| Do the branches exist? | **No.** Not in this repo, not on `origin`, not in the reflog, packed-refs or stash, not in `s-mujtaba-haider/MLB`, not in `s-mujtaba-haider/mlb-market-gate`, and not anywhere on `C:`. A whole-disk search for `mlb_markets.duckdb`, `POOLED_ML_STATUS.md`, `MILESTONE_1_GATE_REPORT.md` and all five named scripts returned **zero hits**. |
| Do they hold markets this warehouse lacks? | **No, on the evidence available.** `pitcher_outs` 14,067 raw rows here against 5,451 claimed; `batter_runs_scored` 76,297 two-sided here against 79,131 claimed — within 4%. The one market where the branch claims materially more (`batter_strikeouts`, 60,862 vs 38,805) is short of **settlements, not odds**. |
| Can the Odds API still supply gradeable history? | **No.** 2020-2022 return HTTP 422 — the provider does not serve them, re-confirmed 2026-09-17. 2023 *is* served from 2023-05 with all 11 markets, but `boxscores.csv` spans 2024-04-01 → 2026-09-16 with **zero 2023 rows**, so no 2023 candidate can be settled. Not purchased. 356,468 credits remain; the probe cost 670. |

**Rows imported in round 5: zero. Credits spent on data: zero.**

Round 4 had already exhausted the purchasable-and-settleable surface: 2,111
events, 331,675 credits, graded rows 412,886 → 529,695.

## 2. The second finding: the branches' features were already here

Every feature either guide names was checked against the live source. All four
headline ones already exist in this project, in most cases over a longer window:

| Branch feature | Here |
|---|---|
| team Elo | `features.elo()` — K=4.0, home-field 24 pts, log MOV damping, 0.30 season revert. Causal by construction |
| player / pitcher L10 | last-**25** and last-**100** appearance roll-ups, plus 5-start vs 25-start starter form |
| bullpen fatigue | `features.bullpen()` — relief runs per out, K and BB per batter faced, innings per game |
| park factors | `parkRunRel` / `parkHrRel` — last 100 games in that ballpark, shrunk to the league rate |

Same for the models: HistGradientBoosting, RandomForest and LogisticRegression
were already ensemble members, and Poisson / negative-binomial count models were
already built per prop market.

**The recoverable surface was three items: XGBoost, LightGBM, and the pooled
architecture.** Nothing else on either branch was new to this project.

## 3. What was built and not run

Round 4's E26 recorded why XGBoost and LightGBM had never been tested:
*"LightGBM/XGBoost/CatBoost not importable and installing a dependency needs
sign-off."* Round 5 installed them (xgboost 3.4.1, lightgbm 4.7.0) and wired
them in. The code is present, working and **verified inert** with respect to
every existing result.

| Artefact | State |
|---|---|
| `policy._fit_predict_xgb` (R5-01) | built, fitted and scored successfully on `h2h` and `totals` |
| `policy._fit_predict_lgbm` (R5-02) | built, fitted and scored successfully, `deterministic=True` |
| `policy.SINGLE` → `nb` / `poi` (R5-03) | built; correctly absent (NaN) on the three game markets, which have no count column |
| `policy.RECENCY` → `gbmW` / `gbmR` (R5-05) | built and scored successfully |
| `run_final_r5.py` | written — the round-4 runner with four members added to the override pool. `run_final_r4.py` is **not edited** |
| `exp_pooled_r5.py` (R5-04) | written, with the five-seed stability diagnosis ahead of the result |
| `exp_recency_r5.py` (R5-05) | written |
| `exp_model_comparison_r5.py` | written |
| `build_cache_r5.py` | written — computes only the six new members and merges them into a copy of the round-4 cache, refusing to merge unless the rebuilt frame compares **exactly equal** to the cached one |

**Verification that the additions cost nothing:** `h2h` was rebuilt from the
original `data/` with the default member list and compared to the round-2 cache
member by member — `box`, `compact`, `gbm`, `iso`, `offset`, `price` all
**bit-identical**, frame identical. `verify_gate.py` replays the shipped reports
with **0 mismatches**. `run_final_r4.py` reproduces the round-4 table exactly
(6/11 both gates) from the current source.

**What remains unknown:** whether XGBoost or LightGBM would have changed any
market's verdict. Round 5 does not guess. The remaining cost is one cache build —
about 45 minutes of wall time at three-way parallelism using `build_cache_r5.py`,
then `run_final_r5.py --conf=60 --tag=_r5`.

## 4. What the branch results are worth, and why none was imported

| Branch claim | Treatment | Reason |
|---|---|---|
| `hits`, `rbis`, `spreads` PASS | **Not imported** | The guide itself says `hits`/`rbis` come from the XGBoost script, the same script it flags for threshold exposure. No verdict-window equivalent exists there: one split, scored once. |
| Best-of-5 threshold result | **Rejected without testing** | A threshold selected on the test set it is then scored on is not evidence. The branch says so too. |
| `batter_home_runs` ROI +0.68%, CI low −1.07% | **Rejected without testing** | The branch's own guide declines to count it. |
| 6 of 48 model/market combinations clearing the gate | **Treated as screening only** | No two models agree and every passing CI spans zero — the branch's own reading. |
| `8-pooled-ml` edge>0.03 PASS, n=1,264, ROI +5.65% | **Rejected without testing** | One of four thresholds tried, and the branch's Addendum 26 records that the same model re-run flips the verdict. The verdict is the noise. |

Two limitations the guides do not disclose, found here:

1. **Neither guide states an entry-time convention anywhere.** Round 4 measured
   that convention to be worth three markets (T−1h → 2/11 verdict passes,
   T−6h → 5/11). Without it, every branch ROI is unanchored — and a closing-price
   snapshot would carry outright look-ahead relative to a T−6h entry. This alone
   is sufficient reason not to import a row. See
   `reports/entry_time_reconciliation.txt`.
2. **`3-pass-markets` evaluates 10 markets, not 11** — it omits `batter_home_runs`
   from its core list. This project evaluates 11 and the denominator did not move.

## 5. The table — unchanged from round 4

Reproduced from the current source on 2026-09-17, bit-identical to `_r4v`.

| Market | Model | Full OOS n | Full OOS ROI | Full OOS CI low | Full OOS gate | Verdict from | Verdict n | Verdict ROI | Verdict CI low | Verdict gate | Robustness | Status |
|---|---|---:|---:|---:|---|---|---:|---:|---:|---|---|---|
| batter_hits | gbm | 2,083 | 13.16% | 9.60 | PASS | 2025-08-08 | 1,269 | 14.46% | 9.51 | PASS | 6/6 | **PASS** |
| batter_total_bases | rf *(override)* | 5,356 | 1.65% | −0.47 | PASS | 2025-08-31 | 2,424 | 1.07% | −2.06 | PASS | 6/6 | **PASS** |
| batter_strikeouts | gbm | 1,676 | 6.98% | 3.14 | PASS | 2024-06-19 | 751 | 4.57% | −1.15 | PASS | 6/6 | **PASS** |
| pitcher_strikeouts | gbm | 2,407 | 2.27% | −1.07 | PASS | 2025-08-25 | 1,159 | 3.37% | −1.34 | PASS | 6/6 | **PASS** |
| pitcher_outs | gbm | 1,957 | 1.09% | −2.73 | PASS | 2026-04-01 | 871 | 0.43% | −5.12 | PASS | 6/6 | **PASS** |
| batter_runs_scored | gbm | 7,337 | 0.41% | −1.48 | PASS | 2025-04-19 | 2,931 | 0.41% | −2.46 | PASS | 5/6 | **PASS** |
| totals | gbm | 569 | 0.99% | −7.18 | PASS | 2025-08-27 | 221 | −3.17% | −16.12 | FAIL | 3/6 | PASS_WITH_RESTRICTIONS |
| batter_rbis | gbm | 2,740 | −0.10% | −2.91 | FAIL | 2025-09-06 | 1,020 | −0.66% | −5.47 | FAIL | 5/6 | VETO |
| batter_home_runs | gbm | 29 | −13.97% | −41.31 | FAIL | 2025-05-24 | 15 | −16.27% | −58.06 | FAIL | 0/6 | VETO |
| spreads | price *(override)* | 2,463 | −0.80% | −3.96 | FAIL | 2025-08-25 | 1,387 | −2.91% | −6.82 | FAIL | 1/6 | FAIL_AFTER_ITERATION |
| h2h | gbm | 1,524 | −0.34% | −4.65 | FAIL | 2025-08-29 | 639 | −6.16% | −12.95 | FAIL | 0/6 | FAIL_AFTER_ITERATION |

```
Full OOS PASS   : 7 / 11
Verdict PASS    : 6 / 11
BOTH gates PASS : 6 / 11   <- the number that matters
Production parity: 0 of 28,141 board rows rejected
```

**The target of 11/11 and the minimum of 9/11 were not reached, and round 5 did
not move either number.** Global filter: spec `gbm`, EV floor 0.02, confidence
floor 60 (pinned, never searched), ladder collapse `maxEv`.

## 6. Why the branches were never likely to close the 6 → 9 gap

Not a post-hoc excuse — these were all measured before round 5 began, and they
are the reason the pre-registration scoped round 5 to three items rather than
promising a number.

* **The model has less skill than the price on 9 of 11 markets**, by 10-30× the
  noise band on the four that fail. Two more tree libraries do not address that.
* **The selection objective rewards disagreement, not calibration.** A
  better-calibrated probability disagrees with the price less, so it produces a
  *smaller* board — and the gate needs n ≥ 500. Proven: overriding
  `pitcher_strikeouts` to `price` took its board from 2,407 rows to 1.
* **Predicted edge is nearly useless as a ranking signal.** The 3-5% predicted
  bucket pays −2.00%; the 10%+ bucket predicts 19.61% and pays 1.95%. That is a
  selection problem a better probability model does not fix.
* **2026 is materially harder**: board ROI 1.98% / 3.15% / 0.62% across
  2024 / 2025 / 2026, concentrated in the three game markets. `h2h` 2026 is
  −7.26% and `spreads` 2026 is −3.97%, against positive 2024 and 2025.

## 7. What would actually move the number

In order of expected value, and none of it is a modelling change:

1. **Re-run the 2026-05-27/28 boxscore backfill with the full column set.** It
   populated a reduced set, leaving `runs_scored` and `batter_strikeouts` absent
   from `cache_mlb_boxscore_player_stats` for 2025-03 and 2025-06 → 2026-05.
   `batter_runs_scored` covers 2,954 games and `batter_strikeouts` 1,439 against
   5,393 for `batter_hits`. **The odds for those dates already exist — only the
   outcomes are missing.** This is a warehouse write, outside this pack's scope.
2. **Start capturing a second odds snapshot per event.** One snapshot per
   (event, line) means CLV cannot be computed and price movement cannot be used.
3. **Normalise the entry-snapshot schedule.** 6.01 h in 2024-2025, 1.01 h in
   2026, inside the same warehouse.
4. **Keep accumulating Statcast.** It starts 2026-05-20 — too short to gate on
   today, and the one source that may hold something the book does not price.

## 8. Deliverables produced

| File | What it is |
|---|---|
| `BRANCH_RESEARCH_INVENTORY.md` | The branch audit and the full search record |
| `OPTIMISATION_ROUND5_PLAN.md` | The pre-registration, written before any number existed |
| `OPTIMISATION_ROUND5_FINAL.md` | This file |
| `reports/experiment_log_r5.csv` | Every experiment, with NOT RUN marked as NOT RUN |
| `reports/branch_data_overlap.csv` | Per-dataset overlap categories and reasons |
| `reports/entry_time_reconciliation.txt` | The timing audit and the decision not to import |
| `reports/data_expansion_r5.csv` | Odds API probe results, credits, per-season verdicts |
| `reports/feature_comparison_r5.csv` | Every branch feature vs this project, with leakage status |
| `reports/round5_audit/` | Data, model, environment and production documentation |

Not produced, because round 5 changed nothing: `reports/final_matrix_r5.csv`,
`reports/robustness_r5.csv`, `reports/model_comparison_r5.csv`,
`reports/version_comparison_r5.csv`. Writing a "round 5 final matrix" that is a
copy of round 4's would imply a run that did not happen. The round-4 artefacts
(`reports/final_matrix_r4v.csv`, `reports/robustness_r4v.csv`) remain the
authoritative table.

## 9. Preservation

Nothing was overwritten. `checkpoint_c60/` and `checkpoint_r4_baseline/` are
untouched, `run_final.py` and `run_final_r4.py` are unedited, `data/` was never
written to, and every previous report and experiment log is intact. The
`policy.py` additions are new branches only — verified bit-identical output for
every shipped member — and every round-5 script carries an `_r5` suffix.
