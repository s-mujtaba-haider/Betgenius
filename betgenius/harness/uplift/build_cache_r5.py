"""Build ONLY the round-5 members and merge them into a copy of the round-4 cache.

The round-4 cache (`cache_fam/`) already holds the shipped six plus rf, et and
gbmB/C/D, computed on this exact dataset by this exact code. Recomputing them
would cost hours and, by construction, produce the same numbers -- so round 5
computes the six members that do not exist yet and merges them in.

    xgb   lgbm   nb   poi   gbmW   gbmR

This is only sound if the merged probability vectors are aligned to the SAME
rows in the SAME order as the ones already in the cache. That is asserted, not
assumed: the newly built frame must compare equal to the cached frame, column
for column and row for row, or the market is refused and nothing is written.

    UPLIFT_DATA_DIR=... python harness/uplift/build_cache_r5.py [market ...]
        --src=cache_fam --out=cache_r5
"""
import os
import pickle
import sys
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import features
import frames
import policy
import run_final

HERE = os.path.dirname(os.path.abspath(__file__))
NEW = ("xgb", "lgbm", "nb", "poi", "gbmW", "gbmR")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    src = next((a.split("=")[1] for a in flags if a.startswith("--src=")), "cache_fam")
    out = next((a.split("=")[1] for a in flags if a.startswith("--out=")), "cache_r5")
    src = src if os.path.isabs(src) else os.path.join(HERE, src)
    out = out if os.path.isabs(out) else os.path.join(HERE, out)
    os.makedirs(out, exist_ok=True)
    markets = args or run_final.ORDER

    box = frames.load_box()
    for m in markets:
        t0 = time.time()
        sp = os.path.join(src, f"{m}_lag0_best.pkl")
        op = os.path.join(out, f"{m}_lag0_best.pkl")
        if not os.path.exists(sp):
            print(f"  {m}: no source cache at {sp}")
            continue
        base = pickle.load(open(sp, "rb"))
        have = [k for k in NEW if k in base["probs"]]
        if len(have) == len(NEW):
            print(f"  {m}: already complete")
            continue

        c = frames.load_candidates(m, box, price="best")
        d, cols = features.build(m, c, box, lag_days=0)
        g = features.graded(d)
        probs, g = policy.walkforward(g, cols, members=NEW)

        # the alignment assertion. Without this the merge is guesswork.
        keep = [k for k in base["frame"].columns if k in g.columns]
        lhs = g[keep].reset_index(drop=True)
        rhs = base["frame"][keep].reset_index(drop=True)
        if len(lhs) != len(rhs) or not lhs.equals(rhs):
            print(f"  {m}: FRAME MISMATCH vs {src} -- refusing to merge "
                  f"({len(lhs)} vs {len(rhs)} rows)")
            continue

        merged = dict(base)
        merged["probs"] = dict(base["probs"])
        for k in NEW:
            merged["probs"][k] = probs[k]
        pickle.dump(merged, open(op, "wb"), protocol=4)
        n_ok = {k: int(np.isfinite(probs[k]).sum()) for k in NEW}
        print(f"  {m:20s} {base['graded']:7,} graded  frame verified identical  "
              f"+{len(NEW)} members {n_ok}  [{time.time() - t0:.0f}s]")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
