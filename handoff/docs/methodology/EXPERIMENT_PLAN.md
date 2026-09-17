# the extended work — data expansion and final optimisation: the plan

Written **before** any expanded-data result existed. Acceptance criteria below
are fixed at the moment of writing and are not re-read, re-weighted or re-scoped
after the fact. Failed experiments are reported as failures.

> Naming note. `VALIDATION_REPORT.md` and `VALIDATION_REPORT.md` already
> exist and are untouched. This file and `VALIDATION_REPORT.md` are the
> deliverables named in the current brief; internally the experiments continue
> the existing ledger numbering (E22 onward) so no experiment id is reused.

---

## 0. What is already settled, and is not re-litigated

Three experiments were run under a prior pre-registration and **all three
failed**. They are not re-run, re-scored, or reinterpreted into an adoption.

| id | hypothesis | verdict | why |
|---|---|---|---|
| E22 | the price anchor, isolated from the EV floor it was confounded with | **REJECT** | at matched (spec, EV floor, collapse), held-out SELECT-B units 33,400 vs 36,685; only 4 of 11 markets improve (needed 6); strong markets 917/984 vs 945/984. The earlier confound is now removed and the answer is unchanged, so the anchor is closed. |
| E23 | calibrated edge in place of raw EV in the board filter | **REJECT** | units 24,278 vs 34,062; 2 of 8 markets improve; strong-market cells in profit 835/984 vs 945/984. |
| E24 | gate-aligned per-market selection (side, confidence >= 60, EV floor) | **REJECT** | held-out gate passes: arm B 11, arm C 13, incumbent 13. Neither exceeded. |

E23 did produce the most important measurement of the programme, and it is carried
forward as **evidence, not as an adoption**: predicted edge is barely related to
realised edge.

| predicted edge bucket | n | predicted | realised | gap |
|---|---:|---:|---:|---:|
| 0-1% | 11,146 | 0.49% | -3.20% | 3.69 |
| 1-2% | 9,594 | 1.49% | -1.48% | 2.96 |
| 2-3% | 7,939 | 2.49% | -0.73% | 3.21 |
| 3-5% | 12,880 | 3.96% | -2.00% | 5.96 |
| 5-7% | 9,844 | 5.97% | 1.60% | 4.37 |
| 7-10% | 10,759 | 8.40% | 0.67% | 7.74 |
| 10%+ | 21,144 | 19.61% | 1.95% | 17.66 |

E24 also established, on held-out SELECT-B rather than on the verdict window,
that **six markets clear the gate on 0 of 3 inner cuts under every selection
rule tested**: `totals`, `spreads`, `h2h`, `pitcher_strikeouts`, `pitcher_outs`,
`batter_home_runs`. The 4/11 verdict table is not bad luck.

**That is why this programme leads with data rather than with models.** The evidence
says the binding constraint is information, so the first move is to go and get
more of it.

---

## 1. The data position, established by probe before any credit was spent

| probe | finding |
|---|---|
| `probe_api_coverage.py` | 2020, 2021, 2022 return **HTTP 422 "Historical odds are not available"**. The earliest snapshot carrying player props is **2023-05**, with all 11 markets across 19 books. |
| `probe_warehouse.ts` | `cache_mlb_historical_odds` spans **2023-05-03 → 2026-05-24**, 18.65M rows, 11 market keys. The `TO = "2026-05-24"` constant in `dump_odds.ts` is a fact about the table, not a throttle. |
| `probe_warehouse.ts` | `cache_mlb_boxscore_player_stats` starts **2024-04-01**. **Odds without a box score cannot be graded, so 2023 is dead from either source.** |
| `probe_warehouse.ts` | `runs_scored` / `batter_strikeouts` are non-null in 2024, 2025-04, 2025-05, then **0 from 2025-06 through 2026-05**, then partial 2026-06 and full 2026-07/08/09. |
| `probe_warehouse.ts` | `cache_mlb_historical_events` (the event_id <-> game_pk bridge) runs to **2026-06** only. |
| `curl` | `statsapi.mlb.com` and `baseballsavant.mlb.com` are **unreachable** from this environment. The 2025-06→2026-05 column hole cannot be repaired here. |

### The bridge, and how far it is trusted

Past 2026-06 the event_id <-> game_pk bridge is rebuilt from team names plus the
game date. That rebuild is **validated against ground truth before use**: on the
5,726 events where the warehouse already stores the true `game_pk`, it resolves
94.0% and is **correct on 99.13%** of those. Restricted to 2026-06 — the window
immediately adjacent to the tail being rebuilt — it is **248/248 correct, zero
wrong**. Doubleheaders, where two games share a pair and a date and nothing in
the provider's event distinguishes them, are **dropped, not guessed** (246
events in group A).

