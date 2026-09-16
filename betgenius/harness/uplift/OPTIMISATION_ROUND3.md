# Round 3 — a deeper attempt, and what it found

Round 2 pinned the confidence floor to production's 60 and delivered 4 PASS on a
board that is 100% servable. Round 3 was asked to push toward 9–11 PASS.

**It did not get there, and no change was adopted.** Four experiments were run,
each with an acceptance criterion written down before its numbers existed, and
each was rejected on its own terms. That is the honest result, and this document
is mostly about *why* — because the reason is not that the modelling was timid.

The headline finding is uncomfortable and worth stating plainly:

> **The shipped model is measurably worse than the market price on 9 of the 11
> markets.** Not by a hair — by ten to thirty times the noise band on the four
> markets that fail the gate.

Everything else here follows from that.

---

## 0. What the final table is

Unchanged from round 2. `reports/final_matrix_c60.csv`.

| | round 2 = round 3 |
|---|---|
| PASS | 4 — `batter_hits`, `batter_rbis`, `batter_total_bases`, `batter_strikeouts` |
| PASS_WITH_RESTRICTIONS | 5 — `totals`, `spreads`, `pitcher_strikeouts`, `batter_runs_scored`, `pitcher_outs` |
| VETO | 1 — `batter_home_runs` |
| FAIL_AFTER_ITERATION | 1 — `h2h` |
| Gate, full OOS | 9 / 11 |
| Gate, verdict window | 4 / 11 |
| Board rows production would reject | **0 of 16,982** |

Verified this round, from scratch:

* the cache rebuilds to **bit-identical member probabilities** on all 11 markets;
* `run_final.py --conf=60` reproduces the table **exactly**;
* `parity_audit.py` still rejects **0** rows;
* `verify_gate.py` still replays the shipped reports with **0 mismatches**.

The verdict window was **never read** during any round-3 experiment. Every
number that decided anything came from the SELECT half.

---

## 1. Data archaeology: what actually exists

The warehouse holds five tables the uplift pipeline had never opened. They were
inventoried properly rather than assumed.

| Table | Rows | Verdict |
|---|---:|---|
| `cache_mlb_player_metadata` | 1,337 | **USED** (E19). `bats`/`throws` are static, so there is no as-of question. Covers 91.5% of batter appearances. |
| `cache_mlb_historical_opposing_pitcher` | 7,523 | **USED** (E19). Announced starter + hand, **100% of priced games**. |
| `cache_mlb_historical_weather` | 7,527 | **NOT used.** See below. |
| `cache_mlb_historical_lineups` | 135,324 | **REJECTED — leak.** Every single row was written *after* first pitch (min +87.5 hours, mean +600 days). It is the game's own lineup, backfilled, late scratches included. |
| `cache_statcast_*` | 137k | **REJECTED — coverage.** A genuine daily series (117 distinct `snapshot_date`s, each written same-day) but it starts **2026-05-20**, three months into a 29-month evaluation. There is no way to build a 2024 feature from it. |
| `cache_mlb_historical_bullpen` | 13,141 | **Not worth it.** Ends 2025-10-31, and `features.bullpen()` already rebuilds the same quantities from relief box-score lines across the full range. |

### The weather question, answered honestly

`MARKET_DIAGNOSTICS.md` said weather was "the one input that would plausibly
change the answer" for `totals`, and that "this data does not contain it". **The
second half of that is wrong** — the warehouse has weather for 100% of priced
games, from open-meteo, with a dome flag.

It was still not used, for a reason that is not laziness: open-meteo historical
is *reanalysis*. It is the weather that **happened**, not the forecast a bettor
would have had. It is not outcome leakage — weather is not caused by the game —
but it is sharper than what was knowable at bet time, and validating on actuals
while production would run on forecasts overstates the backtest. Using it
honestly needs either a forecast archive or a noise-injection sensitivity study,
and `totals` has no measurable signal for it to improve (every member has
negative skill; price AUC 0.5018). It is pulled to `data/aux_weather.csv` and
documented so a future round can do it properly.

### The data hole nobody had noticed

`runs_scored` and `batter_strikeouts` are **not randomly missing** from the box
scores. They are absent for a continuous block:

```
2024-04 .. 2024-08   100%        2026-03 .. 2026-05     0%
2025-03                0%        2026-06               47%
2025-04 .. 2025-05  90/81%       2026-07 .. 2026-09   100%
2025-06 .. 2025-12     0%   <-- twelve-month hole
```

