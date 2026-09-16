# MLB Phase 1 — market validation results

**Objective (from `Betgenius MLB.md`):** validate as many of the eleven MLB
markets as the evidence supports, minimum eight, *without* weakening the gate.

**Result: 9 of 11 markets clear the shipped gate** on a walk-forward,
point-in-time backtest of the full priced universe — against a published
starting point of 3 of 10, and 7 of 11 at the end of the first pass of this
work. The target is met with one market to spare.

The gate was not touched. Neither was the production scorer, `algorithm_weights`,
nor the D-164 heavy-juice veto. Everything here is read-only.

The three markets that moved this pass — `totals`, `pitcher_strikeouts` and
`pitcher_outs` — moved because of **new point-in-time features**, not because of
a looser filter, and §3 shows the measurement that separates those two
explanations. The two that still fail are documented in §4 with the specific
thing each would need.

---

## 1. The headline table

Walk-forward over 2024-04-01 → 2026-08-17. The gate is unchanged: `n ≥ 500` and
`ROI > 0`, else the 95% CI lower bound must clear zero. `base` is every priced
candidate flat-bet — that is the vig the board has to beat.

| # | Market | Priced candidates | Flat-bet ROI (the vig) | Board n | Board ROI | 95% CI low | Units | Gate |
|---|---|---:|---:|---:|---:|---:|---:|:--|
| 1 | `batter_hits` | 94,209 | −9.68% | 2,911 | **+9.66%** | **+6.24** | +281 | **PASS** |
| 2 | `batter_rbis` | 71,864 | −12.86% | 1,136 | **+4.39%** | −0.38 | +50 | **PASS** |
| 3 | `totals` | 6,530 | −5.71% | 708 | **+3.07%** | −4.03 | +22 | **PASS** |
| 4 | `spreads` | 5,714 | −2.64% | 1,822 | **+1.03%** | −2.62 | +19 | **PASS** |
| 5 | `batter_total_bases` | 88,372 | −11.06% | 4,973 | **+6.20%** | **+3.79** | +308 | **PASS** |
| 6 | `batter_home_runs` | 57,013 | −16.07% | 24 | −9.48% | −48.26 | −2 | FAIL |
| 7 | `pitcher_strikeouts` | 19,447 | −4.94% | 1,654 | **+2.40%** | −1.93 | +40 | **PASS** |
| 8 | `h2h` | 4,504 | −0.16% | 1,114 | −0.92% | −5.97 | −10 | FAIL |
| 9 | `batter_runs_scored` | 31,012 | −11.52% | 3,185 | **+2.70%** | −0.36 | +86 | **PASS** |
| 10 | `pitcher_outs` | 6,753 | −3.44% | 1,223 | **+3.46%** | −1.72 | +42 | **PASS** |
| 11 | `batter_strikeouts` | 27,835 | −12.13% | 1,410 | **+7.45%** | **+3.24** | +105 | **PASS** |

**9 / 11 PASS. +940 units across the eleven boards.**

`runs_scored` in the roadmap is read as `batter_runs_scored` — that is the market
the codebase, `market_config.ts` and `mlb_ev_policy.ts` actually carry.

---

## 2. What is solid and what is thin

Read this before quoting the table.

### The three that are unarguable

`batter_hits`, `batter_total_bases` and `batter_strikeouts` clear the gate with a
**95% CI lower bound above zero**, which is a stronger claim than the gate asks
for, on 1,410 to 4,973 picks. All three also stay positive on the untouched half
of the sample (below), and `batter_hits` gets *stronger* there (+11.61%).

### Six clear the gate on the point estimate

`batter_rbis`, `totals`, `spreads`, `pitcher_strikeouts`, `batter_runs_scored`
and `pitcher_outs` clear `n ≥ 500 and ROI > 0` but their confidence intervals
cross zero. That is the gate the product ships, and they clear it; it is not the
same as saying the edge is proven to two decimal places. Treat them as
validated-but-watch.

§5 sorts them a second way, by whether the verdict survives changing the setup.
Six of the nine clear the gate under **every** variant — placebo lag 1, 3 and 7
days, median-book pricing, and a different refit schedule: `batter_hits`,
`batter_rbis`, `batter_total_bases`, `batter_runs_scored`, `pitcher_outs` and
`batter_strikeouts`. `totals` clears four of six and is the thinnest of the nine.

