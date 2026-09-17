# The final configuration — pre-registration

Written **before** any the final configuration number existed. Every acceptance criterion below
is fixed at the moment of writing and is not re-read, re-weighted or re-scoped
after the fact. Experiments that fail their criterion are reported as failures.

## Standing rules (carried forward unchanged)

1. The gate (`mlbgate.py`) is not modified. `verify_gate.py` must keep replaying
   the shipped reports with 0 mismatches.
2. The confidence floor is pinned at **60**, the production contract. It is never
   searched.
3. **Full OOS** keeps its meaning: the whole out-of-sample period after warm-up.
   **Verdict window** keeps its meaning: the later half of that period, cut on
   the clock, per market.
4. The verdict window is **never read while choosing anything**. All selection
   happens on SELECT, and every adoption test is nested: a rule is re-derived on
   SELECT-A and scored on held-out SELECT-B.
5. Every final board row must pass the shipped serving predicates —
   `parity_audit.py` must print **0 rejected**.
6. Features may only read box scores from an earlier local calendar date.

## Baseline

the earlier baseline, tag the earlier baseline tag. 4 PASS / 5 PASS_WITH_RESTRICTIONS / 1 VETO / 1 FAIL;
full-OOS gate 9/11; verdict gate 4/11; 0 of 16,982 board rows unservable.
Physical copy in `checkpoint_baseline/`, source and cache hashes recorded
there.

## What an earlier stage left open

the earlier stage's most promising result was the price-anchored architecture (E21):

```
logit(p) = logit(p_price) + w * (logit(p_model) - logit(p_price))
```

It was rejected, but its own write-up records the reason the rejection is not
final: *"arm C's search also moved the EV floor from 0.00 to 0.04, so the
`batter_hits` collapse is not cleanly attributable to the anchor. The anchor is
confounded with a tighter floor. Isolating it needs a fresh pre-registration."*

Inspecting `reports/hybrid_anchored.csv` confirms the confound is severe and
mechanical, not incidental. The anchor shrinks the model toward the price, which
compresses the EV distribution; an EV floor of 0.04 applied to a compressed EV
distribution removes most of the board. Arm C's boards are 3.5x to 60x smaller
than arm A's at the same market (`pitcher_strikeouts` 571 -> 9). **A fixed EV
floor is not a comparable setting across the two arms.** The final configuration opens here.

---

## E22 — Isolate the price anchor from the EV floor

**Hypothesis.** At *matched* (spec, EV floor, ladder collapse), wrapping the
whole ensemble in the price anchor improves held-out SELECT-B performance on the
markets where the model has measurably less skill than the price, and does not
damage the markets where it does not.

**Design.** Three inner cuts q in {0.5, 0.6, 0.7} of each market's SELECT half.
Full factorial over the incumbent grid: 41 specs x EV floor in {0, 0.01, 0.02,
0.04} x collapse in {maxEv, mostBooks}, confidence pinned at 60. Every cell is
built twice, anchor OFF and anchor ON. Side is chosen on SELECT-A inside each
arm. Everything is scored on SELECT-B.

Two readings come out of one run:

* **free** — each arm searches the whole grid on SELECT-A and is scored on
  SELECT-B. This reproduces the earlier stage's comparison.
* **matched** — for each cell, anchor ON minus anchor OFF on SELECT-B. This is
  the isolation, and it is the reading E22 is judged on.

**Acceptance (matched reading), all three required:**

1. Anchor ON beats anchor OFF on held-out SELECT-B units, pooled over all cells
   and all three inner cuts, at EV floor 0.00.
2. The win is not carried by one market: anchor ON must improve held-out SELECT-B
   units in **at least 6 of the 11** markets at matched settings.
3. **Regression guard** — the four strong markets (`batter_hits`, `batter_rbis`,
   `batter_total_bases`, `batter_strikeouts`) must keep at least **11 of 12**
   held-out splits in profit, the incumbent's own score.

**If E22 passes**, the anchor is adopted structurally and the final architecture
is re-derived with it. **If it fails**, the anchor is closed permanently and the
an earlier stage recommendation to revisit it is withdrawn with evidence.

---

## E23 — Edge calibration

**Hypothesis.** A nominal EV of x% does not realise x%. If the model
systematically overstates edge, a chronologically-fitted shrinkage from
estimated edge to calibrated edge improves board selection without any new
feature or model.

**Design.** On SELECT only, bucket every candidate by predicted EV per unit
(0-1%, 1-2%, 2-3%, 3-5%, 5-7%, 7-10%, 10%+) and measure realised ROI, win rate
and n per bucket, per market, **chronologically** — each bucket's realised edge
is estimated from strictly earlier folds and applied forward, the same contract
`hybrid.blend_arrays` already honours for `w`. Board selection then uses the
calibrated edge.

**Acceptance:** held-out SELECT-B units improve, and the four strong markets keep
11 of 12 splits in profit.

---

## E27 — The distributional model as a member, not a feature

**Hypothesis.** `features.py` already builds a Poisson and a negative-binomial
count model per prop market and hands their implied P(X > line) to the
calibrator **as features**. Offering that probability **directly** as an ensemble
member — so it is not re-weighted by a logistic fitted on 25 other columns — may
preserve information the current path dilutes.

**Design.** One extra member per prop market, built from the cached columns
only. Same nested SELECT-A / SELECT-B test, same pool-growth discipline as E16
(one member, not a family).

**Acceptance:** as E22 conditions 1 and 3.

---

## E28 — Is the `gbm` member under-tuned?

**Hypothesis.** `policy._fit_predict_gbm` is hardcoded at depth 3, 8 leaves, L2
5.0, 200 iterations, chosen by hand. Proper chronological hyperparameter search
may find a better member.

