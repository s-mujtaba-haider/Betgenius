"""E19: two FEATURE SETS, same rule, same windows, scored on held-out SELECT-B.

The only thing that differs between the two arms is what the members were fitted
on. The selection rule is re-derived from SELECT-A independently inside each arm
-- because a feature set that needs a different filter is still a feature set,
and holding the filter fixed at the incumbent's choice would repeat exactly the
mistake round 2 found in run_final_v2's own nested check.

The confidence floor is pinned at 60 in both arms, as the production contract
requires; it is not a knob here.

The verdict window is never read. Cuts come from the BASELINE cache and are
applied unchanged to both arms, so the two are scored over identical windows.

    python harness/uplift/exp_featureset.py --a=cache --b=cache_h [--tag=_hands]
"""
import os
import pickle
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boardfast
import exp_nested_rules as NR
import policy
import pricemodels
import run_final
import run_final_v2 as v2

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")


def load_dir(d, markets):
    out = []
    for m in markets:
        p = os.path.join(HERE, d, f"{m}_lag0_best.pkl")
        if not os.path.exists(p):
            continue
        c = pickle.load(open(p, "rb"))
        c["probs"] = dict(c["probs"])
        c["probs"].update(pricemodels.build(c))
        out.append(c)
    return out


def run_arm(caches, cuts, label, rows):
    """The _c60 rule, re-derived on SELECT-A, scored on SELECT-B."""
    _fc = {}

    def fast(c, spec, collapse):
        k = (spec, collapse)
        if _fc.get("key") != k:
            _fc.clear()
            _fc["key"] = k
        if c["market"] not in _fc:
            _fc[c["market"]] = boardfast.Fast(c, v2.prob(c, spec), collapse)
        return _fc[c["market"]]

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
            rows.append(dict(arm=label, innerCut=q, market=m, spec="+".join(spec),
                             tau=tau, minConf=conf, collapse=col, side=side or "both",
                             n=s["n"], roi=round(s["roi"], 2) if s["n"] else np.nan,
                             units=round(s["units"], 1)))
        print(f"  [{label}] cut {q}: {'+'.join(spec)} tau{tau} conf{conf} {col}",
              flush=True)


def main():
    a = next((x.split("=")[1] for x in sys.argv[1:] if x.startswith("--a=")), "cache")
    b = next((x.split("=")[1] for x in sys.argv[1:] if x.startswith("--b=")), "cache_h")
    tag = next((x.split("=")[1] for x in sys.argv[1:] if x.startswith("--tag=")), "_hands")
    ca, cb = load_dir(a, v2.ORDER), load_dir(b, v2.ORDER)
    have = sorted({c["market"] for c in ca} & {c["market"] for c in cb})
    ca = [c for c in ca if c["market"] in have]
    cb = [c for c in cb if c["market"] in have]
    print(f"{len(have)} markets in both caches: {', '.join(have)}")

    # the two arms must be the same rows in the same order, or they are not
    # comparable and neither is the cut
    for x, y in zip(ca, cb):
        assert x["market"] == y["market"]
        if len(x["frame"]) != len(y["frame"]):
            raise AssertionError(f"{x['market']}: {len(x['frame'])} vs {len(y['frame'])} rows")
        if not (x["frame"]["game_pk"].to_numpy() == y["frame"]["game_pk"].to_numpy()).all():
            raise AssertionError(f"{x['market']}: frames are not row-aligned")
    print("  both arms are row-aligned on every market")
    print(f"  extra columns in {b}: "
          f"{sorted(set(cb[0]['cols']) - set(ca[0]['cols']))}")

    cuts = {c["market"]: v2.halves(c) for c in ca}      # baseline cuts, both arms
    boardfast.selfcheck(ca, lambda c: v2.prob(c, ("price", "gbm", "iso")), quiet=False)

    rows = []
    run_arm(ca, cuts, f"A:{a}", rows)
    run_arm(cb, cuts, f"B:{b}", rows)
    d = pd.DataFrame(rows)
    d.to_csv(os.path.join(REPORTS, f"featureset{tag}.csv"), index=False)

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
    print("\n--- the four currently-strong markets only (regression guard) ---")
    print(st.to_string())
    print(f"\n-> {os.path.join(REPORTS, f'featureset{tag}.csv')}")


if __name__ == "__main__":
    main()