The gap tracks **when rows were written**: the 2026-05-27/28 backfill populated a
reduced column set. Because `frames.load_candidates` drops any candidate whose
settled stat is null — treating a data gap as "did not play" — that hole silently
deletes the middle of two markets. It is exactly why `batter_runs_scored` covers
**1,589 games** and `batter_strikeouts` **1,439**, against 3,940 for
`batter_hits`, and why both have verdict windows starting in mid-2024 rather than
2025.

It cannot be repaired from here: `statsapi.mlb.com` and `baseballsavant.mlb.com`
do not resolve from this environment (the Odds API and the warehouse do). **This
is the single highest-value production fix available** and it is a data-ops task,
not a modelling one — see §6.

---

## 2. The central finding: the model is worse than the price

Measured on the SELECT half, skill = 1 − logloss/logloss(base rate):

| market | price alone | `gbm` (the shipped spec) | gbm − price |
|---|---:|---:|---:|
| **totals** | −0.0019 | −0.0398 | **−0.0379** |
| **spreads** | 0.0550 | 0.0246 | **−0.0304** |
| **h2h** | 0.0218 | 0.0033 | **−0.0185** |
| **pitcher_outs** | 0.0195 | 0.0036 | **−0.0159** |
| **pitcher_strikeouts** | 0.0776 | 0.0651 | **−0.0125** |
| batter_runs_scored | 0.0150 | 0.0126 | −0.0024 |
| batter_strikeouts | 0.0499 | 0.0488 | −0.0011 |
| batter_home_runs | 0.0261 | 0.0254 | −0.0007 |
| batter_total_bases | 0.0290 | 0.0288 | −0.0002 |
| batter_hits | 0.0895 | 0.0895 | 0.0000 |
| batter_rbis | 0.0086 | 0.0101 | +0.0015 |

**9 of 11 markets are worse under the shipped spec than under the price alone**,
and the five worst are — exactly — the five markets that fail the verdict gate.
These are not the fourth-decimal differences E8 and E16 established as noise.
`totals` is twenty times worse; `h2h` six times.

**The cause is structural.** One global spec is chosen by pooling eleven markets.
The pool is dominated by `batter_hits` and `batter_total_bases`, ~33,000 SELECT
rows each, where `gbm` and `price` tie exactly. The answer that suits them is
then imposed on a 1,680-row `h2h` market where it is badly wrong.

And the objective makes it worse, in a way that is easy to miss: it counts
markets clearing the SELECT gate, that gate needs **n ≥ 500**, and a
better-calibrated probability *disagrees with the price less* and therefore
produces a **smaller** board. **The objective rewards disagreement, because
disagreement makes volume.** A well-calibrated member cannot win a menu contest
under it — which is not a hypothesis, it is what E20 measured.

---

## 3. The four experiments

All pre-registered in `reports/experiment_log_v2.csv`. All rejected.

### E16 — richer price-only members → REJECTED
`pricevig` (vig width + book count), `priceline` (ladder position), `priceiso`
(isotonic price map). None beats the incumbents by more than **0.0005 skill** on
any market; `priceiso` is uniformly worse. The price-only family is saturated.

### E19 — handedness → REJECTED (and this one hurt)

`features.py` contained **no handedness of any kind**. That was the largest
identifiable gap: the platoon split is the best-established effect in baseball.
Built: `platoon`, `oppSpLhp`, `selfLh`, and as-of splits `vhClr`, `vhClrEdge`,
`vhN`, `vhRate`, `vhRateRel`, plus the opposing lineup's as-of record against
that hand.

Point-in-time integrity was verified first — `check_asof_hands.py` recomputes the
split the slow way: **0 mismatches, 0 wrong-hand, and 47–97% of sampled rows
would change if the game's own day were let in** (a test that passes because
nothing moves is not a test).

Two independent lines then rejected it:

* **Nested board test:** 19/33 held-out splits in profit vs 20/33, and the four
  strong markets fell 12/12 → 11/12. Fails the pre-registered bar.
* **Log loss:** adding handedness moves `gbm` skill by +0.0008/+0.0005/+0.0016 on
  the markets it helps — inside the known noise band — and only **21 of 55**
  member-market cells improve, *worse than a coin flip*.

