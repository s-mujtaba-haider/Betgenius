"""E16: are there price-only ensemble members better than priceflex/priceshop?

Cheap by construction: every candidate is a walk-forward logistic on columns the
cache already carries, so nothing is refit over box scores and no member can
carry an as-of leak. Scored by log loss and skill on the SELECT HALF ONLY -- the
verdict window is never read here, and this file cannot read it: `main` slices
every frame at the same median-commence-time cut run_final uses and throws the
later half away before it scores anything.

Candidates, on top of the shipped `price` (linear in the logit) and the two
pricemodels members:

  pricevig    priceflex + the overround (imp_over_med + imp_under_med) and the
              book count. A wide two-way market is a less confident one, and the
              width is quoted before the game.
  priceline   priceflex + the posted number itself and its distance from the
              market's own median number. A book's bias is not constant across
              the ladder.
  priceiso    isotonic recalibration of the price instead of a parametric one.

    python harness/uplift/exp_price_members.py
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import mlbgate as G
import policy
import pricemodels

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = ["batter_hits", "batter_rbis", "totals", "spreads", "batter_total_bases",
         "batter_home_runs", "pitcher_strikeouts", "h2h", "batter_runs_scored",
         "pitcher_outs", "batter_strikeouts"]


def logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def walk_iso(z, y, t):
    """Isotonic map from the price logit to the outcome, refit forward."""
    out = np.full(len(y), np.nan)
    e = pricemodels._edges(t)
    for lo, hi in zip(e[:-1], e[1:]):
        te, tr = (t >= lo) & (t < hi), t < lo
        if te.sum() == 0 or tr.sum() < 200 or len(np.unique(y[tr])) < 2:
            continue
        m = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
        m.fit(z[tr], y[tr])
        out[te] = m.predict(z[te])
    return out


def members(c):
    d = c["frame"]
    t = pd.to_datetime(d["commenceTime"], utc=True).to_numpy("datetime64[ns]")
    y = d["overHit"].astype(int).to_numpy()
    z = logit(d["pFairOver"].to_numpy(float))
    io = d["imp_over_med"].to_numpy(float)
    iu = d["imp_under_med"].to_numpy(float)
    vig = io + iu - 1.0
    nb = d["nBooks"].to_numpy(float) if "nBooks" in d else np.zeros(len(d))
    line = d["line"].to_numpy(float)
    # distance from the market's own median number for this event-side
    med = d.groupby("eventId")["line"].transform("median").to_numpy(float)
    dO = io - G.implied_prob(d["overOdds"].to_numpy(float))
    dU = iu - G.implied_prob(d["underOdds"].to_numpy(float))

    flex = np.column_stack([z, z ** 2, np.abs(z)])
    out = dict(pricemodels.build(c))
    out["pricevig"] = pricemodels._walk(
        np.column_stack([flex, vig, np.log1p(nb), vig * z]), y, t)
    out["priceline"] = pricemodels._walk(
        np.column_stack([flex, line, line - med, np.abs(line - med)]), y, t)
    out["priceiso"] = walk_iso(z, y, t)
    out["price"] = c["probs"]["price"]
    return out, y, d["commenceTime"].to_numpy()


def score(p, y, m):
    ok = np.isfinite(p) & m
    if ok.sum() < 200:
        return None
    pp, yy = np.clip(p[ok], 1e-6, 1 - 1e-6), y[ok]
    ll = float(-(yy * np.log(pp) + (1 - yy) * np.log(1 - pp)).mean())
    b = yy.mean()
    base = float(-(b * np.log(max(b, 1e-6)) + (1 - b) * np.log(max(1 - b, 1e-6))))
    z = logit(pp)
    sl = float(np.polyfit(z, yy, 1)[0] * 0.25 * 4) if z.std() > 1e-9 else np.nan
    return dict(n=int(ok.sum()), logLoss=round(ll, 5),
                skill=round(1 - ll / base, 4), slope=round(sl, 3))


def main():
    rows = []
    for mk in ORDER:
        c = build_cache.load(mk)
        if c is None:
            continue
        mem, y, t = members(c)
        t = pd.DatetimeIndex(t)
        # SELECT HALF ONLY -- identical cut to run_final.halves()
        scored = c["frame"][np.isfinite(c["probs"]["price"])]
        cut = scored["commenceTime"].quantile(0.5)
        sel = pd.to_datetime(t, utc=True) < cut
        for name, p in mem.items():
            s = score(p, y, sel)
            if s:
                rows.append(dict(market=mk, member=name, **s))
        print(f"  {mk} done", flush=True)
    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(REPORTS, "exp_price_members.csv"), index=False)
    pd.set_option("display.width", 200)
    for mk, g in r.groupby("market", sort=False):
        g = g.sort_values("skill", ascending=False)
        print(f"\n--- {mk} (SELECT half) ---")
        print(g[["member", "n", "logLoss", "skill", "slope"]].to_string(index=False))
    print("\nbest member per market, SELECT half:")
    print(r.loc[r.groupby("market")["skill"].idxmax()][
        ["market", "member", "skill"]].to_string(index=False))


if __name__ == "__main__":
    main()
