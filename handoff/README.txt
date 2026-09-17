================================================================================
BETGENIUS / SharpAI -- MLB PHASE 1
FINAL DELIVERY -- CLIENT HANDOFF
================================================================================

PROJECT           BetGenius (the product ships as SharpAI; the repository,
                  the Vercel domain and package.json still say "betgenius")
VERSION           FINAL
COMMIT            2629293f09fb28343378a111340b80766da731f5
REPOSITORY        private development repository (identity withheld; the
                  complete source tree ships in project/)
PACKAGED          2026-09-17

HISTORICAL RESULT     6 / 11 markets PASS on both gates
TARGET               11 / 11
MINIMUM               9 / 11          -- NOT MET

LIVE / PRODUCTION PERFORMANCE IS REPORTED SEPARATELY, IN FINAL_RESULTS.TXT
PART 2. On the current data there are no unsettled board rows and no
post-deployment observations, so NO LIVE PASS/FAIL CAN BE COMPUTED. The live
section reports board coverage, volume and serving status instead. It must never
be combined with the historical result.


--------------------------------------------------------------------------------
READ THIS FIRST: WHAT IS AND IS NOT DEPLOYED
--------------------------------------------------------------------------------
The live product generates its picks from
`supabase/functions/_shared/scoring_mlb_v2.ts` plus the `algorithm_weights`
table -- a hand-weighted factor scorer.

THIS WORK IS NOT THAT SYSTEM. This work is an offline UPLIFT STUDY: it fits its own
models on the same priced universe the product sees, and asks whether a fitted
model can select a board that beats the vig under the product's own pass/fail
gate. Its code (`harness/uplift/*.py`) imports nothing from the production
scorer, and nothing in production imports it.

NO THE FINAL CONFIGURATION MODEL IS SERVING TRAFFIC. "Production parity PASS" means every pick
The final configuration selects WOULD be servable if it were shown -- a necessary condition for
deployment, not evidence of it. What deployment would still require is listed in
AUDIT_COMPLETE.txt section 30.4.


--------------------------------------------------------------------------------
WHAT THE SYSTEM DOES
--------------------------------------------------------------------------------
For each of 11 MLB betting markets it:

  1. Takes every priced candidate -- a (game, player, line) or (game, line) that
     a sportsbook quoted on BOTH sides at the entry snapshot.
  2. Grades it against the real box score.
  3. Builds 47-65 point-in-time features per row: the de-vigged market price,
     parametric price models, player form, opportunity, opposing pitching,
     bullpen, park factors, Elo, and cross-market context -- every one of them
     computed from strictly earlier calendar dates.
  4. Fits a calibrated probability model forward through time (expanding-window
     walk-forward, 40 refit blocks, 25% warm-up, fold boundaries on the clock),
     so every scored row was predicted by a model that could not have seen it.
  5. Prices BOTH sides against that probability at the posted numbers and bets
     the side whose expected value clears the floor.
  6. Applies the shipped product filters: confidence >= 60, the D-164
     heavy-juice under veto, the per-market side policy, one bet per unit.
  7. Grades the resulting board under the shipped pass/fail gate, on TWO
     windows -- and the later window is never read while anything is chosen.


--------------------------------------------------------------------------------
DATA
--------------------------------------------------------------------------------
    Odds      Supabase `cache_mlb_historical_odds` (18.6M rows, 2023-05 ->
              2026-05) plus an Odds API expansion pull covering 2026-06 ->
              2026-09 at a T-6h entry lead.
    Outcomes  Supabase `cache_mlb_boxscore_player_stats` -- 5,914 games,
              321,890 player-game rows, 4,419 players, 2024-04-01 -> 2026-09-16.
    Universe  530,193 priced candidates, 529,695 graded, 5,421 games used.

    The complete data snapshot IS INCLUDED in this package
    (project/betgenius/harness/uplift/data_expanded_6h, 329 MB, 25 files, all
    hashed in reports/reproducibility.txt). You can reproduce the entire
    result with no network access and no API credits.

    Full detail: DATA_DOCUMENTATION.txt


--------------------------------------------------------------------------------
THE ML PIPELINE
--------------------------------------------------------------------------------
    9 markets   HistGradientBoostingClassifier  (scikit-learn)
    1 market    RandomForestClassifier          (batter_total_bases)
    1 market    LogisticRegression on the de-vigged price alone (spreads)

    440 estimators fitted to produce the shipped table (11 markets x 40 folds).
    0 estimators persisted to disk -- only their out-of-sample probabilities.

    XGBoost, LightGBM, CatBoost and FLAML were NOT used and are NOT dependencies.
    The boosted member is scikit-learn's histogram-boosting implementation.

    Full detail: MODEL_DOCUMENTATION.txt


--------------------------------------------------------------------------------
VALIDATION
--------------------------------------------------------------------------------
THE GATE (unchanged from the shipped product, harness/lib/metrics.ts)
    PASS if  n >= 500 AND ROI > 0
    PASS if  n <  500 AND the 95% ROI CI lower bound > 0
    FAIL otherwise

TWO WINDOWS
    FULL OOS        every scored row. Optimistic, because its earlier half was
                    used to choose the filter and the side policy.
    VERDICT WINDOW  the later half of each market's out-of-sample period, split
                    at the median commence time. NEVER READ while anything was
                    chosen. This is the clean number.

    The headline is the BOTH-GATES count: 6 / 11.

