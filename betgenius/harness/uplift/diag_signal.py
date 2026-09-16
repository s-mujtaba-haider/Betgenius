"""Does anything here know something the price does not?

For each market, fit

    logit P(over) = a + b1 * logit(fair price) + b2 * z(signal)

on the whole graded universe and report b2. The price is in the model, so b2 is
the signal's contribution AFTER the market has had its say. b2 ~ 0 means the
signal is already in the number and no filter built on it can win; b2 far from 0
with a small p-value means there is something left to bet on.

This is a diagnostic, not a backtest: it is fit in-sample on purpose, because a
signal that cannot clear this bar in-sample will certainly not clear a
walk-forward gate. Everything that survives here is then re-measured out of
sample by run_markets.py.

    python harness/uplift/diag_signal.py [market ...]
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features
import frames

SIGNALS = ["empP", "parP", "parPAdj", "clrEdge25", "clrEdge100", "oppAllowRel", "expMargin"]


def z(v):
    v = np.asarray(v, float)
    m = np.nanmean(v)
    s = np.nanstd(v)
    return np.nan_to_num((v - m) / (s if s > 1e-12 else 1.0))


def analyse(market, box):
    c = frames.load_candidates(market, box)
    d, cols = features.build(market, c, box)
    g = features.graded(d)
    if len(g) < 300:
        return []
    y = g["overHit"].astype(int).to_numpy()
    p = z(g["pLogit"])
    rows = []
    for s in SIGNALS:
        if s not in g:
            continue
        x = z(g[s])
        if np.nanstd(x) < 1e-9:
            continue
        X = np.column_stack([p, x])
        m = LogisticRegression(max_iter=2000, C=1e6).fit(X, y)
        b = float(m.coef_[0][1])
        # Wald se from the observed information matrix
        pr = m.predict_proba(X)[:, 1]
        Xd = np.column_stack([np.ones(len(X)), X])
        w = pr * (1 - pr)
        cov = np.linalg.pinv(Xd.T @ (Xd * w[:, None]))
        se = float(np.sqrt(cov[2, 2]))
        rows.append(dict(market=market, n=len(g), signal=s, beta=round(b, 4),
                         se=round(se, 4), zstat=round(b / se, 2) if se else np.nan))
    return rows


if __name__ == "__main__":
    want = sys.argv[1:] or [m for m in frames.MARKETS
                            if frames.market_files(m)]
    box = frames.load_box()
    out = []
    for m in want:
        try:
            out.extend(analyse(m, box))
        except Exception as e:                                    # noqa: BLE001
            print(f"  {m}: {type(e).__name__}: {e}", file=sys.stderr)
    r = pd.DataFrame(out)
    r.to_csv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports",
                          "diag_signal.csv"), index=False)
    print(r.pivot(index="market", columns="signal", values="beta").to_string())
    print("\nz-statistics (|z| > 3 is signal the price has not absorbed)")
    print(r.pivot(index="market", columns="signal", values="zstat").to_string())
