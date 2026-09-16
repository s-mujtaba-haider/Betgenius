"""The model as a CORRECTION to the price, with the weight learned on the clock.

Why this exists
---------------
Round 3 measured, on the SELECT half, how much skill each member has against how
much the recalibrated price alone has. The production spec -- a single `gbm`
chosen globally -- is WORSE than the price on nine of the eleven markets, and the
gap is widest on exactly the markets that fail the gate:

    totals        gbm -0.0398  vs price -0.0019     (-0.0379)
    spreads       gbm  0.0246  vs price  0.0550     (-0.0304)
    h2h           gbm  0.0033  vs price  0.0218     (-0.0185)
    pitcher_outs  gbm  0.0036  vs price  0.0195     (-0.0159)

Those are not the fourth-decimal differences E8 and E16 found between specs.
They are ten to thirty times the noise band. The cause is structural: ONE global
spec is chosen by pooling eleven markets, the pool is dominated by the two
batter markets with thirty thousand SELECT rows each (where gbm and price tie),
and the answer that suits them is then imposed on a 1,680-row market where it
does not.

The fix is not to choose a spec per market -- that is eleven chances to fit
noise, and E8 already lost that bet. It is to stop asking the model for the
probability and start asking it how far to move the price:

    logit(p) = logit(p_price) + w * (logit(p_model) - logit(p_price))

`w` is ONE number per market. w = 0 is "the price is better than anything we
have, bet the price"; w = 1 is the model outright; in between the model is a
shrunken correction. It is estimated by grid search on log loss, and it degrades
gracefully: a market where the model is worthless converges to the price instead
of being dragged away from it.

What makes it honest
--------------------
`w` is fitted ONLY on walk-forward predictions from EARLIER folds. Those
predictions are already out of sample -- policy.walkforward produced each of them
from a model trained strictly before it -- so fitting a weight on them is not
fitting on data the members have seen. Using the current fold's own predictions
would be the obvious mistake: they are in-sample for the members, the model would
look better than it is, and w would be biased toward 1 in every market.

Before MIN_FIT rows of earlier out-of-sample history exist, w is 0. The prior is
the price, and the model has to earn its way off it. That is the conservative
direction: it cannot manufacture an edge out of a market where the model never
demonstrates one.

No box score is read here and no feature is rebuilt -- this is a function of
member probabilities the cache already holds, so it cannot introduce an as-of
leak, and the placebo-lag variants move it only through the members themselves.
"""
import numpy as np
import pandas as pd

import policy

GRID = np.round(np.arange(0.0, 1.0001, 0.05), 4)
MIN_FIT = 500          # earlier OOS rows required before w may leave 0
ANCHOR = "price"


def _logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _logloss(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def _best_w(za, zm, y):
    """The grid point with the lowest log loss. Ties go to the SMALLER w, so the
    price wins a tie and the model only moves the number when it pays for it."""
    best, bw = np.inf, 0.0
    for w in GRID:
        ll = _logloss(1.0 / (1.0 + np.exp(-(za + w * (zm - za)))), y)
        if ll < best - 1e-12:
            best, bw = ll, float(w)
    return bw


def blend(cache, model="gbm", anchor=ANCHOR, warmup=policy.WARMUP,
          n_blocks=policy.N_BLOCKS, return_w=False):
    """One hybrid probability array for one cached market, by member name."""
    return blend_arrays(cache, np.asarray(cache["probs"][model], float),
                        anchor=anchor, warmup=warmup, n_blocks=n_blocks,
                        return_w=return_w)


def blend_arrays(cache, pm, anchor=ANCHOR, warmup=policy.WARMUP,
                 n_blocks=policy.N_BLOCKS, return_w=False):
    """Anchor an ARBITRARY model probability array to the price.

    Same contract as blend(): w is re-fitted at each walk-forward boundary on
    predictions from earlier folds only, and is 0 until MIN_FIT of them exist.
    Taking the array rather than a member name is what lets the whole ENSEMBLE
    be anchored, instead of anchoring one member and then averaging the anchor
    away again.
    """
    d = cache["frame"]
    y = d["overHit"].astype(int).to_numpy()
    t = pd.to_datetime(d["commenceTime"], utc=True).to_numpy("datetime64[ns]")
    pa = np.asarray(cache["probs"][anchor], float)
    pm = np.asarray(pm, float)
    za, zm = _logit(pa), _logit(pm)
    ok = np.isfinite(pa) & np.isfinite(pm)

    n = len(d)
    out = np.full(n, np.nan)
    ws = np.full(n, np.nan)
    start = int(warmup * n)
    if start < 50 or n - start < 50:
        return (out, ws) if return_w else out

    edges = [t[start]]
    step = max(1, (n - start) // n_blocks)
    for i in range(start + step, n, step):
        if t[i] > edges[-1]:
            edges.append(t[i])
    edges.append(np.datetime64("2999-01-01T00:00:00"))

    for lo, hi in zip(edges[:-1], edges[1:]):
        te = (t >= lo) & (t < hi) & ok
        if te.sum() == 0:
            continue
        # everything already SCORED before this block: out-of-sample by
        # construction, because walkforward produced it from earlier folds only
        tr = (t < lo) & ok
        w = _best_w(za[tr], zm[tr], y[tr]) if tr.sum() >= MIN_FIT else 0.0
        out[te] = 1.0 / (1.0 + np.exp(-(za[te] + w * (zm[te] - za[te]))))
        ws[te] = w
    return (out, ws) if return_w else out


def build(cache, models=("gbm", "box", "compact")):
    """{'hyb_gbm': array, ...} for one cached market."""
    have = cache["probs"]
    if ANCHOR not in have:
        return {}
    return {f"hyb_{m}": blend(cache, model=m)
            for m in models if m in have}
