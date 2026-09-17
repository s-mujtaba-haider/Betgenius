"""E26/E28 -- is the shipped `gbm` the right estimator, and is it tuned?

Judged on LOG LOSS, not on board ROI. That is deliberate and it is the lesson of
round 3: a board is a few hundred rows selected on the model's own largest
errors, so ROI on it is a noisy statistic that rewards disagreement. Log loss
uses every scored row and is a proper scoring rule -- it cannot be improved by
betting more.

The families, all on the same design matrix so the estimator is the only thing
that changes:

    gbm     HistGradientBoosting, the incumbent   (depth 3 / 8 leaves / L2 5)
    gbmB    deeper and slower                     (depth 4 / 15 leaves / L2 10)
    gbmC    shallower and faster                  (depth 2 / 4 leaves / L2 2)
    gbmD    much deeper, much more regularised     (depth 6 / 31 leaves / L2 20)
    rf      RandomForest, depth 8, leaf 200
    et      ExtraTrees, depth 8, leaf 200
    box     plain logistic on the full vector
    compact logistic on the thin vector
    offset  logistic with the price pinned at coefficient 1
    iso     logistic then isotonic recalibration
    price   the recalibrated price alone -- the baseline every family must beat

LightGBM, XGBoost and CatBoost are NOT tested: none is importable in this
environment and installing a dependency needs sign-off. `HistGradientBoosting`
is the same histogram-boosting algorithm family as LightGBM, so the untested
ground is mainly CatBoost's ordered target statistics.

Selection is made inside SELECT-A and scored on held-out SELECT-B, at three
inner cuts. The verdict window is never read.

    python harness/uplift/exp_model_families.py [--cache=cache_fam] [--tag=_e26]
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

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
QUANTILES = (0.5, 0.6, 0.7)
NOISE = 0.0011          # the band E8/E16/E19 established; smaller is not a result
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")


def logloss(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def skill(p, y):
    base = float(np.mean(y))
    b = logloss(np.full(len(y), base), y)
    return 1.0 - logloss(p, y) / b if b > 0 else np.nan


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_e26")
    rows = []
    for m in run_final.ORDER:
        c = build_cache.load(m)
        if c is None:
            print(f"  {m}: no cache"); continue
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
            for mem, p in c["probs"].items():
                p = np.asarray(p, float)
                good = np.isfinite(p)
                a, b = A & good, B & good
                if a.sum() < 500 or b.sum() < 200:
                    continue
                rows.append(dict(market=m, innerCut=q, member=mem,
                                 nA=int(a.sum()), nB=int(b.sum()),
                                 llA=round(logloss(p[a], y[a]), 6),
                                 llB=round(logloss(p[b], y[b]), 6),
                                 skillA=round(skill(p[a], y[a]), 4),
                                 skillB=round(skill(p[b], y[b]), 4)))
        print(f"  {m}: done", flush=True)
    d = pd.DataFrame(rows)
    d.to_csv(os.path.join(REPORTS, f"model_families{tag}.csv"), index=False)
    pd.set_option("display.width", 250)

    print("\n" + "=" * 110)
    print("SELECT-B log-loss SKILL by member (higher is better). Chosen on SELECT-A.")
    print("=" * 110)
    print(d.pivot_table(index="market", columns="member", values="skillB")
           .reindex(run_final.ORDER).round(4).to_string())

    print("\n--- the member each market's SELECT-A prefers, and what it scores on SELECT-B ---")
    out = []
    for (m, q), g in d.groupby(["market", "innerCut"]):
        inc = g[g.member == "gbm"]
        if inc.empty:
            continue
        pick = g.sort_values("llA").iloc[0]
        out.append(dict(market=m, innerCut=q, chosen=pick.member,
                        llB_chosen=pick.llB, llB_gbm=float(inc.llB.iloc[0]),
                        gain=round(float(inc.llB.iloc[0]) - pick.llB, 6),
                        beatsNoise=bool(float(inc.llB.iloc[0]) - pick.llB > NOISE)))
    o = pd.DataFrame(out)
    print(o.to_string(index=False))

    print("\n--- ADOPTION: a family is adopted for a market only if it is chosen on "
          "SELECT-A and beats gbm on SELECT-B by more than the noise band at ALL "
          "three cuts ---")
    adopt = []
    for m, g in o.groupby("market"):
        chosen = g.chosen.unique()
        ok = bool(g.beatsNoise.all() and len(chosen) == 1 and chosen[0] != "gbm")
        adopt.append(dict(market=m, chosen=",".join(sorted(set(g.chosen))),
                          cutsBeatingNoise=int(g.beatsNoise.sum()),
                          meanGain=round(float(g.gain.mean()), 6),
                          ADOPT=ok))
    a = pd.DataFrame(adopt).reindex(
        [i for m in run_final.ORDER
         for i in pd.DataFrame(adopt).index[pd.DataFrame(adopt).market == m]])
    print(a.to_string(index=False))
    n = int(a.ADOPT.sum())
    print(f"\nmarkets adopting a non-incumbent family: {n} / {len(a)}")
    print(f"-> {os.path.join(REPORTS, f'model_families{tag}.csv')}")


if __name__ == "__main__":
    main()
