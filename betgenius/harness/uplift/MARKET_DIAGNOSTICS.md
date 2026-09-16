# Why each market fails, market by market

Written against the **baseline** run (`reports/final.csv`, architecture v1) before
anything was changed, so it is a diagnosis and not a defence of a fix. Every
number in it is reproducible: `python harness/uplift/final_matrix.py`.

---

## The one finding that explains most of the table

The verdict-window gate is a **sample-size cliff**, not a model-quality cliff.

```
graded n >= 500  AND  ROI > 0                 -> PASS
otherwise, the 95% ROI CI lower bound  > 0    -> PASS
```

On a board of roughly even-money bets the unit-profit series has a standard
deviation near 1.0, so the CI branch needs about `1.96 / sqrt(n)` of ROI to
clear zero. That is the whole story for five of the eleven markets:

| Market | Verdict n | Verdict ROI | What the gate is actually asking for |
|---|---:|---:|---|
| batter_hits | 1521 | +10.57% | ROI > 0 |
| batter_rbis | 709 | −0.76% | ROI > 0 |
| spreads | 1106 | −0.18% | ROI > 0 |
| batter_total_bases | 3795 | +4.27% | ROI > 0 |
| batter_runs_scored | 1623 | −1.74% | ROI > 0 |
| batter_strikeouts | 720 | +5.84% | ROI > 0 |
| **totals** | **240** | +2.99% | **ROI > ~12.7%** |
| **pitcher_strikeouts** | **334** | +0.21% | **ROI > ~10.7%** |
| **h2h** | **387** | −0.70% | **ROI > ~10.0%** |
| **pitcher_outs** | **306** | +0.69% | **ROI > ~11.2%** |
| **batter_home_runs** | **14** | −44.16% | **ROI > ~52.4%** |

No honest MLB board returns 11% flat. Four of those five markets are **positive
but underpowered**, which is a different thing from losing, and the only
legitimate routes out are (a) more volume at the same edge, or (b) accepting the
restriction. Manufacturing 11% ROI by tightening a threshold until only the
winners are left is the illegitimate route, and it is not taken here.

The other three failures — `batter_rbis`, `spreads`, `batter_runs_scored` — have
all the sample they need and are a fraction of a point below zero. Those are the
markets where a genuine improvement in probability quality can flip a status.

---

## Where the board volume goes

Scored candidates, then each filter in the order the board applies it
(confidence floor 55, D-164 heavy-juice veto, EV floor 0.02):

| Market | scored | after conf ≥ 55 | after juice veto | after EV floor | parity |
|---|---:|---:|---:|---:|---|
| batter_hits | 70,646 | 20,555 | 7,358 | 2,530 | ev_filtered |
| batter_rbis | 53,920 | 49,146 | 6,764 | 2,213 | ev_filtered |
| totals | 4,680 | 1,255 | 1,255 | 1,255 | ev_pass |
| spreads | 4,240 | 2,519 | 2,519 | 2,519 | ev_pass |
| batter_total_bases | 66,232 | 35,872 | 29,606 | 7,444 | ev_filtered |
| **batter_home_runs** | **41,686** | **37,310** | **26** | **26** | ev_filtered |
| pitcher_strikeouts | 14,554 | 6,791 | 4,812 | 1,335 | ev_filtered |
| h2h | 3,360 | 1,366 | 1,366 | 1,366 | ev_pass |
| batter_runs_scored | 23,257 | 18,553 | 12,831 | 5,415 | ev_filtered |
| pitcher_outs | 5,002 | 2,170 | 2,137 | 1,008 | ev_filtered |
| batter_strikeouts | 20,844 | 8,234 | 4,946 | 1,938 | ev_filtered |

Two rows in that table are the diagnosis of two whole markets.

---

## Per-market

### batter_hits — PASS
* **Full OOS** n 2,415, ROI +8.95%, CI low +5.60 — PASS.
* **Verdict** n 1,521, ROI +10.57%, CI low +5.95 — PASS.
* **Primary failure reason** none.
* **Secondary** none. Worth noting the confidence floor costs it an enormous
  board: at the same EV floor with no confidence floor it holds 11,677 SELECT
  picks at +4.83% with all three sub-periods positive, versus 894 at +6.17%.
* **Potential improvement** volume, not edge.
* **Risk** a bigger board at a lower rate is more exposed to book limits than to
  model error.
* **Validation** SELECT-half sub-block ROIs; nested SELECT-A/SELECT-B.

