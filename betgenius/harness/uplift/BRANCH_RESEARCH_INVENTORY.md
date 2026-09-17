# Branch research inventory — `3-pass-markets` and `8-pooled-ml`

Round 5, Part 1. Written before any round-5 number existed.

---

## 0. Headline finding: neither branch is reachable from this project

**Both branches are absent.** They are not in this repository, not on its
remote, not in any other repository on this GitHub account, and not anywhere on
this machine. The only trace of them that exists here is the two testing guides
the client pasted into the working tree
(`TESTING_GUIDE_3_PASS_MARKETS.md`, `TESTING_GUIDE_8_POOLED_ML.md`, both
untracked, both dated 2026-09-17).

This is not a "could not check out" — it is a "the artefacts do not exist on
this machine." Everything asserted below about either branch is therefore
sourced **from the two guides only**, and is treated as a claim to be tested,
never as data.

### The searches that establish it

| Check | Command | Result |
|---|---|---|
| Local branches | `git branch -a` | `backup-pre-author-rewrite`, `checkpoint/c60-round2`, `main`, `round3/deep-optimisation`, `round4/deep-optimisation` — and their `origin/` mirrors. Neither name present. |
| Remote | `git remote -v` -> `github.com/s-mujtaba-haider/Betgenius.git` | Same five. |
| Deleted-branch recovery | `git reflog --all`, `.git/packed-refs`, `git stash list` | 30 reflog entries, all accounted for by rounds 1-4. No packed refs. No stashes. No dangling commit mentions either name. |
| Whole object store | `git log --all --oneline` | 12 commits total, all on the five known branches. |
| Other repos on the account | `gh repo list --limit 100` | Two other MLB repos exist: `s-mujtaba-haider/MLB` (branch `mlb-phase1`) and `s-mujtaba-haider/mlb-market-gate` (branch `main`). |
| Their branch lists | `gh api repos/.../branches` | `MLB` -> `mlb-phase1` only. `mlb-market-gate` -> `main` only. Neither name present. |
| Their file trees | `gh api .../git/trees/...?recursive=1` | Neither contains `MLB Markets/`, `db/mlb_markets.duckdb`, `HANDOFF.md`, `POOLED_ML_STATUS.md`, `reports/MILESTONE_1_GATE_REPORT.md`, or any of the named scripts. Different codebases (`src/mlbgate`, `src/mlbedge`). |
| Whole disk | PowerShell recursive search of `C:\Users\mujta` (and `C:\Projects`, `C:\dev`, `C:\work`, `D:\` where they exist) for `mlb_markets.duckdb`, `POOLED_ML_STATUS.md`, `MILESTONE_1_GATE_REPORT.md`, `xgboost_pooled_A_factors.py`, `test_backfilled_markets.py`, `multi_model_comparison.py` | **Zero hits.** |

**Consequence for the brief.** Parts 2-9 and 30-34, as written, require the
branch working trees. They cannot be executed as specified. What *can* be
executed — and is, in the rest of round 5 — is the part that actually matters:
take every idea the guides describe, check whether this project already has it,
and test what it does not. That work is real and is reported honestly. The
row-level data reconciliation (Parts 3, 8, 9) is reported as **BLOCKED**, with
the reason above, rather than fabricated.

---

## 1. `3-pass-markets`

| Field | Value |
|---|---|
| **Branch** | `3-pass-markets` |
| **Commit** | **UNKNOWN** — no ref, no hash, no object reachable from here |
| **Date** | **UNKNOWN**. Guide file mtime 2026-09-17; the guide references 34 addenda, so the branch long predates it |
| **Repository** | A project rooted at `MLB Markets/`, with `db/`, `scripts/`, `data_raw/`, `reports/`. **Not this repository** — this one is rooted at `betgenius/harness/uplift/` and holds no DuckDB file |
| **Purpose** | "Milestone 1 deliverable": run 10 core markets through a gate, report which clear it |
| **Data** | `db/mlb_markets.duckdb` (claimed real, committed); `data_raw/*_odds_cache.jsonl` (claimed Odds API historical backfill caches) |
| **Models** | XGBoost per market; plus LightGBM, HistGradientBoostingClassifier, RandomForest, LogisticRegression, FLAML AutoML in the sweep; plus a tuned-XGBoost pass |
| **Features** | Named as: team Elo, L10 form, bullpen fatigue, park factors. No further detail given |
| **Scripts** | `scripts/gate.py`, `scripts/test_backfilled_markets.py`, `scripts/xgboost_individual_markets.py`, `scripts/multi_model_comparison.py`, `scripts/tuned_xgboost_4_markets.py` |
| **Reports** | `reports/MILESTONE_1_GATE_REPORT.md` (34 addenda), `reports/gate_results.csv`, `reports/multi_model_comparison_output.txt`, `reports/tuned_xgboost_4_markets_output.txt` |
| **Known results (claimed)** | `hits`, `rbis`, `spreads` PASS; 8 FAIL. Backfilled markets all FAIL: `pitcher_outs` n=5,451/test 3,334 ROI -1.21%; `batter_runs_scored` n=79,131/test 52,981 ROI -2.54%; `batter_strikeouts` n=60,862/test 41,489 ROI -0.87%. Multi-model: 6 of 48 combinations clear the gate, spread over 4 markets, no two models agreeing. Tuned XGBoost: 3 of 4 reverse to FAIL; `batter_home_runs` a near-miss at ROI +0.68%, CI low -1.07% |
| **Known limitations (the branch's own)** | Its own guide §7 states the n>=500 arm needs only a positive point estimate; that a pass from one model/search is not promoted; that the best-of-5-threshold result carries multiple-comparisons exposure and is "not a second finding"; that the `batter_home_runs` near-miss is explicitly **not** counted as a confirmed pass |
| **Limitations found here, not disclosed there** | **(a) 10 markets, not 11** — it omits `batter_home_runs` from the core list while testing it in the tuning step. **(b) Entry-time convention is never stated anywhere in the guide.** Round 4 of this project measured that convention to be worth three markets (see `reports/entry_time_reconciliation.txt`), so an unstated convention makes every ROI in the branch unanchored. **(c)** "hits/rbis pass via the XGBoost work, not `gate.py`" — i.e. two of its three headline passes come from the same script the guide flags for threshold exposure. **(d) No verdict-window equivalent**: one split, scored once; this project's PASS requires clearing the gate twice, on two windows, the later of which is never read during selection |
| **Potentially reusable** | The **model families** (XGBoost, LightGBM, FLAML) — see §3. The **feature names** — see §3. Nothing else is recoverable without the tree |

## 2. `8-pooled-ml`

| Field | Value |
|---|---|
| **Branch** | `8-pooled-ml` |
| **Commit / Date** | **UNKNOWN**, as above |
| **Purpose** | Exploratory cross-market pooled ML. The guide's own first paragraph: "deprioritized research branch … not an alternative result … Nothing below changes any PASS/FAIL verdict" |
| **Data** | Same `db/mlb_markets.duckdb` |
| **Models** | Model A: one pooled XGBoost over ~150 production factors, market type as a categorical. Model B: one pooled XGBoost over self-built features across 2023-2026 |
| **Features** | Model A: the production factor table, which exists **only 2026-05-17 -> 2026-07-27**. Model B: team Elo, L10, ballpark factors, bullpen fatigue |
| **Scripts** | `scripts/xgboost_pooled_A_factors.py`, `scripts/xgboost_pooled_B_multiyear.py`, `scripts/check_favorite_accuracy_vs_roi.py` |
| **Reports** | `POOLED_ML_STATUS.md`, `reports/xgboost_pooled_A_output.txt`, shared `MILESTONE_1_GATE_REPORT.md` addenda 20-26 |
| **Known results (claimed)** | A: `ALL MARKETS edge>0` n=3,550, ROI -0.05%, CI [-2.55, 2.44] — fail at every threshold; `pitcher_strikeouts` and `pitcher_outs` n=0 (coverage gaps). B: one cut clears — `edge>0.03, minus-money`, n=1,264, ROI +5.65%, CI [1.56, 9.75] — out of 4 thresholds tried. `check_favorite_accuracy_vs_roi`: `batter_home_runs` ~88.9% accurate and still losing |
| **Known limitations (the branch's own)** | Addendum 26: **the same model re-run produces a different PASS/FAIL verdict from run to run.** The guide is explicit that "the verdict itself is the noise", that the one PASS is "not a 4th confirmed market", and that the prerequisite for resuming is fixing the instability first |
| **Limitations found here, not disclosed there** | Model A's 2.4-month window is 7% of this project's 29-month evaluation period and sits entirely inside 2026 — the season this project measured as materially the hardest (board ROI 1.98% / 3.15% / 0.62% for 2024/2025/2026). Model B's split is "75/25 chronological **within each calendar year**, then pooled", which trains on 2026 data and tests on 2024 data inside the same pooled test set. That is not a chronological holdout |
| **Potentially reusable** | The instability finding itself, as a **warning**, is the most valuable thing on the branch. The pooled architecture is testable here (R5-03) but the guide's own evidence argues against it |

---

## 3. What the branches have that this project does not

This is the only question the guides can actually answer, and it is the one
round 5 is built on. Each row was checked against the live source.

| Branch asset | Status here | Evidence |
|---|---|---|
| Feature: **team Elo** | **ALREADY PRESENT** | `eloDiff` in `policy.COMPACT["game"]`, built in `features.py` |
| Feature: **L10 / recent form** | **ALREADY PRESENT, and longer** | last-25 and last-100 appearance roll-ups (`clrEdge25`, `empP`), plus 5-start vs 25-start starter form |
| Feature: **bullpen fatigue** | **ALREADY PRESENT** | `features.bullpen()` — runs per out, K and BB per batter faced, innings per game, rebuilt from relief box-score lines |
| Feature: **park factors** | **ALREADY PRESENT** | `parkRunRel` — runs and HR per game in this ballpark over the last 100 games there, shrunk to the league rate |
| Model: **HistGradientBoosting** | **ALREADY PRESENT** | `policy._fit_predict_gbm`, the incumbent global spec |
| Model: **RandomForest** | **ALREADY PRESENT** | `policy._fit_predict_forest(kind="rf")`, plus ExtraTrees |
| Model: **LogisticRegression** | **ALREADY PRESENT** | `policy._fit_predict`, and `price` is a logistic on the price alone |
| Model: **Poisson / negative binomial count models** | **ALREADY PRESENT** | `features.py` builds both per prop market; round 4's E27 tested offering them as ensemble members directly |
| Model: **XGBoost** | **GENUINELY NEW** | not importable before round 5; installed 2026-09-17 (xgboost 3.4.1) |
| Model: **LightGBM** | **GENUINELY NEW** | not importable before round 5; installed 2026-09-17 (lightgbm 4.7.0) |
| Model: **FLAML AutoML** | **NEW, and rejected without testing** | An AutoML time budget searches model families and hyperparameters against a single objective on a single split. That is precisely the multiple-comparisons exposure round 4's guards exist to stop, and it cannot be made to honour the nested SELECT-A/SELECT-B contract without rewriting it into something that is no longer FLAML. Documented, not run |
| Architecture: **pooled cross-market model** | **NEW** | every model here is fit per market |
| Data: Odds API backfill of `pitcher_outs`, `batter_runs_scored`, `batter_strikeouts` | **ALREADY DONE HERE, independently and larger** | see `reports/branch_data_overlap.csv` |

**So the recoverable surface is three items: XGBoost, LightGBM, and the pooled
architecture.** Every named feature already exists in this project, in most
cases in a longer-window or better-documented form. That is the finding, and it
is what round 5's pre-registration is scoped to.