An earlier version of that rule derived a US *local* date by shifting back eight
hours. Measured against the same ground truth it resolved 550 events to the
**wrong game**. The measurement is what caught it; the rule now uses the UTC
date, because that is what the warehouse's `game_date` empirically equals in
5,648 of 5,726 cases.

### What is therefore fetched, and what is not

| group | window | markets | events | why |
|---|---|---|---|---|
| **A** | 2026-06-01 → 2026-09-17 | all 11 | 1,146 | box scores exist, zero odds. **The only window where `runs_scored`/`batter_strikeouts` are populated and unpriced** — the sole repair path for the two 2024-only markets, using the most recent data in the project. |
| **B** | 2026-03-01 → 2026-06-01 | all 11 | 1,017 | 2026 games the warehouse never priced. |
| **C** | 2025-04-01 → 2025-06-01 | 2 | 755 | the only 2025 months where the settled columns are non-null. |
| — | 2025-06 → 2026-05 | 2 | 0 | **not fetched.** The settled columns are 0% non-null; odds would not grade. |
| — | 2023 | all | 0 | **not fetched.** No box scores before 2024-04-01. |
| — | 2020-2022 | all | 0 | **not available.** HTTP 422. |

Estimated cost 242,930 credits of 688,391 available.

**Precedence.** Nothing already held is overwritten. New pulls land in
`apix_*.jsonl`, which `api_to_csv.py`'s default `api_*` glob does not match, and
are folded into a separate data directory selected by `UPLIFT_DATA_DIR`. On a
(event, player, line) collision `frames.read_market` already keeps the warehouse
row. Every fetched event records source, requested snapshot, served snapshot,
neighbouring snapshots, region, bridge provenance and retrieval time.

**Point-in-time.** Every pull is taken at **commence − 1 hour**, the convention
`ingest_odds_api.ts` already used. The served snapshot is stored per event so
the claim is checkable rather than asserted.

---

## 2. The NULL-vs-void repair (done, and deliberately grading-neutral)

`frames.load_candidates` dropped every candidate whose settled stat was null,
with the comment *"did not play = the book voids the prop"*. That conflated two
different events. The repair separates them and counts both:

| market | DID_NOT_PLAY (no player-game row — a true void) | DATA_MISSING (row exists, column null — a backfill hole) |
|---|---:|---:|
| batter_hits | 944 | **9,014** |
| batter_runs_scored | 133 | **8,299** |
| batter_strikeouts | 106 | **6,013** |
| batter_home_runs | 578 | **5,635** |
| pitcher_outs | 122 | **2,159** |

Over 90% of what the code called a void is a data hole.

**Both are still dropped.** An outcome that was never recorded cannot be
invented, and guessing one would be worse than losing the row. So the graded set
is unchanged by construction — verified: candidate counts match the the earlier baseline cache
exactly on all five markets checked. What changes is that a backfill gap can no
longer hide inside a void count.

---

## 3. The experimental framework

The existing contract is kept exactly:

```
WARM-UP (25%, train-only)  ->  SELECT (chosen on)  ->  VERDICT (never read)
```

and every adoption test remains nested inside SELECT:

```
SELECT-A  (rule re-derived here)  ->  SELECT-B  (rule scored here)
```

at inner cuts q in {0.5, 0.6, 0.7}. The verdict window is read **once**, at the
end, after the architecture is frozen.

**One honest consequence of adding data must be stated up front.** The verdict
window is *defined* as the later half of the out-of-sample period, cut on the
clock. That definition does not change. But because the sample changes, the
dates it covers move later. This is not a redefinition to make a result pass —
it is the same rule applied to more data, and it moves in the direction that
makes the test *harder and more production-like*, because the verdict window
becomes more recent. Two markets gain the most: `batter_runs_scored` and
`batter_strikeouts` currently have verdict windows containing **only 2024 rows**,
so their current verdicts say nothing about 2025-2026 behaviour.

Both baselines are reported side by side and neither replaces the other:

| name | data | purpose |
|---|---|---|
| the earlier baseline | current | the frozen incumbent, unchanged |
| `BASELINE_EXPANDED` | expanded | the same architecture on more data — isolates the data effect from every model effect |

**A market counts as PASS only if it clears the gate on both the Full OOS and
the Verdict window.** `PASS_WITH_RESTRICTIONS` is not counted toward the target.

---

## 4. Experiments, in execution order

Each runs only if the one before it has produced its number. Each has its
acceptance criterion fixed here.