### The hardest test: the half nothing was chosen on

Everything above is already walk-forward, so no pick is scored by a model that
saw it. But the filter and each market's side policy were chosen on the
**earlier half** of the out-of-sample period. Re-reading the verdict on the
**later half only** — a window nothing was chosen on — gives:

| | markets clearing the gate |
|---|---|
| full out-of-sample period | **9 / 11** |
| later half only, nothing chosen on it | **4 / 11** — `batter_hits` +11.61%, `batter_total_bases` +6.63%, `batter_runs_scored` +1.25%, `pitcher_strikeouts` +0.69% |

The number to read next to that 4 is this: of the nine markets that pass on the
full period, **six are still profitable on the untouched half** — the four above
plus `pitcher_outs` (+1.03%) and `batter_strikeouts` (+3.83%), and those two miss
the gate on **sample size, not on sign**: 445 and 474 graded picks against the
gate's floor of 500, which pushes them onto the CI branch. The other three
(`batter_rbis` −0.67%, `totals` −0.98%, `spreads` −0.14%) are within noise of
break-even on 318–351 picks, not losing boards.

So: nine markets clear the shipped gate over the full out-of-sample period, and
the half of that period nobody could have fitted to says six of the nine are
still making money, four of them by enough to clear the gate a second time on
half the data.

### Does anything know something the price does not?

`diag_signal.py` regresses the outcome on the market's own de-vigged price **and**
on each candidate signal, so the reported coefficient is what the signal adds
*after* the market has had its say. Past |z| > 3:

| Market | strongest signal | z |
|---|---|---:|
| `batter_rbis` | opportunity model at the posted line | **9.99** |
| `batter_hits` | clear-rate at this line, last 100 appearances | **8.93** |
| `batter_total_bases` | park-adjusted count model | **7.56** |
| `batter_strikeouts` | opportunity model (expected PA × K rate per PA) | **5.87** |
| `batter_home_runs` | Poisson HR model at the posted line | **6.19** |
| `pitcher_strikeouts` | opposing lineup's strikeout rate | **5.85** |
| `pitcher_strikeouts` | opposing bullpen's runs per out | **3.85** |

Note what this does **not** line up with. `batter_home_runs` has strong signal
and still fails; `spreads`, `h2h`, `totals` and `pitcher_outs` show nothing
individually and two of them pass. Knowing something the market does not is
necessary but not sufficient — it has to be worth more than the juice — and a
market can be beatable through nothing but a recalibration of its own price, or
through a combination of weak features none of which beats the price alone.
`pitcher_outs` is the clearest case of the latter: no single workload feature
survives the price in that regression, and the board built on all of them
together goes from −1.03% to +3.46% — the same filter, the same side, only the
features changed (§3.4).

---

## 3. What was actually done

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
snapshot is a candidate: **413,000 graded candidates** across eleven markets,
against a few thousand before. The model chooses the side *and* the line.

### 3.3 The entry price is the shipped convention

The best number quoted at that line at the entry snapshot — roughly 5.6 hours
before first pitch — which is what `best_price.ts` `selectBestSameLineBook` and
`game_candidates.ts` both do in production. A median-book sensitivity (no line
shopping at all) is in §5.

### 3.4 The features that were missing — and what they were worth

This is the pass that moved the result from seven markets to nine. Four things
were added to the point-in-time feature set, all of them on the roadmap's own
per-market feature lists, all of them built from data already on disk:

