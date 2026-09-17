"""Round 5's answer to the branch's `multi_model_comparison.py`, done honestly.

The `3-pass-markets` branch ran 6 model families across 8 markets, found that 6
of 48 combinations "technically clear the gate", and correctly declined to treat
that as a result -- no two models agreed and every passing CI still spanned zero.

This does the same comparison on this project's data, with two differences that
matter:

  * every model is scored on **log loss on held-out SELECT-B**, a proper scoring
    rule over every row, instead of on board ROI over the few hundred rows the
    model selected using its own largest errors. A model cannot win here by
    disagreeing with the price more loudly;
  * nothing is selected. This file reports. Selection happens once, in
    `run_final_r5.py`, under the three guards, and the verdict window is not
    read by either.

It writes reports/model_comparison_r5.csv: one row per (market, member, inner
cut), with the incumbent global spec alongside for reference.

    UPLIFT_DATA_DIR=... UPLIFT_CACHE_DIR=... python harness/uplift/exp_model_comparison_r5.py --tag=_r5
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import run_final

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
QUANTILES = (0.5, 0.6, 0.7)
NOISE = 0.0011

FAMILY = {
    "price": "logistic on the de-vigged price alone",
    "box": "logistic on the full feature vector",
    "compact": "logistic on the compact vector",
    "offset": "logistic with the price as a fixed offset",
    "iso": "logistic + isotonic recalibration",
    "gbm": "HistGradientBoosting (incumbent)",
    "gbmB": "HistGradientBoosting, deeper",
    "gbmC": "HistGradientBoosting, shallower",
    "gbmD": "HistGradientBoosting, deepest",
    "gbmW": "HistGradientBoosting, recency-weighted (R5-05 arm B)",
    "gbmR": "HistGradientBoosting, rolling 365d (R5-05 arm C)",
    "rf": "RandomForest",
    "et": "ExtraTrees",
    "xgb": "XGBoost (R5-01, NEW)",
    "lgbm": "LightGBM (R5-02, NEW)",
    "nb": "negative binomial count model, direct (R5-03, NEW)",
    "poi": "Poisson count model, direct (R5-03, NEW)",
}


def logloss(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_r5")
    rows = []
    for m in run_final.ORDER:
        c = build_cache.load(m, 0, "best")
        if c is None:
            print(f"  {m}: not in cache")
            continue
        d = c["frame"]
        y = d["overHit"].astype(int).to_numpy()
        t = d["commenceTime"]
        ok = np.isfinite(c["probs"]["price"])
        cut = t[ok].quantile(0.5)
        for q in QUANTILES:
            sub = t[ok & (t < cut)].quantile(q)
            A = ok & (t < sub).to_numpy()
            B = ok & (t >= sub).to_numpy() & (t < cut).to_numpy()
            if A.sum() < 500 or B.sum() < 200:
                continue
            base = c["probs"].get("gbm")
            gb = B & np.isfinite(base) if base is not None else None
            llBase = logloss(base[gb], y[gb]) if base is not None else np.nan
            for mem, p in sorted(c["probs"].items()):
                a, b = A & np.isfinite(p), B & np.isfinite(p)
                if a.sum() < 500 or b.sum() < 200:
                    rows.append(dict(market=m, innerCut=q, member=mem,
                                     family=FAMILY.get(mem, mem), nSelectA=int(a.sum()),
                                     nSelectB=int(b.sum()), llSelectA=np.nan,
                                     llSelectB=np.nan, llGlobalGbm=round(llBase, 6),
                                     gainOverGbm=np.nan,
                                     beatsNoiseBand=False,
                                     note="too few rows at this cut"))
                    continue
                llA, llB = logloss(p[a], y[a]), logloss(p[b], y[b])
                rows.append(dict(market=m, innerCut=q, member=mem,
                                 family=FAMILY.get(mem, mem), nSelectA=int(a.sum()),
                                 nSelectB=int(b.sum()), llSelectA=round(llA, 6),
                                 llSelectB=round(llB, 6), llGlobalGbm=round(llBase, 6),
                                 gainOverGbm=round(llBase - llB, 6),
                                 beatsNoiseBand=bool(llBase - llB > NOISE), note=""))
        print(f"  {m:20s} {len(c['probs'])} members scored")
        sys.stdout.flush()

    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(REPORTS, f"model_comparison{tag}.csv"), index=False)

    print("\n" + "=" * 110)
    print("MEAN HELD-OUT SELECT-B LOG LOSS BY MARKET AND MEMBER (lower is better)."
          "  Reported, not selected on.")
    print("=" * 110)
    piv = r.pivot_table(index="member", columns="market", values="llSelectB",
                        aggfunc="mean")
    print(piv.round(5).to_string())

    print("\n" + "=" * 110)
    print("HOW OFTEN EACH MEMBER BEATS THE GLOBAL gbm BY MORE THAN THE NOISE BAND"
          f" ({NOISE}), at ALL THREE inner cuts")
    print("=" * 110)
    summ = []
    for mem in sorted(r["member"].unique()):
        s = r[r["member"] == mem]
        wins = 0
        for m in s["market"].unique():
            cell = s[s["market"] == m]
            if len(cell) == len(QUANTILES) and cell["beatsNoiseBand"].all():
                wins += 1
        summ.append(dict(member=mem, family=FAMILY.get(mem, mem),
                         marketsBeatingGbmAtAllCuts=wins,
                         ofMarkets=int(s["market"].nunique()),
                         meanLlSelectB=round(float(s["llSelectB"].mean()), 6)))
    sm = pd.DataFrame(summ).sort_values("marketsBeatingGbmAtAllCuts", ascending=False)
    print(sm.to_string(index=False))
    sm.to_csv(os.path.join(REPORTS, f"model_comparison_summary{tag}.csv"), index=False)
    print("\nverdict window was not read.")


if __name__ == "__main__":
    main()