### E25 — does more, and more recent, data help at all?
**Hypothesis.** `BASELINE_EXPANDED` beats the earlier baseline on markets clearing both gates.
**Criterion.** Report only — this is a measurement, not an adoption. The expanded
dataset is adopted as the working substrate **iff** it does not *reduce* the
both-gates PASS count, and iff `parity_audit.py` still prints 0.
**Rollback.** If the expanded data reduces the PASS count, the earlier baseline stands as the
deliverable and the expansion is reported as a negative result.

### E26 — market-specific model family
**Hypothesis.** One global spec is not optimal for eleven markets with different
target distributions.
**Design.** Per market, on SELECT-A only, by **log loss** (a proper scoring rule,
not board ROI): HistGradientBoosting (incumbent), logistic, RandomForest,
ExtraTrees, and LightGBM/XGBoost/CatBoost **if importable**. Scored on SELECT-B.
**Criterion.** Adopted per market only where the SELECT-B log-loss improvement
exceeds **0.0011**, the noise band E8/E16/E19 established, at **all three** inner
cuts. Anything that wins at one or two cuts is noise and is rejected.

### E27 — distributional / count models
**Hypothesis.** The binary over/under target discards the count structure.
Modelling P(X = k) and deriving P(X > line) is better specified for counting
props, and for `batter_home_runs` specifically a sparse-event model is better
specified than a classifier.
**Design.** Poisson and Negative Binomial on the count, plus a hurdle model for
home runs; derive the market probability at the posted line. Offered as one
additional ensemble member per market, not as a family (the E16 discipline).
**Criterion.** As E26.

### E28 — hyperparameter tuning of whatever E26 selects
**Design.** Constrained grid, nested chronologically **inside SELECT-A**, scored
on SELECT-B, objective log loss. A hard cap of 40 configurations per market.
**Criterion.** As E26.

### E29 — recency weighting / temporal adaptation
**Hypothesis.** The market prices efficiently and drifts; older seasons may hurt.
**Design.** Exponential time decay and a rolling (rather than expanding) training
window, on SELECT only.
**Criterion.** As E26.

### E30 — calibration method per market
**Design.** Platt, isotonic, beta; fitted only on folds earlier than the block
being predicted.
**Criterion.** Brier **and** log loss both improve on SELECT-B at all three cuts.

### E31 — ensembling
**Design.** Only over members that individually survived E26-E30. Weights learned
on SELECT-A. Simple average, log-loss-weighted average, and the incumbent single
member as the control.
**Criterion.** As E26, **and** it must beat the best single member, not merely the
incumbent.

---

## 5. Anti-overfitting rules, binding

* The verdict window is never read while anything is being chosen. It is read
  once, after the freeze.
* No criterion above is changed after its number exists.
* No experiment is re-run on a re-cut of the same held-out tail to get a
  different answer.
* No market is hand-picked into an architecture because it won; a rule that
  selects it must be stated and must apply to every market.
* Confidence floor never below 60. The gate is never modified. Game markets keep
  `ev_pass` parity. `parity_audit.py` must print 0 before any board is quoted.
* Failed experiments are reported with their numbers.

## 6. Success criteria

Target 11/11 clearing **both** gates; minimum 9/11, with no reliance on
`PASS_WITH_RESTRICTIONS`. If the honest result is below that, the extended work reports
the number it actually reached and names the binding constraint. A smaller
honest edge is the deliverable, not a larger manufactured one.

---

## Addendum 2 — E32, written before the experiment was run

**Where this came from, stated plainly.** `BASELINE_EXPANDED` (E25b) is adopted:
both-gates PASS went 4 -> 5 and parity still prints 0. But two markets moved the
other way, and one of them moved for a reason that is visible **without looking
at the verdict window at all**:

`batter_total_bases`'s full-OOS board fell from 3,285 rows to **409** — a 92%
volume collapse out of 116,642 graded candidates — because `run_final.choose_side`
flipped it from `under` to `over`. That function maximises SELECT units with **no
volume constraint whatsoever**, so it will happily take a side that survives on a
sliver of the board if that sliver happened to run hot in SELECT.

I did also see that this market's verdict ROI fell to -15.07%, and I am recording
that rather than pretending otherwise. The guard below is justified on the
**SELECT-half volume collapse**, which is the thing a rule can legitimately see;
it is not a threshold reverse-engineered from the verdict number, and it is
tested the same nested way every other rule in this project is.

### E32 — a volume guard on the side lever

**Hypothesis.** A side policy that discards most of the board is fitted to a thin
slice of SELECT and will not survive out of sample. Requiring the chosen side to
retain a minimum share of the both-sides board makes the lever more robust
without touching the model, the gate or the confidence floor.