| Feature family | What it is | Why it was missing |
|---|---|---|
| **park environment** | runs and home runs already hit in **this ballpark**, last 100 games there, shrunk hard to the league rate | recorded as "needs park data"; a park factor needs no new source — it is just what has already been scored there |
| **bullpen** | the relief corps' as-of runs per out, K and BB per batter faced, innings per game | recorded as blocked on `cache_mlb_historical_bullpen`, which `harness_readonly` cannot read. Every relief appearance is also a **box-score row**, and the box score we can read |
| **starter workload** | pitch budget, pitches per out, walk rate, five-start form against the 25-start baseline, and the start-to-start spread of his own outs | `pitches_thrown` sat in the box-score dump, populated on every pitcher row, and nothing read it |
| **the models on top** | pitch budget ÷ pitches per out → expected outs → batters faced ÷ (1 − opponent OBP) → strikeouts, negative binomial at the line; and for the game markets, starter-for-as-long-as-he-lasts + bullpen-for-the-rest, in that park | the old models were a flat 4.5-out standard deviation for every pitcher alike, and a team-form run model that could not see either pitching staff |

**The measurement that separates a feature gain from a filter gain.**
`run_final.py` re-chooses its global filter every run, so a before/after on the
headline would confound the two. `attribute.py` scores **both feature sets
through an identical filter and identical side policy**, so the only difference
between the two columns is the features:

| Market | ROI, features before | ROI, features after | Δ |
|---|---:|---:|---:|
| `pitcher_outs` | −1.03% (FAIL) | **+3.46% (PASS)** | **+4.49** |
| `totals` | −0.82% (FAIL) | **+3.07% (PASS)** | **+3.89** |
| `pitcher_strikeouts` | −0.52% (FAIL) | **+2.40% (PASS)** | **+2.92** |
| `batter_total_bases` | +3.77% | +6.20% | +2.43 |
| `batter_runs_scored` | +0.94% | +2.70% | +1.76 |
| `batter_hits` | +8.18% | +9.66% | +1.48 |
| `spreads` | +1.01% | +1.03% | +0.02 |
| `batter_strikeouts` | +7.63% | +7.45% | −0.18 |
| `h2h` | −0.30% | −0.92% | −0.61 |
| `batter_rbis` | +5.87% | +4.39% | −1.48 |
| **markets clearing the gate** | **6 / 11** | **9 / 11** | |

The three markets that flip are exactly the three the new features were built
for. That is the claim this whole pass rests on, and it is reproducible in one
command: `python harness/uplift/attribute.py`.

### 3.5 A market-appropriate model per market

Per the roadmap, not one architecture for all eleven:

| Family | Model |
|---|---|
| hits, total bases, home runs, RBIs, runs, both strikeout markets | Poisson on rate-per-opportunity × expected opportunity, shrunk to a league prior, adjusted for the opposing side's as-of allowance and for the park, plus a negative-binomial version of the same count |
| `pitcher_outs` | pitch budget ÷ pitches per out → expected outs, with the pitcher's **own** start-to-start spread as the standard deviation |
| `pitcher_strikeouts` | expected outs → batters faced → strikeouts, negative binomial at the posted line |
| `totals`, `h2h`, `spreads` | the starting pitcher for as long as he lasts plus the bullpen for the rest, in a park with its own run environment, alongside the older form-only run model |

Each is combined with the empirical handicap — *how often has this player already
cleared THIS number, over his last 25 and last 100 appearances* — with the
opposing starter's as-of rates, the batter's as-of lineup slot and rest, and with
the market's own numbers for that game (the total, the moneyline, and the implied
team totals derived from them). A calibrator is re-fit forward through time and
returns P(over); both sides are then priced against it at the posted number, and
the board bets the side whose expected value clears the floor — which means it
must beat the juice, not merely the fair price.

### 3.6 Nothing was chosen on the data that produces the verdict

One global filter — model spec, EV floor, confidence floor, ladder collapse —
chosen **once** across all eleven markets on the earlier half of the
out-of-sample period. Then one lever per market: the side policy, which is the
lever `MLB_EV_SIDE_POLICY` already pulls today. Nothing else is tuned per market.

This run's choice: `spec=box+gbm+iso`, EV floor 0.04 units, confidence floor 55,
ladder collapsed to the maximum-EV line. Ten of the eleven markets clear the gate
on the SELECT halves under it; nine do over the full period.

The roadmap also asks for a per-market improvement record, and `run_improve.py`
keeps one: spec × EV floor × side × confidence floor × sample floor searched per
market on the SELECT half, thousands of attempts, every one of them written to
`reports/improve_log_lag0_best.csv` — including the ones that failed, because a
table of only the things that worked is indistinguishable from a table of things
that got lucky. Each market's winner is then read once on the VERDICT half it was
never searched on, and `reports/improve_lag0_best.csv` reports that read next to
the search that produced it.

