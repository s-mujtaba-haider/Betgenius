# Round 2 — what was tried to lift the eleven markets, and what survived

This is the record of a second optimisation pass over the eleven MLB markets. It
is written to be read next to `MARKET_DIAGNOSTICS.md`, which diagnosed the
baseline run and is unchanged: nothing in that diagnosis turned out to be wrong,
but one thing it did not look at turned out to matter more than anything in it.

Everything here is reproducible. The commands are at the bottom.

---

## The headline

| | baseline (`reports/final.csv`) | round 2 (`reports/final_c60.csv`) |
|---|---|---|
| Gate, full OOS | 10 / 11 | 9 / 11 |
| Gate, verdict window | 3 / 11 | **4 / 11** |
| PASS | 3 | **4** |
| PASS_WITH_RESTRICTIONS | 7 | 5 |
| VETO | 1 | 1 |
| FAIL_AFTER_ITERATION | 0 | 1 |
| **board rows production would reject** | **8,511 of 23,457 — 36.3%** | **0 of 16,982 — 0.0%** |

One change was adopted. It is not a new model, a new feature or a new threshold:
it is the removal of a knob.

---

## 1. The finding that mattered: a third of the baseline board is unservable

`harness/lib/metrics.ts:149` — `isEvPassPick` — is the shipped rule for whether
production shows a pick at all:

```ts
if (pick.confidence < 60) return false;
if (isUnbettableJuice(...)) return false;
if (pick.pickSide === "over" && !passesOverBreakeven(...)) return false;
```

`run_final.py` swept the confidence floor over `(0, 55, 60)` and chose **55**.
`run_final_v2.py` swept it over `(0, 45, 50, 55, 60)` and reached for **0**.
Every pick below 60 on those boards is one the product cannot display.

`parity_audit.py` measures it, by handing every row of each final board to the
ported shipped predicates and counting the rejections:

| Market | baseline board | rejected by `isEvPassPick` | |
|---|---:|---:|---|
| batter_hits | 2,415 | 1,466 | 61% |
| batter_total_bases | 7,039 | 3,270 | 46% |
| h2h | 966 | 447 | 46% |
| **totals** | **544** | **491** | **90%** |
| batter_runs_scored | 5,049 | 1,251 | 25% |
| pitcher_outs | 960 | 423 | 44% |
| … | | | |
| **all eleven** | **23,457** | **8,511** | **36.3%** |

The published `totals` full-OOS PASS rests on a board that is ninety per cent
picks the product would never show. That is not a modelling error and it is not
a leak — the gate, the windows and the as-of joins are all sound — but it means
the baseline table answers a slightly different question from the one the client
is asking.

There is a second, sharper reason the floor cannot be swept. The D-164
heavy-juice veto has no branch that fires below confidence 60:

```python
(c >= 90) & (o <= -350) | (c >= 80) & (o <= -300)
| (c >= 70) & (o <= -250) | (c >= 60) & (o <= -200)
```

So lowering the floor does not merely add picks — it adds precisely the picks
the veto is structurally unable to reach. On `batter_home_runs` that turns a
23-row board into a 2,306-row one (see the `warm-up 15%` variant of the baseline
run, which drifted to floor 0 and reported `batter_home_runs` at n=1,295). A
market the product excludes by rule reappears as a passing market. That is the
clearest possible demonstration that the floor is not a free parameter.

## 2. What was adopted, and the test it had to pass first

**Pin the confidence floor to the shipped 60 and remove it from the global
search.** Nothing else changed: same gate, same verdict windows, same features,
same walk-forward, same ensemble pool, same EV-floor and collapse sweep, same
side lever, same `ev_pass` parity on the three game markets.

The acceptance criterion was **written down before the number existed**
(`reports/experiment_log_v2.csv`, row `E18-RULE`): adopt if the pinned rule is at
least as good as the swept one on held-out market-splits in profit.