### batter_total_bases — PASS
* **Full OOS** n 7,039, +3.38%, CI low +1.38. **Verdict** n 3,795, +4.27%, CI low +1.51.
* **Primary failure reason** none. The thickest board in the set.
* **Potential improvement** none needed; protect it.
* **Risk** any global change that tightens the EV floor costs it volume.
* **Validation** as above.

### batter_strikeouts — PASS
* **Full OOS** n 1,869, +6.78%. **Verdict** n 720, +5.84%, CI low +0.16 — the
  narrowest PASS in the table, carried by n ≥ 500 rather than by the CI.
* **Primary failure reason** none, but the margin is one bad month wide.
* **Risk** it PASSes on the `n >= 500 and ROI > 0` branch; anything that drops
  its verdict board below 500 moves it to the CI branch and it fails there.
* **Validation** as above.

### batter_rbis — PASS_WITH_RESTRICTIONS
* **Full OOS** n 2,091, +2.03%, CI low −1.39 — PASS on volume.
* **Verdict** n 709, −0.76%, CI low −6.75 — FAIL by three quarters of a point.
* **Primary failure reason** a thin true edge. The market's own de-vigged price
  is already good: the best member beats it by 0.0018 of log-loss skill.
* **Secondary** the board is 89% unders at heavy juice, so a small miscalibration
  is expensive.
* **Potential improvement** more volume at the same rate, so the sign of the
  verdict ROI is decided by more picks; the `offset`/`box` members score slightly
  better than the shipped ensemble here on SELECT log loss.
* **Risk** per-market ensemble selection did not survive the nested test.
* **Validation** SELECT log loss over all 26,946 scored rows, not board ROI.

### spreads — PASS_WITH_RESTRICTIONS
* **Full OOS** n 1,877, +1.06%. **Verdict** n 1,106, −0.18% — FAIL by a fifth of
  a point, with more than twice the sample the gate needs.
* **Primary failure reason** it is scored through `ev_pass`, which has **no EV
  filter at all** — production's game write path carries no `evPerUnit`
  (`harness/lib/report.ts:121`). Confidence and the juice veto are the only
  things selecting these picks.
* **Secondary** the highest-EV quartile of spread picks returns −11.2% on the
  SELECT half: where this model disagrees most with the price, it is most often
  wrong. A signed-handicap market punishes an over-confident model hard.
* **Potential improvement** score it through `ev_filtered` like the props. On
  SELECT that takes it from +1.62% with 1 of 3 sub-periods positive to +2.90%
  with 3 of 3.
* **Risk** the board it implies cannot be served today without shipping
  `ev_per_unit` on the game write path.
* **Validation** SELECT-half sub-block stability; nested SELECT-A/SELECT-B.

### h2h — PASS_WITH_RESTRICTIONS
* **Full OOS** n 966, +0.35%. **Verdict** n 387, −0.70%, CI low −9.18 — fails
  both on sign and on power.
* **Primary failure reason** the same `ev_pass` gap as spreads.
* **Secondary** `gbm` and `iso` are badly over-dispersed here — calibration
  slopes of 0.51 and 0.28 against a well-behaved 0.88 for the price member — so
  the shipped three-member ensemble is *worse* than the price alone on log loss.
* **Potential improvement** EV filter, and a curved recalibration of the price
  (`priceflex`) which is the best member on this market.
* **Risk** as spreads.
* **Validation** SELECT log loss on 1,680 rows; sub-block stability.

### pitcher_strikeouts — PASS_WITH_RESTRICTIONS
* **Full OOS** n 624, +4.35%. **Verdict** n 334, +0.21% — positive, underpowered.
* **Primary failure reason** volume. 334 picks cannot clear a CI.
* **Secondary** the `over`-only side policy roughly halves the board, and the
  side was chosen on SELECT units — the one lever that failed the nested test.
* **Potential improvement** more volume; the price member alone is the best
  scorer here (skill 0.0766) so complexity is not what it needs.
* **Risk** relaxing the side lever is exactly the change that returned −14.6% on
  a held-out tail when it was allowed to flip this market to `under`.
* **Validation** nested SELECT-A/SELECT-B, three inner cuts.

### pitcher_outs — PASS_WITH_RESTRICTIONS
* **Full OOS** n 960, +4.21%. **Verdict** n 306, +0.69% — positive, underpowered.
* **Primary failure reason** volume.
* **Secondary** the feature set adds nothing: `price` alone has the best log loss
  (skill 0.0190) and every feature-carrying member is worse, the worst of them at
  calibration slope 0.32.