The nested test had shown handedness improving `batter_runs_scored`,
`batter_rbis` and `pitcher_outs` at **all three** inner cuts, which looked
convincing. The log-loss measurement says that was board-selection noise, not
information. This is precisely why a proper scoring rule is worth more than an
ROI number.

**Why it fails is the interesting part: the platoon matchup is already in the
price.** The book knows who is starting and which way the batter hits. This is
the same wall E12 and E16 hit, and it generalises: *public, well-known
information is already priced.*

### E20 — offer the price-anchored hybrid as a member → REJECTED, instructively

The hybrid asks the model not for the probability but for **how far to move the
price**:

```
logit(p) = logit(p_price) + w · (logit(p_model) − logit(p_price))
```

`w` is one number per market, grid-searched on log loss, re-fitted at every
walk-forward boundary using **only predictions from earlier folds** (already out
of sample). `w = 0` until 500 such rows exist, so the price is the prior and the
model must earn its way off it.

Measured on SELECT before any board test, it **beats `gbm` on 10 of 11 markets**:
`totals` +0.0368, `spreads` +0.0301, `h2h` +0.0193, `pitcher_outs` +0.0161,
`pitcher_strikeouts` +0.0128 — while staying within 0.0011 of the price
elsewhere. The learned weight recovers the skill ranking with no hand-tuning:

| market | learned `w` | reading |
|---|---:|---|
| totals, spreads | **0.00** | the model is worthless here — bet the price |
| h2h, pitcher_outs, pitcher_strikeouts | 0.15–0.20 | a small correction |
| batter_total_bases, batter_home_runs | 0.35–0.50 | half weight |
| batter_hits, batter_rbis | 0.50–0.70 | the model genuinely earns it |

Offered to the global search as one extra member, **the two arms came back
bit-identical**: the search never picked it, at any inner cut. Rejected on the
pre-registered tie-break (equal splits, equal units). The hybrid was never
exercised — see §2 for why it *could not* be.

### E21 — make the price anchor structural → REJECTED

If a better member cannot win a menu contest, stop offering it as an option.
Arm C wrapped the *whole* ensemble in the anchor, so the search chooses what goes
**inside** it, not whether to use it. This removes a degree of freedom rather
than adding one — the same argument that carried E18.

| | incumbent | anchored |
|---|---:|---:|
| held-out splits in profit | 20 / 33 | **23 / 29** |
| held-out n | 15,052 | 4,659 |
| held-out units | **508.8** | 308.4 |
| median ROI | 2.80% | **6.31%** |
| strong markets in profit | **12 / 12** | 11 / 12 |

Two of three pre-registered conditions fail (units, strong-market guard), so it
is rejected. But the per-market picture is the most interesting result of the
round:

| market | incumbent (3 cuts) | anchored (3 cuts) |
|---|---|---|
| pitcher_outs | −7.55 / −8.16 / −3.34 | **+4.74 / +12.32 / +12.19** |
| spreads | 3.24 / 1.10 / −0.25 | **6.31 / 6.99 / 5.01** |
| batter_rbis | 5.15 / 5.81 / 10.00 | **11.96 / 13.36 / 11.67** |
| batter_total_bases | 3.34 / 4.36 / 4.25 | **9.28 / 6.62 / 5.12** |
| batter_hits | **14.28 / 20.73 / 21.29** | 5.82 / 6.68 / −0.62 |
| totals | −5.47 / −1.12 / −20.90 | *no board at all* |

**The anchor is right for thin markets and wrong for thick ones.** It also
starves `totals` and `batter_home_runs` below `MIN_SELECT_N` entirely, because
anchoring means disagreeing with the price less.

One honest caveat: arm C's search also moved the EV floor from 0.00 to 0.04, so
the `batter_hits` collapse is **not cleanly attributable to the anchor**. The
anchor is confounded with a tighter floor. Isolating it needs a fresh
pre-registration, not a re-reading of this one.

---

## 4. Why round 3 stopped where it did

`E21-RULE` said, in writing, before the run: *"This is the LAST architectural
experiment of round 3: if it fails, the `_c60` solution stands and the report
says the search space was exhausted."*

It failed. Continuing to re-cut the same held-out tail until something passes is
exactly the behaviour that makes a backtest worthless, and it is what the brief
forbids. So round 3 stops, and the promising direction is handed forward with
its evidence rather than adopted on a re-read.

