# Round 5 — pre-registration

Written **before any round-5 number existed**, on 2026-09-17. Every acceptance
criterion below is fixed at the moment of writing and is not re-read, re-weighted
or re-scoped afterwards. Experiments that fail their criterion are reported as
failures and are not re-run with a changed bar.

The branch-recovery part of the brief is answered separately and first, in
`BRANCH_RESEARCH_INVENTORY.md`. Its conclusion is the scope of this plan:
**neither `3-pass-markets` nor `8-pooled-ml` exists on this machine**, so no row
of their data can be imported and no result of theirs can be reproduced. What
survives from them is a list of ideas, and exactly three of those ideas are not
already implemented here: **XGBoost**, **LightGBM**, and the **pooled
cross-market architecture**. Round 5 tests those three, plus two experiments
this project pre-registered in round 4 and never ran.

---

## Standing rules (unchanged from rounds 2, 3 and 4)

1. The gate (`mlbgate.py`) is not modified. `verify_gate.py` must keep replaying
   the shipped reports with 0 mismatches.
2. The confidence floor is pinned at **60**, the production contract
   (`isEvPassPick`, `harness/lib/metrics.ts:149`). It is never searched and never
   goes below 60.
3. **Full OOS** = the whole out-of-sample period after warm-up. **Verdict
   window** = the later half of that period, cut on the clock, per market.
4. The verdict window is **never read while choosing anything**. All selection
   happens on SELECT, and every adoption test is nested: a rule is re-derived on
   SELECT-A and scored on held-out SELECT-B.
5. Every final board row must pass the shipped serving predicates —
   `parity_audit.py` must print **0 rejected**.
6. Features may only read box scores from an earlier local calendar date.
7. Fold boundaries are **timestamps**, not row indices. A game lands wholly on
   one side of a boundary.

## Baseline

`_r4v`, commit `2629293`, dataset `data_expanded_6h/`, cache `cache_fam/`.

    both-gates PASS  6/11     full OOS 7/11     verdict 6/11
    PASS 6 | PASS_WITH_RESTRICTIONS 1 | VETO 2 | FAIL_AFTER_ITERATION 2
    parity 0 of 28,141 board rows rejected

Verified to reproduce bit-identically on 2026-09-17 before round 5 began
(`reports/final_r5repro.csv`). Physical baselines preserved in
`checkpoint_c60/` and `checkpoint_r4_baseline/`; nothing in round 5 overwrites
them, and every round-5 artefact carries an `_r5` suffix.

## Market universe — 11, and it does not change

`batter_hits`, `batter_rbis`, `batter_total_bases`, `batter_home_runs`,
`batter_runs_scored`, `batter_strikeouts`, `pitcher_strikeouts`, `pitcher_outs`,
`h2h`, `spreads`, `totals`.

The `3-pass-markets` guide evaluates **10** — it omits `batter_home_runs` from
its core list. This project evaluates 11 and will continue to, including the two
markets currently at VETO. **No market is added or removed in round 5 for any
reason.** The denominator is 11 in every number reported.

---

## Dependencies

`xgboost` 3.4.1 and `lightgbm` 4.7.0 were **installed on 2026-09-17**, and this
is disclosed rather than done silently. Round 4's E26 recorded the exact reason
they were absent: *"LightGBM/XGBoost/CatBoost not importable and installing a
dependency needs sign-off."* The brief for round 5 asks explicitly whether the
branch models can be tested, so they are installed and tested.

`catboost` is **not** installed and is **not** tested — it is not named in either
branch guide, so adding it would be scope this round did not earn.

`flaml` is **not** installed and is **not** tested. This is a decision, not an
omission: FLAML searches model families and hyperparameters against one objective
on one split inside a time budget. That is the multiple-comparisons exposure
round 4's three guards exist to catch, and there is no way to make it honour the
nested SELECT-A/SELECT-B contract without rewriting it into something that is no
longer FLAML. Recorded in the log as NOT_TESTED with this reason.