* **Potential improvement** volume. The pitch-budget model is already the thing
  keeping this market alive at all.
* **Risk** its lowest-EV quartile returns −8.0%, so a looser EV floor is the
  wrong direction here specifically.
* **Validation** as above.

### batter_runs_scored — PASS_WITH_RESTRICTIONS
* **Full OOS** n 5,049, +1.26%. **Verdict** n 1,623, −1.74% — the largest verdict
  board that fails, and it fails on sign.
* **Primary failure reason** a genuinely thin edge, spread very wide. Its verdict
  window starts 2024-06-28, so it spans almost the whole sample: this is not an
  underpowered market, it is a low-edge one.
* **Secondary** it is the only market whose data comes entirely from the provider
  re-pull rather than the warehouse, so its price snapshots are a different
  vintage from the rest.
* **Potential improvement** the shipped ensemble is already the best-scoring one
  here. A tighter EV floor lifts SELECT ROI monotonically (+0.78% at 0.0 → +3.95%
  at 0.04) with all three sub-blocks positive, at a third of the volume.
* **Risk** trading volume for rate on the one market that has volume to spare is
  defensible; doing it per-market is the knob that failed the nested test.
* **Validation** SELECT sub-block ROIs at each EV floor.

### totals — PASS_WITH_RESTRICTIONS, and it should not be chased
* **Full OOS** n 544, +3.94%. **Verdict** n 240, +2.99%, needing ~12.7%.
* **Primary failure reason** **there is no signal**. Every member has negative
  skill on the SELECT half. Price AUC 0.5018; the best member reaches 0.5206.
  The de-vigged market probability itself has a standard deviation of 0.017,
  because the book moves the line until the total is a coin flip — there is
  almost no cross-sectional variation left to exploit.
* **Secondary** volume: 240 verdict picks.
* **Potential improvement** none available from this feature set. Weather at the
  timestamp, which the roadmap names and this data does not contain, is the one
  input that would plausibly change the answer.
* **Risk** any positive result on this market from this data should be treated as
  noise until it is reproduced on a feature set that contains something the book
  does not already price.
* **Validation** log loss, skill and AUC per member on the SELECT half.

### batter_home_runs — VETO, and it is not a model failure
* **Full OOS** n 23, −25.49%. **Verdict** n 14, −44.16%.
* **Primary failure reason** **a shipped product rule removes the entire market.**
  Only one line exists (0.5). The median over is +675 and the median under −1000.
  The model picks the under on 89.5% of scored rows, at confidences of 80–95, and
  the D-164 heavy-juice veto — `conf >= 80 and odds <= -300`, `conf >= 90 and
  odds <= -350` — deletes **37,284 of the 37,310** rows that clear the confidence
  floor. Twenty-six survive. One of them is an over.
* **Secondary** on the over side, where the veto does not reach, the model's mean
  confidence is 14.8% against an implied 12.9%, so a board exists in principle —
  but every member has negative skill on the SELECT half here too, and an
  unfiltered over board returns sub-period ROIs of +17.0%, −1.8%, −14.6%. That is
  longshot variance, not an edge.
* **Potential improvement** none that is a modelling change. The two honest
  options are both product decisions: report the market as having no servable
  board, or revisit D-164 for markets whose fair price sits beyond −200 by
  construction. Neither is taken here unilaterally.
* **Risk** forcing a PASS on this market would require either overriding the veto
  or betting longshots on a model with no measured skill. Both are refused.
* **Validation** full candidate anatomy; per-member skill on the SELECT half.

---

## What this rules out as the explanation

Checked and **not** the cause of the failures:

* **A leak.** The as-of joins cut on local calendar date, `check_asof.py`
  recomputes sampled rows the slow way, and the placebo-lag variants in
  `robustness.py` are what a same-game leak would die at.
* **The gate being wrong.** `verify_gate.py` replays the shipped harness reports
  through the Python port and reproduces their published `evGate` block with zero
  mismatches.
* **Line shopping doing the work.** Betting the raw de-vigged consensus price at
  the best available number qualifies 102 picks on `batter_hits`, 25 on
  `batter_total_bases` and 1–2 on the game markets, and loses on all of them. The
  best-versus-consensus spread is not wide enough to clear a 2-point EV floor by
  itself; the board exists because the recalibration disagrees with the price.
* **An odds-range effect.** ROI by entry-price bucket shows no pattern that
  survives across markets.