The test is `exp_nested_rules.py`. The SELECT half is cut again on the clock; the
whole rule — the global search, the side lever, everything — is re-derived on
SELECT-A and scored on SELECT-B, at three inner cuts. The verdict window is never
read; the latest timestamp the file touches is the SELECT/VERDICT cut, and only
as an upper bound.

| rule, chosen on SELECT-A | held-out splits in profit | held-out n | held-out units | median ROI |
|---|---:|---:|---:|---:|
| baseline (floor swept 0/55/60) | 18 / 33 | 42,834 | 856.5 | 1.25% |
| baseline + EV filter on game markets | 17 / 33 | 46,529 | 849.9 | 0.30% |
| **baseline @ conf 60, pinned** | **20 / 33** | 15,052 | 508.8 | **2.80%** |
| v2 architecture | 24 / 33 | 22,021 | 771.3 | 4.07% |

Pinning wins on the pre-registered measure, more than doubles the median
held-out ROI, and is visibly more stable: it selects the same ensemble spec at
all three inner cuts, where every swept rule selects a different one at each.
A search that lands somewhere different each time it is run is fitting noise,
and taking a knob away is what stopped it.

The volume it gives up — 42,834 held-out picks down to 15,052 — is the 36% that
was never servable plus the picks that went with it.

## 3. What was rejected, and why

### The v2 architecture — rejected, though it scores highest

`run_final_v2.py` was written in a previous pass and never run. Its own
pre-registered criterion (`E15-RULE`) required v2 to match the baseline on
held-out markets-in-profit **and** to deliver at least 1.25× the held-out units,
"because the whole point of v2 is to deliver the same edge on more volume, which
is what an n >= 500 gate needs."

Run fairly, v2 delivers 771.3 units against a bar of 1,070.6. It buys its
excellent rate (4.07% median) by **halving** the volume — 22,021 picks against
the baseline's 42,834. That is exactly the failure mode the units bar was written
to catch, so the bar is doing its job rather than misfiring, and v2 is not
adopted. Its boards are also built at confidence floors of 0 and 45, so they
would fail the parity audit above.

Two things about v2 are worth keeping on the record anyway:

* **Its own nested test was rigged in the baseline's favour and it still
  "lost".** `run_final_v2.nested_check` scores the incumbent at a *fixed* filter
  — `price+gbm+iso`, EV floor 0.02, floor 55 — that `run_final.py` had chosen on
  the **whole** SELECT half, SELECT-B included. So the baseline was being scored
  on data that had picked it, while v2 re-derived everything from SELECT-A. On
  that test the baseline reads 27/33; re-derived honestly it reads 18/33. Any
  conclusion drawn from the file's own numbers is unsafe, which is why
  `exp_nested_rules.py` exists.
* **On the three game markets v2 is genuinely and consistently better** — 9/9
  held-out splits in profit and +112.4 units, against 3/9 and −62.1 for the
  baseline. That is worth revisiting, but not on a board the product cannot
  serve.

### Applying the EV filter to the three game markets — rejected on a false premise

The appeal of this change was that it could not touch the eight prop markets.
`exp_nested_rules.py` asserts that rather than assuming it, and **the assertion
fails**: at inner cut 0.7 the parity change moved the *globally chosen filter*
(EV floor 0.02 → 0.0, `maxEv` → `mostBooks`), and all eight prop boards moved with
it — `batter_hits` from 4,104 picks to 5,840, `pitcher_outs` from 269 to 100.
Because the filter is chosen jointly across markets, a "game-markets-only" change
is not market-isolated. It also scored worse on its own terms: 17/33 against 18.

### A richer price-only ensemble member — rejected (E16)

The calibration table says the price family dominates the thin markets, so three
new walk-forward members were built from cache columns only: `pricevig`
(priceflex plus the overround and the book count), `priceline` (plus the posted
number and its distance from the market's median number) and `priceiso` (an
isotonic price map instead of a parametric one).