---

## The adoption rule every model experiment is judged by

This is **not a new rule**. It is E26's rule, which round 4 adopted and shipped,
reused verbatim so that round 5's candidates face exactly the bar round 4's did
and no easier one. Per market, a candidate member may replace the global
ensemble only if **all three** hold:

1. it is chosen first on SELECT-A by log loss at **all three** inner cuts
   q ∈ {0.5, 0.6, 0.7}, and it is the **same** member every time;
2. it beats the global spec on held-out SELECT-B log loss by more than
   **0.0011**, the noise band E8/E16/E19 measured, at **all three** cuts;
3. the resulting SELECT board still holds at least **500** rows
   (`EV_GATE_MIN_GRADED` — the gate's own floor, not a tuned number).

Log loss, not ROI, because ROI over a few hundred rows the model selected using
its own largest errors is not a scoring rule. Guard 3 exists because round 4
proved it must: a member better calibrated to the price disagrees with it less,
and a prop board is exactly the rows where the model disagrees, so without it an
override starved `pitcher_strikeouts` from 2,407 board rows to 1.

---

## R5-01 — XGBoost as an ensemble member

**Hypothesis.** XGBoost's regularisation and split-finding differ enough from
`HistGradientBoostingClassifier` that on at least one market it produces a
better-calibrated walk-forward probability. This is the direct test of the
`3-pass-markets` claim that per-market XGBoost is where its `hits` and `rbis`
passes came from.

**Design.** A new `xgb` member in `policy.walkforward`, fitted on the same
feature vector, in the same time-cut folds, under the same warm-up and refit
schedule as every other member. Hyperparameters fixed in advance to the
conservative shape the incumbent `gbm` uses, because a prop board carries one
weak signal and a boosted model given room finds the noise:
`max_depth=3, n_estimators=200, learning_rate=0.05, min_child_weight=200,
reg_lambda=5.0, subsample=0.8, colsample_bytree=0.8`. Single-threaded,
`tree_method="hist"`, `random_state=20260917`. **No hyperparameter search**, so
there is nothing to overfit and no threshold to select.

**Acceptance.** The adoption rule above. Reported per market whichever way it
goes.

## R5-02 — LightGBM as an ensemble member

**Hypothesis.** As R5-01, for LightGBM's leaf-wise growth.

**Design.** A new `lgbm` member. `num_leaves=8, max_depth=3, n_estimators=200,
learning_rate=0.05, min_child_samples=200, reg_lambda=5.0, subsample=0.8,
colsample_bytree=0.8, deterministic=True, force_row_wise=True, num_threads=1,
random_state=20260917`. The determinism flags are set because Part 33 requires
run-to-run stability to be established rather than assumed.

**Acceptance.** The adoption rule above.

## R5-03 — The count model as a member, not a feature (round 4's unrun E27)

**Hypothesis.** `features.py` already builds a Poisson (`parPAdj`,
`parPPark`), a negative-binomial (`parPNb`) and a binomial (`parPBin`) count
model per prop market and hands their implied P(X > line) to the calibrator **as
features among 45 others**. Offering that probability **directly** as a member
may preserve information the current path dilutes. Pre-registered in round 4 and
never run.

**Design.** Two new members built from cached columns only, no refitting:
`nb` (a logistic on `parPNb` alone) and `poi` (a logistic on `parPAdj` alone) —
the same one-column shape the `price` member already uses. Prop markets only;
game markets have no count column of this form and are left untouched.

**Acceptance.** The adoption rule above.

## R5-04 — The pooled cross-market model, and its instability (Part 33)

**Hypothesis.** `8-pooled-ml`'s architecture — one model across all markets with
market identity as a feature — pools 529,695 rows where a per-market model sees
between 5,956 and 120,269, and may therefore estimate shared structure better.
Its own guide reports this model to be **run-to-run unstable**, so the
instability is diagnosed first and the result is judged second.

**Design, in this order.**

(a) **Instability diagnosis.** Fit the pooled model **five times** with seeds
`{1, 2, 3, 4, 5}`, with row order, feature order and fold boundaries fixed and
identical across runs. Report the spread of SELECT-B log loss and of the gate
verdict across all five. **Every run is reported.** No run is selected.

(b) **Verdict.** If the five runs disagree on any market's gate verdict, the
pooled model is **rejected as a production candidate** and the instability is
reported as the finding, exactly as the branch's own status document
recommends. If they agree, it enters the adoption rule as one more member.

**Acceptance.** Stability first — max-minus-min SELECT-B log loss across the
five seeds must be **below 0.0011**, the same noise band every other experiment
is held to. Then the adoption rule. **Failing the stability test is a rejection,
not a reason to run more seeds.**

## R5-05 — Temporal adaptation (round 4's unrun E29; Part 20)

**Hypothesis.** The project measured board ROI at 1.98% / 3.15% / 0.62% for
2024 / 2025 / 2026, with the deterioration concentrated in the game markets. If
that is a regime change rather than noise, a training window that weights recent
seasons more heavily should improve held-out log loss.

**Design.** Three arms, all fitted inside the same walk-forward, all selected on
SELECT only, never on the verdict window:
- **A (incumbent)** — expanding window, uniform weight.
- **B** — expanding window, exponential recency weight, half-life 365 days.
- **C** — rolling window, most recent 365 days only.

Objective: **log loss on held-out SELECT-B**, a proper scoring rule.

**Acceptance.** An arm is adopted only if it beats arm A on SELECT-B log loss by
more than 0.0011 on **at least 6 of 11** markets. A window that wins on a
minority of markets is noise and is rejected.

---

## What is explicitly NOT done in round 5

| Not done | Why |
|---|---|
| Importing any branch row | The files do not exist on this machine. Documented in `BRANCH_RESEARCH_INVENTORY.md` and `reports/entry_time_reconciliation.txt` |
| Buying 2023 Odds API data | Odds are available from 2023-05, but `boxscores.csv` starts 2024-04-01, so no 2023 row can be settled. Verified in round 5, not assumed |
| Buying 2020-2022 data | HTTP 422 from the provider. Re-verified in round 5 |
| Adopting the branch's best threshold | Selected on its own test set. Inadmissible |
| Adopting the branch's `batter_home_runs` near-miss | Its own guide declines to count it |
| Adopting `8-pooled-ml`'s +5.65% PASS | Its own guide says the verdict is the noise |
| Any hyperparameter search on the new members | Nothing to overfit if nothing is searched. Round 4's gbmB/C/D already tested that axis |
| Widening the override pool to member pairs | E33 tested it and it made things worse |
| Touching the gate, the confidence floor, the market count, or the verdict window | Standing rules 1-4 |

---

## Stopping rule

Round 5 runs R5-01 through R5-05. **No experiment may be re-run with a changed
criterion after seeing its result**, and no result may be taken from a re-cut of
the same held-out tail. The final table is produced **once**, from the frozen
architecture, after all adoption decisions are closed.

## Final adoption criterion — the one that decides whether round 5 ships

The round-5 configuration replaces `_r4v` **only if both** hold:

1. **both-gates PASS count > 6** — strictly exceeds the round-4 baseline. A tie
   is not an improvement; round 4 rejected E24 and E32 on exactly that
   distinction and round 5 does not get a softer bar.
2. `parity_audit.py` prints **0 rejected**.

If either fails, `_r4v` stands and round 5 reports that. The six established
robustness variants are run on whichever configuration is final, unredefined,
and the pass count is reported as x/6 whatever it is.

## Honest-reporting clause

The target is 11/11 both-gates PASS and the stated minimum is 9/11. These are
objectives, not permission. If the answer is 6/11, round 5 reports 6/11 and names
the limitation. No market is dropped, no gate is loosened, no window is re-cut,
and no seed, threshold or split is chosen after its result is visible.
