"""What did the new features actually buy?

The second pass added four things to the point-in-time feature set -- the park's
own run environment, the bullpen rebuilt from relief box-score lines, the
starter's pitch budget and efficiency, and the count models built on those -- and
the market verdicts moved. Two things changed at once, though: the feature set,
and the global filter that `run_final.py` re-chooses on the SELECT halves. This
script separates them.

It scores BOTH caches -- the one built before the new features and the one built
after -- through the SAME filter, so the only difference between the two columns
is the feature set. The filter it uses is whatever `run_final.py` chose on the
current cache; pass another with --spec/--tau/--conf.

    python harness/uplift/attribute.py [--spec=box+gbm+iso] [--tau=0.04] [--conf=55]

`cache_v1/` is the walk-forward cache built from the feature set as it stood in
commit 1552a97, before the park / bullpen / pitch-budget pass. It is git-ignored
like `cache/`; to rebuild it from scratch:

    git show 1552a97:betgenius/harness/uplift/features.py > /tmp/features_v1.py
    cp harness/uplift/features.py /tmp/features_v2.py
    cp /tmp/features_v1.py harness/uplift/features.py
    python harness/uplift/build_cache.py && mv harness/uplift/cache harness/uplift/cache_v1
    cp /tmp/features_v2.py harness/uplift/features.py
    python harness/uplift/build_cache.py
"""
import os
import pickle
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlbgate as G
import policy
import run_final

HERE = os.path.dirname(os.path.abspath(__file__))
OLD = os.path.join(HERE, "cache_v1")
NEW = os.path.join(HERE, "cache")


def load(cache_dir, market):
    p = os.path.join(cache_dir, f"{market}_lag0_best.pkl")
    return pickle.load(open(p, "rb")) if os.path.exists(p) else None


def score(c, spec, tau, conf, collapse, side):
    spec = tuple(s for s in spec if s in c["probs"])
    if not spec:
        return None
    p = np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)
    sel = policy.board(c["frame"], p, tau=tau, one_per=policy.unit_key(c["market"]),
                       side=side, parity=policy.parity_for(c["market"]),
                       min_conf=conf, collapse=collapse)
    met = G.grade(sel)
    v, _ = G.verdict(met)
    return met, v


def main():
    flags = dict(a.lstrip("-").split("=", 1) for a in sys.argv[1:] if a.startswith("--"))
    f = pd.read_csv(os.path.join(HERE, "reports", "final.csv"))
    spec = tuple(flags.get("spec", f["spec"].iloc[0]).split("+"))
    tau = float(flags.get("tau", f["tau"].iloc[0]))
    conf = int(flags.get("conf", f["minConf"].iloc[0]))
    collapse = flags.get("collapse", f["collapse"].iloc[0] if "collapse" in f else "maxEv")
    sides = dict(zip(f["market"], f["side"]))

    rows = []
    for m in run_final.ORDER:
        old, new = load(OLD, m), load(NEW, m)
        if old is None or new is None:
            continue
        side = sides.get(m, "both")
        side = None if side in ("both", None) or pd.isna(side) else side
        a, b = score(old, spec, tau, conf, collapse, side), score(new, spec, tau, conf, collapse, side)
        if not a or not b:
            continue
        rows.append(dict(market=m, side=side or "both",
                         oldN=a[0]["graded"], oldRoi=round(a[0]["roiPct"], 2),
                         oldUnits=round(a[0]["units"], 1), oldVerdict=a[1],
                         newN=b[0]["graded"], newRoi=round(b[0]["roiPct"], 2),
                         newUnits=round(b[0]["units"], 1), newVerdict=b[1],
                         roiDelta=round(b[0]["roiPct"] - a[0]["roiPct"], 2)))
    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(HERE, "reports", "attribution.csv"), index=False)
    print(f"same filter on both caches: spec={'+'.join(spec)}  EV floor={tau}  "
          f"conf floor={conf}  collapse={collapse}")
    print("old = features before the park / bullpen / pitch-budget pass, "
          "new = after. Side policy held at the shipped choice.\n")
    print(r.to_string(index=False))
    print(f"\nmarkets clearing the gate   old {int((r.oldVerdict == 'PASS').sum())}/{len(r)}"
          f"   new {int((r.newVerdict == 'PASS').sum())}/{len(r)}")
    print(f"units                       old {r.oldUnits.sum():.1f}   new {r.newUnits.sum():.1f}")


if __name__ == "__main__":
    main()