None beats the incumbents by more than **0.0005 of skill** on any market —
fourth-decimal differences, the same noise band `E8` measured — and `priceiso` is
uniformly worse, at calibration slopes of 0.07–0.24. The price-only family is
saturated. Widening a search without adding information is pure overfit risk, so
the pool was left alone. Numbers in `reports/exp_price_members.csv`.

### More model families — not pursued, and here is the evidence why

The member pool already contains a gradient-boosted tree (`gbm`, a
`HistGradientBoostingClassifier`). `reports/calibration.csv` shows what the tree
and the other feature-carrying members do on the markets that need help:

| market | best member | `gbm` slope | `iso` slope | `price` skill | `box`/`gbm` skill |
|---|---|---:|---:|---:|---:|
| h2h | price | 0.51 | 0.28 | 0.0179 | 0.0013–0.0054 |
| pitcher_outs | price | 0.57 | 0.32 | 0.0175 | −0.0003–0.0053 |
| spreads | price | 0.68 | 0.40 | 0.0473 | 0.0229–0.0310 |
| totals | — | 0.03 | 0.03 | −0.0009 | −0.0295–−0.0212 |

Every feature-carrying member on these markets is badly over-dispersed and has
less skill than the price alone. Adding XGBoost, CatBoost, a random forest or
extra trees is adding more members of the family that is already measurably
losing here. The constraint is not the learner; it is that on a 3,360-row market
with one weak signal there is nothing for a flexible learner to find. This is
also what `E12` concluded for `totals` directly: every member has negative skill
and the de-vigged market probability has a standard deviation of 0.017, because
the book moves the line until the total is a coin flip.

## 4. Market by market: baseline → round 2

| Market | old status | new status | old full ROI | new full ROI | old verdict ROI | new verdict ROI | old verdict n | new verdict n | old robust | new robust | decision |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| batter_hits | PASS | PASS | 8.95 | 12.65 | 10.57 | 15.00 | 1521 | 830 | 6 | 6 | held |
| batter_rbis | PASS_WITH_RESTRICTIONS | **PASS** | 2.03 | 6.89 | −0.76 | **3.13** | 709 | 594 | 6 | 6 | **improved** |
| totals | PASS_WITH_RESTRICTIONS | PASS_WITH_RESTRICTIONS | 3.94 | 4.68 | 2.99 | 5.46 | 240 | 236 | 2 | 3 | held |
| spreads | PASS_WITH_RESTRICTIONS | PASS_WITH_RESTRICTIONS | 1.06 | 1.49 | −0.18 | −0.42 | 1106 | 854 | 4 | 6 | held |
| batter_total_bases | PASS | PASS | 3.38 | 3.90 | 4.27 | 6.98 | 3795 | 1407 | 6 | 6 | held |
| batter_home_runs | VETO | VETO | −25.49 | −16.17 | −44.16 | −32.10 | 14 | 14 | 1 | 0 | held |
| pitcher_strikeouts | PASS_WITH_RESTRICTIONS | PASS_WITH_RESTRICTIONS | 4.35 | 0.02 | 0.21 | −0.92 | 334 | 500 | 6 | 5 | held |
| h2h | PASS_WITH_RESTRICTIONS | **FAIL_AFTER_ITERATION** | 0.35 | −0.04 | −0.70 | −1.22 | 387 | 546 | 3 | 2 | **REGRESSED** |
| batter_runs_scored | PASS_WITH_RESTRICTIONS | PASS_WITH_RESTRICTIONS | 1.26 | 1.56 | −1.74 | −0.34 | 1623 | 1732 | 6 | 5 | held |
| pitcher_outs | PASS_WITH_RESTRICTIONS | PASS_WITH_RESTRICTIONS | 4.21 | 2.12 | 0.69 | 0.58 | 306 | 264 | 4 | 4 | held |
| batter_strikeouts | PASS | PASS | 6.78 | 7.40 | 5.84 | 3.05 | 720 | 632 | 6 | 6 | held |