**Design.** `choose_side` restricted to sides whose SELECT-A board holds at least
`f` x (the both-sides board n). If no side qualifies, fall back to `both` — the
conservative direction, since `both` is the largest board and the least-chosen
option. Everything else is identical to the incumbent, including the objective
(SELECT-A units), so the guard is the only difference.

**Robustness requirement, fixed here.** `f` is swept over {0.25, 0.40, 0.50} and
the result must hold at **all three**. A guard that only works at one value is a
threshold fitted to noise and is rejected — the same standard Phase 29 applies to
every other threshold in this work.

**Acceptance, all three required:**

1. Held-out SELECT-B gate passes, summed over the three inner cuts, **exceed**
   the unguarded incumbent's, at every `f`.
2. The four strong markets do not lose gate passes against the incumbent, at
   every `f`.
3. Production parity unchanged: `parity_audit.py` prints 0 on the final board.

**Rollback.** If any condition fails at any `f`, the guard is rejected and the
unguarded lever stands, with `batter_total_bases` reported as a known fragility
of the expanded baseline rather than patched.

---

## Addendum 3 — E26's override rule was incomplete. What was wrong and how it is fixed

E26 selected a per-market member on **log loss**, which is the right criterion for
probability quality and the wrong one on its own for *this* board. Run as
pre-registered it produced:

| market | override | full-OOS board n | what happened |
|---|---|---:|---|
| batter_total_bases | `rf` | 409 -> **5,356** | repaired the collapse; verdict ROI -15.07 -> **+1.07 PASS** |
| spreads | `price` | 1,242 -> 2,463 | verdict ROI -7.45 -> -2.91, still FAIL |
| pitcher_outs | `price` | 1,957 -> **507** | verdict n 871 -> 133, PASS -> FAIL |
| pitcher_strikeouts | `price` | 2,407 -> **1** | verdict **NO_DATA** |

Both-gates PASS went 5 -> 4. The rule made things worse.

**The mechanism, and it is structural rather than statistical.** A prop board is
`evPerUnit > tau`, and EV is positive only where the model DISAGREES with the
price. A member that is better calibrated to the price agrees with it more, so it
produces a smaller board — and `price` agrees with it exactly, so it produces
almost none. This is the same wall E21 hit ("anchoring means disagreeing with the
price less") and I walked into it again from the other side. Log loss cannot see
it, because log loss scores every row while the gate scores only the rows the
board selects.

**The fix, and why it is not verdict-tuning.** An override is additionally
required to leave a board that the gate can actually read:

> the SELECT-half board built with the override member, at the global EV floor,
> confidence floor and collapse, must hold **n >= 500**.

500 is not a tuned number: it is `EV_GATE_MIN_GRADED`, the gate's own sample
floor, and SELECT and VERDICT are equal halves of the out-of-sample period by
construction, so a SELECT board below 500 projects to a verdict board below 500.
The condition is evaluated **entirely on SELECT**, and the amended rule is re-run
from SELECT-A/SELECT-B without reference to any verdict number.

**Disclosure.** I saw the verdict-window consequence of the unamended rule before
writing this amendment, and I am recording that rather than presenting the
amended rule as if it had been specified first. What the amendment is *derived
from* is the gate's definition and a board-size fact visible on SELECT alone;
what it is not derived from is any verdict ROI. Both runs are reported.

---

## E33 — ensembles, pre-registered before running

**Hypothesis.** E26 compared single members. An average of two members may beat
either alone, which is Phase 13 of the brief. The incumbent architecture is
itself an average, so this is testing whether the *right* average differs per
market rather than whether averaging works at all.

**Design.** Per market, the override candidate set widens from 11 single members
to all 1- and 2-member combinations of them (66 candidates). Deliberately not
3-member combinations: 231 candidates over 11 markets is more chances to fit
noise than the guards below can absorb, and E16 already established that widening
a pool without adding information is pure overfit risk.

**Every guard from the amended E26 rule still applies, unchanged:**

1. the same candidate must win on SELECT-A at **all three** inner cuts;
2. it must beat the global spec on held-out SELECT-B by more than **0.0011** at
   all three;
3. its SELECT board must hold at least **500** rows (`EV_GATE_MIN_GRADED`).

**Acceptance.** Adopted only if the both-gates PASS count **exceeds** the
6/11 that the amended E26 rule produced, with `parity_audit.py` still printing 0.
A tie is a rejection, as it was for E24 and E32.

**Rollback.** If it ties or falls, the single-member override rule stands and
E33 is reported as a failed experiment.
