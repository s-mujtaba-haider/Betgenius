"""Two extra ensemble members, built from the entry price alone.

Both are deterministic functions of columns the cache already carries
(`pFairOver`, `overOdds`, `underOdds`, `imp_over_med`, `imp_under_med`), so they
need no feature rebuild and no second pass over the box scores. Both are
walk-forward on the clock, using the same fold structure `policy.walkforward`
uses: a fold boundary is a timestamp, and a game lands wholly on one side of it.

  priceflex   the market price recalibrated against itself with a SHAPE rather
              than a slope: the logit, its square and its absolute value. A
              book's favourite-longshot bias is a curve, and the single linear
              coefficient the `price` member fits in logit space cannot bend.
  priceshop   priceflex plus the two line-shopping spreads -- how much better the
              best number on the street is than the median book, per side. The
              board bets the best number (best_price.ts), so that spread is part
              of what it is actually harvesting, and it is known at bet time.

Neither reads a box score, so neither can carry an as-of leak. `robustness.py`'s
placebo-lag variants leave them unchanged by construction, which is why the lag
profile is the right place to look for a leak in the OTHER members, not these.
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

import mlbgate as G
import policy


def _logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _edges(t, warmup=policy.WARMUP, n_blocks=policy.N_BLOCKS):
    n = len(t)
    start = int(warmup * n)
    if start < 50 or n - start < 50:
        return []
    edges = [t[start]]
    step = max(1, (n - start) // n_blocks)
    for i in range(start + step, n, step):
        if t[i] > edges[-1]:
            edges.append(t[i])
    edges.append(np.datetime64("2999-01-01T00:00:00"))
    return edges


def _walk(X, y, t, min_train=200, C=1.0):
    n = len(y)
    out = np.full(n, np.nan)
    for lo, hi in zip(_edges(t)[:-1], _edges(t)[1:]):
        te, tr = (t >= lo) & (t < hi), t < lo
        if te.sum() == 0 or tr.sum() < min_train:
            continue
        Xtr, Xte = X[tr], X[te]
        med = np.nanmedian(Xtr, axis=0)
        med = np.where(np.isfinite(med), med, 0.0)
        Xtr = np.where(np.isfinite(Xtr), Xtr, med)
        Xte = np.where(np.isfinite(Xte), Xte, med)
        mu, sd = Xtr.mean(0), Xtr.std(0)
        sd = np.where(sd > 1e-9, sd, 1.0)
        Xtr, Xte = (Xtr - mu) / sd, (Xte - mu) / sd
        if len(np.unique(y[tr])) < 2:
            out[te] = float(y[tr].mean())
            continue
        m = LogisticRegression(max_iter=3000, C=C).fit(Xtr, y[tr])
        out[te] = m.predict_proba(Xte)[:, 1]
    return out


def build(cache):
    """{'priceflex': array, 'priceshop': array} for one cached market."""
    d = cache["frame"]
    t = pd.to_datetime(d["commenceTime"], utc=True).to_numpy("datetime64[ns]")
    # policy.walkforward hands the cache a frame already sorted on the clock, and
    # the fold edges below assume it. Assert rather than trust: a frame out of
    # order would train a fold on games that had not been played.
    if len(t) > 1 and not (np.diff(t) >= np.timedelta64(0, "ns")).all():
        raise AssertionError(f"{cache['market']}: cached frame is not in commence-time order")
    y = d["overHit"].astype(int).to_numpy()
    z = _logit(d["pFairOver"].to_numpy(float))
    dispO = d["imp_over_med"].to_numpy(float) - G.implied_prob(d["overOdds"].to_numpy(float))
    dispU = d["imp_under_med"].to_numpy(float) - G.implied_prob(d["underOdds"].to_numpy(float))
    return {
        "priceflex": _walk(np.column_stack([z, z ** 2, np.abs(z)]), y, t),
        "priceshop": _walk(np.column_stack([z, z ** 2, np.abs(z), dispO, dispU,
                                            dispO - dispU]), y, t),
    }