**1 improved, 9 held, 1 regressed.** Verdict-window ROI improves on seven of the
eleven. The two moves:

* **`batter_rbis` → PASS.** Its verdict board holds at 594, above the n ≥ 500
  floor, and its ROI crosses from −0.76% to +3.13%. It was failing by three
  quarters of a point; removing the sub-60 picks was enough. Its full-OOS ROI
  more than triples, 2.03% → 6.89%.
* **`h2h` → FAIL_AFTER_ITERATION.** Its full-OOS ROI moves from +0.35% to
  −0.04% — a hair either side of zero on a board of 1,241, with a CI spanning
  ±5 points. This market was never distinguishable from zero in either run; the
  status flip is a sign change inside the noise, not a deterioration. E18-RULE
  was written to say that a cost here is reported rather than reversed, and this
  is that cost.

The three markets that were already PASS all stay PASS, and all three improve
their full-OOS ROI.

## 5. Robustness — the same six variants, on the pinned rule

| variant | gate, full OOS | gate, verdict window | units, full OOS | units, verdict |
|---|---:|---:|---:|---:|
| locked (headline) | 9 / 11 | 4 / 11 | 653.3 | 249.7 |
| placebo lag 1d | 8 / 11 | 3 / 11 | 493.8 | 144.5 |
| placebo lag 3d | 9 / 11 | 6 / 11 | 670.5 | 279.0 |
| placebo lag 7d | 7 / 11 | 4 / 11 | 445.6 | 71.8 |
| median book, no line shopping | 8 / 11 | 3 / 11 | 424.0 | 80.2 |
| warm-up 15%, 12 refit blocks | 8 / 11 | 5 / 11 | 613.5 | 236.9 |

The placebo-lag profile is the leak test and it is clean: forcing the freshest
box score a pick may see to be 1, 3 and 7 days stale gives 8, 9 and 7 passing
markets against the headline's 9 — a gentle decay, which is what a real form
signal looks like. A same-game leak dies at the first day of lag, and nothing
here does.

Line shopping is worth roughly a point: betting the median book instead of the
best number at that line costs 229 units full OOS.

**One caveat on reading this table.** The `warm-up 15%, 12 refit blocks` variant
changes how many rows are scored, which moves each market's SELECT/VERDICT cut —
in the baseline run it moved `batter_hits` from 2025-05-19 to 2025-04-26. Its
verdict-window column is therefore computed over a *different window* from the
other rows and is not comparable to them. The baseline run's robustness table
showed that variant at 7/11 on the verdict window, and that number has been read
as "a better configuration exists". It is not one; it is a different evaluation.

## 6. What remains, and why

* **`batter_home_runs` — VETO, and it should stay VETO.** The baseline
  diagnosis holds, recomputed at the round-2 spec and floor: one line exists
  (0.5), the median over is +675 and the median under −1000, the model takes the
  under on 82.1% of the 41,686 scored rows, 34,207 of them clear confidence 60,
  and **D-164 deletes 34,176 of those 34,207**. Thirty-one survive the veto and
  twenty-eight reach the board. This is a shipped product rule
  removing a market, not a model failing one. The two honest options are both
  product decisions — report the market as having no servable board, or revisit
  D-164 for markets whose fair price sits beyond −200 by construction — and
  neither is taken here unilaterally. Forcing it to PASS would require betting
  longshots on a model with no measured skill.
* **`totals` — restricted, and it should not be chased.** No member has positive
  skill on the SELECT half; price AUC is 0.5018 and the best member reaches
  0.5206. Weather at the timestamp is the one input that would plausibly change
  this and the data does not contain it.
* **`pitcher_strikeouts`, `pitcher_outs` — positive and underpowered.** 500 and
  264 verdict picks. At n < 500 the gate asks the CI to clear zero, which needs
  roughly 10–11% flat ROI; no honest MLB board returns that. `pitcher_strikeouts`
  now sits exactly on the n = 500 boundary, so it is decided by its ROI sign,
  which is −0.92%. These need volume at the same edge, which means more priced
  history, not a better model.
