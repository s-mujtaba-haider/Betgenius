"""Are the probabilities any good, not just the direction?

A board is a comparison between a probability and a price, so a model that ranks
games correctly but is half a point off in level will still bet the wrong side of
a number. This scores the calibration of every member and of the shipped
ensemble, out of sample, on the walk-forward probabilities already in the cache:

  log loss      the proper scoring rule; lower is better
  Brier         mean squared error on the outcome
  slope/intercept of the logistic recalibration (1.0 / 0.0 is perfect)
  reliability   realised win rate against predicted probability, by decile

`price` is the market's own de-vigged number recalibrated against itself, so it
is the bar every other member has to clear: a member with a worse log loss than
`price` knows less about the outcome than the book does.

    python harness/uplift/calibration.py [market ...] [--buckets=10]
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def score(y, p):
    ok = np.isfinite(p)
    y, p = y[ok], np.clip(p[ok], 1e-6, 1 - 1e-6)
    if len(y) < 50 or len(np.unique(y)) < 2:
        return None
    ll = float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
    brier = float(np.mean((p - y) ** 2))
    m = LogisticRegression(max_iter=1000, C=1e6).fit(_logit(p).reshape(-1, 1), y)
    base = float(y.mean())
    ll0 = float(-(base * np.log(base) + (1 - base) * np.log(1 - base)))
    return dict(n=int(len(y)), logLoss=round(ll, 5), brier=round(brier, 5),
                skill=round(1 - ll / ll0, 4), slope=round(float(m.coef_[0][0]), 3),
                intercept=round(float(m.intercept_[0]), 3),
                meanP=round(float(p.mean()), 4), meanY=round(base, 4))


def reliability(y, p, buckets=10):
    ok = np.isfinite(p)
    y, p = y[ok], p[ok]
    if not len(y):
        return pd.DataFrame()
    edges = np.quantile(p, np.linspace(0, 1, buckets + 1))
    edges[0], edges[-1] = -np.inf, np.inf
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, buckets - 1)
    rows = []
    for b in range(buckets):
        m = idx == b
        if m.sum() < 20:
            continue
        rows.append(dict(bucket=b + 1, n=int(m.sum()),
                         predicted=round(float(p[m].mean()), 4),
                         realised=round(float(y[m].mean()), 4),
                         gap=round(float(y[m].mean() - p[m].mean()), 4)))
    return pd.DataFrame(rows)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    buckets = int(next((a.split("=")[1] for a in sys.argv[1:]
                        if a.startswith("--buckets=")), 10))
    markets = args or run_final.ORDER
    final = pd.read_csv(os.path.join(REPORTS, "final.csv"))
    spec = tuple(final["spec"].iloc[0].split("+"))

    rows, rel = [], []
    for m in markets:
        c = build_cache.load(m)
        if c is None:
            continue
        y = c["frame"]["overHit"].astype(float).to_numpy()
        members = dict(c["probs"])
        members["ENSEMBLE(" + "+".join(spec) + ")"] = np.nanmean(
            np.vstack([c["probs"][s] for s in spec if s in c["probs"]]), axis=0)
        for name, p in members.items():
            s = score(y, np.asarray(p, float))
            if s:
                rows.append(dict(market=m, member=name, **s))
            if name.startswith("ENSEMBLE"):
                r = reliability(y, np.asarray(p, float), buckets)
                if len(r):
                    rel.append(r.assign(market=m))
    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(REPORTS, "calibration.csv"), index=False)
    rl = pd.concat(rel) if rel else pd.DataFrame()
    if len(rl):
        rl[["market", "bucket", "n", "predicted", "realised", "gap"]].to_csv(
            os.path.join(REPORTS, "calibration_reliability.csv"), index=False)

    pd.set_option("display.width", 200)
    print(out.to_string(index=False))
    print("\nslope 1.0 and intercept 0.0 is a perfectly calibrated probability; "
          "slope < 1 means the model is over-confident.")
    ens = out[out["member"].str.startswith("ENSEMBLE")]
    price = out[out["member"] == "price"].set_index("market")["logLoss"]
    beat = [m for m, ll in zip(ens["market"], ens["logLoss"])
            if m in price.index and ll < price[m]]
    print(f"\nensemble beats the market's own recalibrated price on log loss in "
          f"{len(beat)}/{len(ens)} markets: {', '.join(beat)}")


if __name__ == "__main__":
    main()
