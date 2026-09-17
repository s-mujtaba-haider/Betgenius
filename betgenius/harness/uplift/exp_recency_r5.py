"""R5-05 -- temporal adaptation. Round 4 pre-registered this as E29 and never ran it.

The project measured board ROI at 1.98% / 3.15% / 0.62% across 2024 / 2025 /
2026, with the deterioration concentrated in the game markets. Either the later
period is a regime change the model should adapt to, or it is noise the model
should ignore. This asks which, on a proper scoring rule, on SELECT only.

  arm A   expanding window, uniform weight            = the incumbent `gbm`
  arm B   expanding window, recency weight, HL 365d   = `gbmW`
  arm C   rolling window, most recent 365d only       = `gbmR`

All three are already in the cache as members, fitted inside the same
walk-forward, with the same time-cut fold boundaries. Nothing here re-fits
anything; it reads three probability vectors and scores them.

PRE-REGISTERED ACCEPTANCE (fixed before the numbers existed, in
OPTIMISATION_ROUND5_PLAN.md): an arm is adopted only if it beats arm A on
held-out SELECT-B log loss by more than 0.0011 on AT LEAST 6 OF 11 markets. An
arm that wins on a minority of markets is noise and is rejected.

The verdict window is not read.

    UPLIFT_DATA_DIR=... UPLIFT_CACHE_DIR=... python harness/uplift/exp_recency_r5.py --tag=_r5
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
ARMS = {"A_expanding_uniform": "gbm", "B_expanding_recency365": "gbmW",
        "C_rolling365": "gbmR"}
MIN_MARKETS = 6


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
        missing = [k for k in ARMS.values() if k not in c["probs"]]
        if missing:
            print(f"  {m}: cache lacks {', '.join(missing)}")
            continue
        d = c["frame"]
        y = d["overHit"].astype(int).to_numpy()
        t = d["commenceTime"]
        ok = np.isfinite(c["probs"]["gbm"])
        cut = t[ok].quantile(0.5)
        for q in QUANTILES:
            sub = t[ok & (t < cut)].quantile(q)
            B = ok & (t >= sub).to_numpy() & (t < cut).to_numpy()
            if B.sum() < 200:
                continue
            base = logloss(c["probs"]["gbm"][B], y[B])
            for arm, mem in ARMS.items():
                p = c["probs"][mem]
                g = B & np.isfinite(p)
                rows.append(dict(market=m, innerCut=q, arm=arm, member=mem,
                                 nSelectB=int(g.sum()),
                                 llSelectB=round(logloss(p[g], y[g]), 6),
                                 llArmA=round(base, 6),
                                 gainOverA=round(base - logloss(p[g], y[g]), 6)))
    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(REPORTS, f"recency{tag}.csv"), index=False)

    print("\n" + "=" * 96)
    print("R5-05 temporal adaptation -- held-out SELECT-B log loss, three inner cuts")
    print("=" * 96)
    piv = r.pivot_table(index="market", columns="arm", values="llSelectB", aggfunc="mean")
    print(piv.to_string())

    print("\nadoption test: gain over arm A > %.4f at ALL three inner cuts" % NOISE)
    verdict = []
    for arm in ARMS:
        if arm.startswith("A_"):
            continue
        wins = 0
        for m in r["market"].unique():
            s = r[(r["market"] == m) & (r["arm"] == arm)]
            if len(s) and (s["gainOverA"] > NOISE).all():
                wins += 1
        n_markets = r["market"].nunique()
        ok = wins >= MIN_MARKETS
        verdict.append(dict(arm=arm, marketsBeatingA=wins, ofMarkets=n_markets,
                            required=MIN_MARKETS, ADOPTED=ok))
        print(f"  {arm:26s} beats arm A at all cuts on {wins}/{n_markets} markets"
              f"   required {MIN_MARKETS}   -> {'ADOPT' if ok else 'REJECT'}")
    pd.DataFrame(verdict).to_csv(os.path.join(REPORTS, f"recency_verdict{tag}.csv"),
                                 index=False)
    print("\nverdict window was not read.")


if __name__ == "__main__":
    main()