* **`spreads`, `batter_runs_scored` — thin true edges.** Full sample, a fraction
  of a point below zero on the verdict window. These are the two markets where a
  genuine improvement in probability quality would still change a status.
* **`h2h` — indistinguishable from zero.** See above.

## 7. Limitations

* The confidence floor is now pinned rather than searched, but the **EV floor,
  the ensemble spec and the ladder collapse are still chosen on the pooled
  SELECT halves.** That is a real search over 41 specs × 4 floors × 2 collapses,
  and `exp_nested_rules.py` is the only evidence that the rule behind it
  generalises. It generalises better than the alternatives tested; it is not
  proved to generalise well in absolute terms.
* The selected spec is a **single member, `gbm`**, at an EV floor of 0.04. The
  nested test picked `gbm` at all three inner cuts, so the spec choice is stable,
  but the floor moved between 0.0 and 0.04 across cuts and is the least stable
  part of the rule.
* **`priceOnlyRoi` reads −100.00 on `totals` and 0.00 on two others.** Those are
  price-only boards with almost no picks left at floor 60, not real returns. The
  column is a diagnostic, not a result.
* The verdict window is the later half of each market's own out-of-sample
  period, so its start date differs per market and, for `batter_runs_scored` and
  `batter_strikeouts`, is as early as mid-2024. It is untouched by selection but
  it is not a single common period.
* Two markets' prices come entirely from the provider re-pull rather than the
  warehouse, so their snapshots are a different vintage from the rest.
* **This is a backtest.** It assumes the quoted best number at the entry snapshot
  was available and takeable in size. Book limits on a 17,000-pick board are a
  real constraint that nothing here measures.

## 8. Production recommendations

1. **Ship the confidence floor as it is.** The 60 in `isEvPassPick` is load
   bearing, and the validation should be run at it. `parity_audit.py` should be
   run on any future board before its numbers are quoted.
2. **The four PASS markets are the servable set**: `batter_hits`,
   `batter_rbis`, `batter_total_bases`, `batter_strikeouts`. All four clear both
   gates, all four survive 6/6 robustness variants, and every pick on their
   boards is one production would display.
3. **Write `evPerUnit` on the game write path.** It is the missing column behind
   the `ev_pass` parity on `totals`/`h2h`/`spreads`, and the one v2 result worth
   revisiting (9/9 held-out game-market splits in profit) needs it. Until it
   ships, the game markets cannot be EV-filtered in production and should not be
   evaluated as though they could.
4. **Take a product decision on `batter_home_runs`.** Either report it as having
   no servable board, or revisit D-164 for markets whose fair price sits beyond
   −200 by construction.
5. **Do not quote the full-OOS gate alone.** It reads 9/11 and the verdict-window
   gate reads 4/11; the second is the one computed on data that chose nothing.

## 9. Reproducing this

```bash
cd betgenius

# the two SELECT-only experiments; neither reads the verdict window
python harness/uplift/exp_price_members.py        # E16
python harness/uplift/exp_nested_rules.py         # E17 / E18, the adoption test

# the headline run, at the shipped confidence floor
python harness/uplift/run_final.py --conf=60 --tag=_c60
python harness/uplift/parity_audit.py --tag=_c60  # 0 rejected rows
python harness/uplift/robustness.py --conf=60     # the six variants
python harness/uplift/final_matrix.py --tag=_c60  # THE table

# the baseline, and the regression ledger against it
python harness/uplift/run_final.py                # reports/final.csv
python harness/uplift/parity_audit.py --tag=      # 8,511 rejected rows
python harness/uplift/compare_runs.py --a= --b=_c60
```

`reports/experiment_log_v2.csv` holds every experiment, including the failed
ones and the two adoption criteria that were written down before their numbers
existed.
