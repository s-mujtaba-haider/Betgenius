# SharpAI / BetGenius — MLB Phase 1

A sports-betting prediction platform and, in this repository, the **MLB Phase 1
market validation** that decides which of its eleven MLB markets are good enough
to show to paying subscribers.

The product recommends picks. It never places a bet. Users log their own bets and
the platform settles them against results afterwards.

- **Results:** [`MLB_PHASE1_RESULTS.md`](MLB_PHASE1_RESULTS.md) — read §1 first.
- **Workbook:** `MLB_Phase1_Results.xlsx` — every table, built only from the
  report CSVs.
- **The validation harness:**
  [`betgenius/harness/uplift/`](betgenius/harness/uplift/README.md).
- **The app:** `betgenius/` — React + Vite frontend, Supabase Postgres and Deno
  edge functions.

---

## Headline

Eleven MLB markets, walk-forward and point-in-time over **2024-04-01 →
2026-08-17** (868 days, three seasons), on **412,886 graded candidates** across
**413,253 priced candidates** and up to 3,941 games per market.

| | |
|---|---:|
| Markets evaluated | 11 |
| Gate (full OOS) PASS | **10** |
| Gate (verdict window) PASS | **3** |
| Final PASS | **3** — `batter_hits`, `batter_total_bases`, `batter_strikeouts` |
| Final PASS_WITH_RESTRICTIONS | **7** — `batter_rbis`, `totals`, `spreads`, `pitcher_strikeouts`, `h2h`, `batter_runs_scored`, `pitcher_outs` |
| Final VETO | **1** — `batter_home_runs` |
| Final FAIL_AFTER_ITERATION | 0 |

### The two gates — the one thing to understand

The **same** rule (`n >= 500 and ROI > 0`, else the 95% CI lower bound must clear
zero) is applied to **two windows**:

- **Full OOS** — every scored pick over the whole out-of-sample period. The
  filter and each market's side policy were chosen on the *earlier half* of it.
- **Verdict window** — the *later half* of that same period, cut on the clock.
  **Nothing was chosen, tuned or inspected on it.**

A market can clear the first and fail the second because the verdict window is
half the size (below 500 picks the gate switches to the confidence-interval
branch, which a thin edge cannot clear), because a choice made on the earlier
half fitted noise, or because the edge genuinely decayed.

**The verdict window is the one that decides production status.** "Ten markets
pass" is a statement about the full-OOS gate only; the production count is
**three**.

---

## How the system works

```
The Odds API + MLB box scores
        ↓  dump_odds.ts / dump_box.ts / ingest_odds_api.ts
Priced universe: every event × player × line quoted two-sided at the entry
snapshot (~5.6h before first pitch), graded from the box score
        ↓  frames.py
Point-in-time features: empirical clear-rate at this line, an opportunity model,
lineup slot and rest, team offence, park environment, bullpen, starter workload,
and the game's own market numbers                       ↓  features.py
Per-market statistical model: Poisson / negative binomial on rate × opportunity
for the props, pitch budget → outs → batters faced for the pitcher markets, and
an exact Skellam run-difference distribution for the game markets
        ↓  policy.py
Walk-forward calibration, re-fit forward through time in 40 blocks; an ensemble
of the market price, gradient boosting and an isotonic-recalibrated model
        ↓
P(over) → both sides priced at the posted number → EV → the board
        ↓  mlbgate.py
The shipped gate, applied to the full OOS period and to the verdict window
        ↓
Final market status
```

Nothing in this repository re-fits the production scorer
(`supabase/functions/_shared/scoring_mlb_v2.ts`) or `algorithm_weights`, and the
gate is unchanged — `verify_gate.py` proves the port reproduces the shipped
harness reports bit for bit.

### Models actually used

| Component | Library | Role |
|---|---|---|
| `price` | scikit-learn `LogisticRegression` | the market's own de-vigged price, recalibrated against itself |
| `compact` | scikit-learn `LogisticRegression` | a short, hand-picked feature vector for thin markets |
| `box` | scikit-learn `LogisticRegression` | the full point-in-time feature vector |
| `gbm` | scikit-learn `HistGradientBoostingClassifier` | depth 3, 8 leaves, L2 = 5.0, lr 0.05, 200 iterations, min 200 samples/leaf |
| `offset` | statsmodels `GLM(Binomial)` | the price pinned as an offset, features fit only the residual |
| `iso` | `LogisticRegression` + `IsotonicRegression` | the model, then recalibrated on a held-out slice of its own training fold |
| statistical | scipy | Poisson, negative binomial, binomial, normal and Skellam distributions evaluated at the posted line; Elo; Pythagorean |

The shipped board averages three of these (`price + gbm + iso`), chosen once
across all eleven markets on the SELECT halves — never per market.

---

## Repository layout

```
MLB_PHASE1_RESULTS.md      the results, and the two-gate explanation
MLB_Phase1_Results.xlsx    the client workbook, generated from reports/
.env.example               every environment variable the code reads
betgenius/
  src/                     React + Vite frontend
  supabase/functions/      Deno edge functions, incl. the production scorer
  harness/                 the Deno backtest harness (milestones 2-6)
  harness/uplift/          the Phase 1 validation pipeline (this work)
  harness/uplift/reports/  every generated report, committed
  docs/                    architecture and build specs
```

## Running it

Requires **Python 3.14** (pandas 3, numpy 2.4, scikit-learn 1.9, statsmodels,
scipy, openpyxl), **Deno** for the dumps, and **Node 20+** for the app.

```bash
# the validation pipeline, from the cached dumps
cd betgenius
python harness/uplift/verify_gate.py
python harness/uplift/build_cache.py
python harness/uplift/run_final.py
python harness/uplift/final_matrix.py
python harness/uplift/build_workbook.py

# the app
npm install
npm run build          # lint + typecheck + vite build
npm test               # vitest
deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts
```

Credentials go in `betgenius/harness/.env` and `betgenius/.env.local`, both
git-ignored. See [`.env.example`](.env.example) for every variable, what it is
for, and whether it is a secret.

## Limitations

- A backtest is not a promise. It measures what a rule would have earned on a
  sample that has already happened.
- Seven of the ten full-OOS passes are **not** confirmed on untouched data.
- Board ROI assumes the best number at that line was available and taken; the
  no-line-shopping floor is eight markets instead of ten.
- No Statcast contact quality, no weather, no umpire assignment and no lineup
  cards — the four inputs the failing markets would most likely need.