SIX ROBUSTNESS VARIANTS
    placebo lag 1/3/7 days; median book instead of best price; a different
    walk-forward schedule. Each changes one thing and re-runs everything.
    Five of the six PASS markets survive all six. The placebo-lag profile is
    flat to slightly rising, which is the signature of a form signal rather than
    a leak.

PRODUCTION PARITY
    0 of 28,141 board rows rejected by the shipped eligibility predicates.

    Full detail: FINAL_RESULTS.txt, AUDIT_COMPLETE.txt sections 23-28.


--------------------------------------------------------------------------------
THE PRODUCTION PIPELINE
--------------------------------------------------------------------------------
    Ingestion -> normalization -> candidate generation -> grading ->
    point-in-time features -> walk-forward fit -> probability -> edge ->
    confidence -> policy filter -> board -> gate.

    PRODUCTION_SETUP.txt documents every command, all of them verified against
    the actual project code. None was invented.


--------------------------------------------------------------------------------
LIMITATIONS YOU SHOULD KNOW BEFORE READING ANY NUMBER
--------------------------------------------------------------------------------
 1. The validated models are NOT deployed. There is no inference path for an
    unplayed game and no persisted model.
 2. 2026 is roughly a FIFTH as profitable as 2025, measured on 9,476 picks. The
    decay is concentrated in the three game markets.
 3. TWO THIRDS OF THE VERDICT UNITS DEPEND ON BEST-PRICE EXECUTION. At the
    median book the verdict units fall from 202.7 to 73.4.
 4. `batter_strikeouts` -- one of the six PASS markets -- is VALIDATED ON 2024
    DATA ONLY. The books no longer offer it. Quote it with that caveat always.
 5. `totals` is PASS_WITH_RESTRICTIONS, which means it clears ONE gate and fails
    the other. It is not a seventh pass.
 6. Predicted edge is OVERSTATED BY 3 TO 18 PERCENTAGE POINTS at every level.
    The EV filter works as a threshold, not as a ranking signal.
 7. A twelve-month box-score hole (2025-06 -> 2026-05) limits two markets.
 8. No CLV measurement is possible -- the warehouse holds ~2 price snapshots per
    event, too sparse to reconstruct line movement.
 9. The warehouse odds table stopped on 2026-05-24. Box scores are current.
10. No post-deployment evidence exists for any market.
11. SECURITY: two API keys were previously exposed in a public repository and
    have NOT been rotated. Rotating them is the highest-priority open action.
    No credential of any kind ships in this package.

    Full detail: AUDIT_COMPLETE.txt sections 42-44.


--------------------------------------------------------------------------------
DOCUMENTATION MAP
--------------------------------------------------------------------------------
    README.txt                          this file
    AUDIT_COMPLETE.txt                  the full 46-section forensic audit --
                                        the most complete document here
    FINAL_RESULTS.txt                   the definitive result tables, with
                                        historical and live kept apart
    BETGENIUS_COMPLETE_DOCUMENTATION.txt  how the whole system works, end to end
    MODEL_DOCUMENTATION.txt             every model, hyperparameter and rejection
    DATA_DOCUMENTATION.txt              sources, schema, coverage, regeneration
    PRODUCTION_SETUP.txt                the operational runbook
    ENVIRONMENT_SETUP.txt               install and smoke test
    CLIENT_HANDOFF_CHECKLIST.txt        what is in the box, verified
    HANDOFF_MANIFEST.txt                every file, with purpose and size
    VERSION_INFO.txt                    version, commit, snapshot, parity

    results/                            the authoritative final outputs
    reports/                            supporting evidence and logs
    docs/                               the full research record, unaltered
    project/                            the complete source tree plus the data
    configs/                            requirements.txt, package.json, lockfiles
    scripts/                            convenience runners


--------------------------------------------------------------------------------
FIVE-MINUTE START
--------------------------------------------------------------------------------
    1. Read FINAL_RESULTS.txt Part 1 -- the eleven-market table.
    2. Read AUDIT_COMPLETE.txt section 1 -- the executive summary, including
       what is not deployed.
    3. cd project/betgenius && pip install -r requirements.txt
    4. python harness/uplift/verify_gate.py
       -- the smoke test. No credentials, no network. It should print
          "2 shipped reports replayed, 0 mismatches".
    5. ENVIRONMENT_SETUP.txt for the full install; PRODUCTION_SETUP.txt to
       regenerate the board.


--------------------------------------------------------------------------------
AN HONEST ONE-PARAGRAPH SUMMARY
--------------------------------------------------------------------------------
Six of eleven MLB markets clear the product's own pass/fail gate on two separate
windows -- the second of which was never looked at while any decision was made
-- and five of those six survive a six-variant stress test designed to break
them. The whole result reproduces bit-identically from the data and source in
this package. It is also a backtest. Its most recent season is materially worse
than the one before it, two thirds of its profit depends on getting the best
price available, one of its six passing markets is validated on a single season
and is no longer offered, and not one pick has yet been observed in production.
Treat it as a well-controlled research result that earns a monitored pilot, not
as a system ready to be switched on.