### 3.7 The as-of cut, recomputed the slow way

Every number here depends on one property: a feature attached to a game may only
read box scores that finished on an **earlier local calendar date**. That is
enforced by a cumulative sum and a binary search — fast, and exactly the kind of
code that is wrong by one row without anyone noticing.

`check_asof.py` recomputes 200 sampled rows from each of the three new feature
tables with a naive filter that cannot be subtly wrong — *take every earlier row,
average it* — and asserts the two agree. It also asserts the stronger thing: that
the value **would change** if the game's own day were let in, which is what makes
the first assertion mean something. 600 rows, **0 mismatches**, and 562 of them
live tests of the cut rather than rows where it happens not to matter.

The placebo-lag runs in §5 are the same question asked from the other end: force
the freshest box score a pick may see to be a day, three days, a week older. Form
decays slowly; a same-game leak dies at the first day of lag.

### 3.8 One bug worth recording

The as-of roll-ups were initially returning almost nothing, because pandas 3
parses a date string to `datetime64[us]` and the day counter divided the int64
view by nanoseconds-per-day. Every date in the sample collapsed into two buckets
and most rows saw no history at all. The direction of that error is worth noting:
it **suppressed** the signal rather than inventing one. It is fixed in
`frames.to_day`, which now casts to `datetime64[D]` and asks for days.

---

## 4. Why each failure fails

Per the roadmap, a market is only marked failed after the levers have been tried,
and the reason has to be specific.

### `batter_home_runs` — VETO, and the veto is right

This market has real signal (z = 6.19) and no bettable board. The model likes
9,835 of its candidates; 53% of those are unders, and the shipped D-164
heavy-juice rule removes **99.5% of them**, at a median price of −600. What
survives the veto *and* the EV floor is **24 bets in two and a half seasons** —
not a losing board, no board at all. Dropping the veto does not rescue it either:
the whole positive-EV under board is −0.80% over 5,203 picks, flat unders on
every candidate are −1.82%, and every over board loses double digits.

*To revisit:* nothing in this data fixes it. It would need the veto relaxed
**and** an edge that is not there. Statcast contact quality — barrel rate, exit
velocity, launch angle — is the input the roadmap names and the one input this
harness has no access to.

### `h2h` — FAIL_AFTER_ITERATION, and it is the honest casualty of this pass

In the first pass `h2h` cleared the gate at +1.55%. It does not here: −0.92% on
1,114 picks. Nothing was done to it — no feature in this pass is a moneyline
feature — but the filter is chosen once across all eleven markets, and the filter
that is best for the other ten lands on the home side of `h2h` and loses with it.
That is the cost of a single global choice, paid in the one market where the
choice happens to be wrong, and it is reported rather than exempted.

What the market itself says: `h2h` has **no signal over the price** in any
feature the harness carries (best z = 1.89, on the run-differential model). Its
first-pass edge was a recalibration of the market's own number, and an edge of
that kind is thin by construction and does not survive a change of filter. On the
untouched later half it is −7.10%, the worst of the eleven.

*To revisit:* a moneyline market is efficient enough that beating it needs an
input the book does not already have — lineup cards at the moment they are
posted, or bullpen availability by arm. The second of those is the same grant
that `pitcher_outs` needed; unlike `pitcher_outs`, the box-score rebuild does not
substitute for it here, because what matters for a moneyline is who is
*available* tonight, not what the pen has already done.

---

## 5. Robustness — change one thing and look again

A number that only holds at one setting is not a number. The whole pipeline was
re-run under each variation below, filter re-chosen from scratch each time:

| Variant | Markets clearing the gate | Units |
|---|---:|---:|
| **locked (the headline)** | **9 / 11** | +940 |
| placebo lag 1 day | 9 / 11 | +694 |
| placebo lag 3 days | 9 / 11 | +783 |
| placebo lag 7 days | 8 / 11 | +2,361 |
| median book, no line shopping | 8 / 11 | +607 |
| warm-up 15%, 12 refit blocks | 8 / 11 | +864 |