**Design.** Nested chronological search inside SELECT-A only, objective = log
loss (a proper scoring rule, not board ROI), scored on SELECT-B. Never tuned
against verdict ROI.

**Acceptance:** log-loss improvement on SELECT-B larger than the 0.0011 noise
band E8/E16/E19 established, on at least 6 of 11 markets, **and** E22 condition 3.

---

## E29 — Temporal adaptation

**Hypothesis.** The degradation in the later period is under- or over-adaptation.
Recency-weighted training, a rolling rather than expanding window, and a denser
refit schedule are each testable.

**Design.** Walk-forward only, on SELECT. Objective = log loss.

**Acceptance:** as E28.

---

## Stopping rule

The final configuration runs E22 onward. **No experiment may be re-run with a changed
criterion after seeing its result**, and no result may be taken from a re-cut of
the same held-out tail. If every experiment fails, the the earlier baseline solution stands and
The final configuration reports that, exactly as an earlier stage did.

The final table is produced **once**, from the frozen architecture, after all
adoption decisions are closed.

## Success criteria (from the brief)

11/11 PASS target, 10/11 secondary, 9/11 minimum — but a market counts as PASS
only if it genuinely satisfies the existing gate under the existing
production-compatible pipeline. If the honest answer is below 9/11, the final configuration says
so and names the limitation.

---

## Addendum, written after E22 and E23 closed and before E24 was run

E22 and E23 are both **rejected on their own pre-registered criteria**, and those
verdicts stand. But E23 exposed a defect in how I wrote those criteria, and the
honest thing is to name it rather than quietly re-read the experiment.

**The defect.** E22 and E23 were both judged on *held-out units*. The gate is not
a units test. It is:

```
n >= 500  ->  PASS iff ROI > 0
n <  500  ->  PASS iff the 95% CI lower bound clears zero
```

That is **ROI subject to a sample-size floor**, and units is `ROI x n` — a
quantity that a rule can raise by adding volume at a worse price. So a rule that
correctly trades volume for ROI scores *badly* on a units criterion while scoring
*well* on the gate. E23 is exactly that case: it lifts held-out SELECT-B ROI on
6 of 8 markets (`pitcher_strikeouts` -1.46 -> +2.07, `pitcher_outs` -1.51 ->
+1.47, `batter_total_bases` 1.44 -> 3.52) and still fails, because it cuts the
board by 50-75% and loses more units than it gains.

This is the same misalignment an earlier stage identified inside the model search — *"the
objective rewards disagreement, because disagreement makes volume"* — and I had
reproduced it in my own acceptance tests.

**What does not change.** E22 and E23 keep their verdicts. Their criteria were
fixed in advance and they failed them. Neither is re-run, re-scored or
re-interpreted into an adoption.

**E24 is a new experiment with a new criterion, fixed below before it was run.**

## E24 — A gate-aligned per-market selection layer

**Hypothesis.** The board's selection rule is chosen to maximise units, while the
gate rewards ROI at n >= 500. Choosing the selection knobs on a *gate-aligned*
objective — the best ROI that still clears the sample floor — should convert
markets that sit just below zero into markets that clear it, without touching the
model, the features or the data.

**What may move, and why each is production-legal.**

* **Confidence floor, per market, upward from 60 only.** Production already
  ships this exact control: `Dashboard.tsx` renders confidence tiers at 60, 70,
  80 and 90, and its headline card counts picks at >= 65. A board at a higher
  floor is a strict SUBSET of the `isEvPassPick` board, so every row stays
  servable and `parity_audit.py` must still print 0. The floor is **never** taken
  below 60.
* **EV floor, per market, upward from the global floor only.** Same argument:
  a strict subset of the arm-A board.
* **Side policy, per market.** The lever `MLB_EV_SIDE_POLICY` already pulls.

Because every knob may only *tighten*, arm B's board is a strict subset of arm
A's board in every cell. Unservable rows cannot be introduced by construction,
and the earlier failure mode cannot recur.

**What may not move.** The gate, the definition of Full OOS or of the Verdict
Window, the `ev_pass` parity of the three game markets, and the confidence floor
downward. The model, the features and the data are untouched.

**Design.** Three inner cuts q in {0.5, 0.6, 0.7}. The global (spec, EV floor,
collapse) is chosen on SELECT-A by the incumbent's own objective and is shared by
both arms, so the only difference between them is the per-market layer.

* **arm A** — incumbent: side chosen on SELECT-A by units, confidence 60.
* **arm B** — per-market (side, confidence, EV floor) chosen on SELECT-A by
  **ROI subject to n >= 500q**, the sample floor that projects to 500 picks in a
  window of the verdict window's length. (SELECT-A holds q x 50% of the scored
  rows and the verdict window holds 50%, so a board rate yielding n in SELECT-A
  yields about n/q in the verdict window. No verdict data is read — only the
  arithmetic of the quantiles.)
* **arm C** — arm B plus a stability guard: among settings clearing the sample
  floor, only those whose worst of three chronological SELECT-A sub-blocks is
  positive are eligible; if none is, arm C falls back to arm B's choice.

**Acceptance, gate-aligned, all three required:**

1. **Primary.** Summed over the three inner cuts, the number of (market, cut)
   splits whose held-out SELECT-B board is a `mlbgate.verdict` **PASS** must
   **exceed** arm A's count.
2. **Regression guard.** On the four strong markets the arm must not lose gate
   passes against arm A.
3. **Servability.** Confidence never below 60, EV floor never below the global
   floor, game markets still graded on `ev_pass`. Verified structurally and
   re-verified by `parity_audit.py` on the final board.

If both B and C pass, the simpler arm (B) is adopted. If neither passes, the
per-market layer is rejected and the earlier baseline stands.