---

## 5. Why 9/11 was not reached — the actual constraint

Not modelling technique. The evidence says the ceiling is **information**:

1. **Everything public is already priced.** Handedness — the single most
   obviously-missing feature in the set — adds nothing, because the book prices
   it too. The same wall stopped E12 (totals), E13 (line shopping) and E16.
2. **The model is worse than the price on 9/11 markets.** A model that trails the
   price cannot generate honest edge; it can only generate *disagreement*, which
   the current objective mistakes for value.
3. **Four markets are underpowered by construction.** `totals` 236, `pitcher_outs`
   264, `pitcher_strikeouts` 500, `h2h` 546 verdict picks. Below n = 500 the gate
   demands the CI clear zero, which needs ~10–13% flat ROI. No honest MLB board
   returns that.
4. **Two markets are missing a year of data** (§1), which is why their samples and
   verdict windows are what they are.
5. **`batter_home_runs` is removed by a product rule**, not by a model: D-164
   deletes 34,176 of the 34,207 rows that clear confidence 60.

Reaching 9/11 from here would require either loosening the confidence floor —
which is what created round 1's 36%-unservable board — or betting markets the
model has no measured skill in. Both are refused.

---

## 6. Production recommendations, in priority order

1. **Re-run the box-score backfill with the full column set for 2025-03 →
   2026-06.** `runs_scored` and `batter_strikeouts` are missing for twelve
   months. This is the highest-value action available and it is data-ops, not
   data science: it would roughly double the sample for two markets, one of
   which currently fails on sign with a large board.
2. **Fix the null-vs-absent conflation.** `frames.load_candidates` drops a
   candidate whose settled stat is null, with the comment "did not play". When
   the box-score *row exists* but the column is null, that is a data gap, not a
   void, and it should be recorded as such rather than silently deleted.
3. **Keep capturing Statcast daily.** The table is well-formed and genuinely
   as-of; it is simply too young. From 2026-05-20 it accumulates, and in a year
   it becomes usable — it is the one source here that contains something the
   book may *not* fully price (barrel rate, xwOBA, CSW%).
4. **Capture opening and closing prices.** The odds dumps hold a single snapshot
   per (event, line): no open, no close, no per-book detail, no snapshot
   timestamp. Line movement and CLV are the standard way to tell a real edge from
   a lucky one, and none of it can be reconstructed now.
5. **Add a weather *forecast* feed** if `totals` is ever revisited. The warehouse
   has realised weather, which is the wrong thing to validate on.
6. **Do not let the confidence floor be searched.** It is the production
   contract. `parity_audit.py` must print 0 before any board is quoted.
7. **Revisit the price-anchored architecture** (§3, E21) in a future round, with a
   fresh pre-registration that isolates it from the EV floor. It is the most
   promising direction found, and the learned-`w` table is the evidence.

---

## 7. Reproducing round 3

```bash
cd betgenius

# the data pull (read-only; writes nothing to the warehouse)
python harness/uplift/dump_aux.py

# point-in-time integrity of the rejected handedness features
python harness/uplift/check_asof_hands.py --n=150

# the four experiments, all SELECT-only -- none reads the verdict window
python harness/uplift/exp_price_members.py                  # E16
UPLIFT_CACHE_DIR=$PWD/harness/uplift/cache_h python harness/uplift/build_cache.py
python harness/uplift/exp_featureset.py --a=cache --b=cache_h   # E19
python harness/uplift/exp_hybrid.py --tag=_hybrid            # E20
python harness/uplift/exp_hybrid.py --anchored-only --tag=_anchored  # E21

# the authoritative table -- unchanged from round 2
python harness/uplift/run_final.py --conf=60 --tag=_c60
python harness/uplift/parity_audit.py --tag=_c60     # must print 0 rejected
python harness/uplift/final_matrix.py --tag=_c60
```

`UPLIFT_HANDS=1` rebuilds the cache with the rejected handedness features. With
it unset — the default — `features.py` reproduces the `_c60` cache bit for bit,
which was verified this round by rebuilding from scratch and comparing every
member probability on all eleven markets.

The checkpoint of the adopted solution is branch `checkpoint/c60-round2`, tag
`c60-round2`, commit `8448c70`, with a physical copy and source hashes in
`checkpoint_c60/`.