**The placebo lag is the leakage test.** It forces the freshest box score a pick
may see to be a day, three days, a week older. A genuine form signal decays
slowly; a same-game leak dies the moment a single day of lag is imposed. The
pass count goes 9, 9, 9, 8 — flat. (The units column is not comparable across
rows: at lag 7 the sweep lands on a much looser filter, so the boards are ten
times larger at a tenth of the ROI. The pass count is the thing to read.)

**The median-book row is the no-line-shopping floor.** The headline bets the best
number at that line, which is the shipped convention (`best_price.ts`). Betting
the median book instead — no shopping at all — still clears eight markets; only
`totals` drops out.

**Six markets clear the gate in every single variant:** `batter_hits`,
`batter_rbis`, `batter_total_bases`, `batter_runs_scored`, `pitcher_outs` and
`batter_strikeouts`. `pitcher_strikeouts` and `spreads` clear five of six.
`totals` clears four of six and is the thinnest of the nine. `h2h` clears one of
six, which is the same story §4 tells about it.

Full table in `reports/robustness.csv`; each variant's own eleven-market run is
in `reports/final_*.csv` next to it.

---

## 6. Market status

| Market | Published baseline | Final | Basis |
|---|---|---|---|
| `batter_hits` | PASS (in-sample window) | **PASS** | +9.66%, CI low +6.24, n = 2,911; +11.61% on the untouched half |
| `batter_total_bases` | FAIL | **PASS** | +6.20%, CI low +3.79, n = 4,973; +6.63% on the untouched half |
| `batter_strikeouts` | *unjudgeable — no odds* | **PASS** | +7.45%, CI low +3.24, n = 1,410; +3.83% on the untouched half at n = 474 |
| `pitcher_outs` | FAIL | **PASS** | +3.46% on 1,223; pitch-budget model; +1.03% on the untouched half at n = 445 |
| `totals` | PASS (pick_history slice) | **PASS** | +3.07% on 708; park + bullpen staff model |
| `batter_runs_scored` | *unjudgeable — no odds* | **PASS** | +2.70% on 3,185; +1.25% on the untouched half |
| `pitcher_strikeouts` | FAIL | **PASS** | +2.40% on 1,654; workload decomposition; +0.69% on the untouched half |
| `batter_rbis` | FAIL | **PASS** | +4.39% on 1,136; CI crosses zero |
| `spreads` | FAIL | **PASS_WITH_RESTRICTIONS** | +1.03%; runline-underdog bias, CI crosses zero, no signal over the price |
| `h2h` | PASS (pick_history slice) | **FAIL_AFTER_ITERATION** | −0.92%; no signal over the price; loses under the global filter |
| `batter_home_runs` | FAIL | **VETO** | no bettable board survives the D-164 juice rule |

---

## 7. Reproducing this

Everything is in `betgenius/harness/uplift/`. See its `README.md` for the full
pipeline and the rules it works under.

```bash
cd betgenius
export DENO_CERT="$PWD/prod-ca-2021.crt"

python harness/uplift/verify_gate.py     # the gate port reproduces the shipped reports
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/dump_box.ts
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/dump_odds.ts
python harness/uplift/build_cache.py
python harness/uplift/run_final.py
python harness/uplift/attribute.py
python harness/uplift/robustness.py
python harness/uplift/build_workbook.py
```

`MLB_Phase1_Results.xlsx` at the repo root is built only from
`harness/uplift/reports/*.csv`, so the workbook cannot drift from the run that
produced it.

## 8. What this does NOT claim

- It is **not** a live result. Nothing here has been deployed, and the live
  production pick stream is a harder population than the warehouse era.
- It does **not** re-fit the scorer. The shipped scorer's disagreement with the
  price carries no information in any market; the filter sits *after* scoring.
- Board ROI assumes the best number at that line was available and taken, which
  is the shipped convention. The median-book sensitivity is in §5.
- Six of the nine passes clear the gate on the point estimate with a confidence
  interval that crosses zero. Three do not, and those three are the result.
- The later half of the out-of-sample period, which nothing was chosen on, holds
  four of the nine, with two more positive but below the 500-pick floor.
