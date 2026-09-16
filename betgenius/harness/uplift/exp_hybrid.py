"""E20: does adding the price-anchored hybrid member to the pool survive?

Two arms, identical in everything except which members the global search may
choose from:

    A   the incumbent pool: price, compact, box, gbm, offset, iso
    B   the same pool plus ONE member, hyb_gbm

Only one member is added, deliberately. E16's lesson was that widening a search
without adding information is pure overfit risk, so the pool grows by the single
member that tests the hypothesis and by nothing else.

In both arms the rule -- spec, EV floor, ladder collapse, side -- is re-derived
from SELECT-A alone and scored on the held-out SELECT-B tail, at three inner
cuts. The confidence floor is pinned at 60 in both arms; it is the production
contract, not a knob. The verdict window is never read.

    python harness/uplift/exp_hybrid.py [--tag=_hybrid]
"""
import itertools
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boardfast
import build_cache
import exp_nested_rules as NR
import hybrid
import policy
import run_final
import run_final_v2 as v2

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")
POOL_A = run_final.MEMBERS
POOL_B = run_final.MEMBERS + ("hyb_gbm",)


def specs_of(pool):
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(pool, r))
    return out


def run_arm(caches, cuts, pool, label, rows, anchored=False):
    """anchored=True wraps the WHOLE ensemble in the price anchor: the search
    then chooses what goes inside it, not whether to use it."""
    _fc = {}

    def probs_of(c, spec):
        p = v2.prob(c, spec)
        return hybrid.blend_arrays(c, p) if anchored else p

    def fast(c, spec, collapse):
        k = (spec, collapse)
        if _fc.get("key") != k:
            _fc.clear()
            _fc["key"] = k
        if c["market"] not in _fc:
            _fc[c["market"]] = boardfast.Fast(c, probs_of(c, spec), collapse)
        return _fc[c["market"]]

    # NR.choose_baseline walks run_final.MEMBERS via base_specs(); swap in this
    # arm's pool for the duration, then put it back.
    old = NR.base_specs
    NR.base_specs = lambda: specs_of(pool)
    try:
        for q in v2.NESTED_QUANTILES:
            sub = {}
            for c in caches:
                t = c["frame"]["commenceTime"]
                t = t[np.isfinite(c["probs"]["price"]) & (t < cuts[c["market"]])]
                sub[c["market"]] = t.quantile(q)
            spec, tau, conf, col = NR.choose_baseline(caches, sub, fast, False, (60,))
            for c in caches:
                m = c["market"]
                f = fast(c, spec, col)
                side = NR.side_baseline(c, f, tau, conf, sub[m], False)
                s = f.score(f.board_mask(tau, side, conf, policy.parity_for(m)),
                            sub[m], cuts[m])
                rows.append(dict(arm=label, innerCut=q, market=m,
                                 spec="+".join(spec), tau=tau, minConf=conf,
                                 collapse=col, side=side or "both", n=s["n"],
                                 roi=round(s["roi"], 2) if s["n"] else np.nan,
                                 units=round(s["units"], 1)))
            print(f"  [{label}] cut {q}: {'+'.join(spec)} tau{tau} conf{conf} {col}",
                  flush=True)
    finally:
        NR.base_specs = old


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_hybrid")
    caches = [build_cache.load(m) for m in v2.ORDER]
    caches = [c for c in caches if c]
    print(f"{len(caches)} markets")
    for c in caches:
        c["probs"] = dict(c["probs"])
        c["probs"]["hyb_gbm"] = hybrid.blend(c, model="gbm")
    cuts = {c["market"]: v2.halves(c) for c in caches}
    boardfast.selfcheck(caches, lambda c: v2.prob(c, ("price", "gbm", "iso")), quiet=False)

    rows = []
    run_arm(caches, cuts, POOL_A, "A:incumbent", rows)
    if "--anchored-only" not in sys.argv:
        run_arm(caches, cuts, POOL_B, "B:+hyb_gbm", rows)
    run_arm(caches, cuts, POOL_A, "C:anchored", rows, anchored=True)
    d = pd.DataFrame(rows)
    d.to_csv(os.path.join(REPORTS, f"hybrid{tag}.csv"), index=False)

    pd.set_option("display.width", 240)
    print("\n--- held-out SELECT-B ROI %, rule re-derived on SELECT-A in each arm ---")
    print(d.pivot_table(index="market", columns=["arm", "innerCut"],
                        values="roi").round(2).to_string())
    g = d.dropna(subset=["roi"]).groupby("arm").agg(
        splits=("market", "size"), inProfit=("roi", lambda s: int((s > 0).sum())),
        heldOutN=("n", "sum"), heldOutUnits=("units", "sum"),
        medianRoi=("roi", "median"))
    print("\n--- pooled ---")
    print(g.to_string())
    st = d[d.market.isin(STRONG)].dropna(subset=["roi"]).groupby("arm").agg(
        splits=("market", "size"), inProfit=("roi", lambda s: int((s > 0).sum())),
        units=("units", "sum"), medianRoi=("roi", "median"))
    print("\n--- the four strong markets only (regression guard) ---")
    print(st.to_string())
    print("\n--- specs chosen ---")
    print(d.drop_duplicates(["arm", "innerCut"])[
        ["arm", "innerCut", "spec", "tau", "collapse"]].to_string(index=False))
    print(f"\n-> {os.path.join(REPORTS, f'hybrid{tag}.csv')}")


if __name__ == "__main__":
    main()
