"""THE round-5 result: round 4's architecture, with four new members offered to it.

This file adds NOTHING to the method. It is `run_final_r4.py` -- the same global
filter chosen on SELECT-A, the same per-market member override under the same
three guards, the same gate, the same confidence floor of 60, the same verdict
window opened once at the end -- with exactly one change:

    the members an override may resolve to now include the four candidates
    round 5 pre-registered.

        xgb   XGBoost                       R5-01
        lgbm  LightGBM                      R5-02
        nb    negative binomial, direct     R5-03
        poi   Poisson, direct               R5-03

`run_final_r4.py` is not edited. Round 4's result reproduces from it unchanged,
which is the point of Part 37: a new round may not destroy the baseline it is
measured against.

Why the pool is widened by four and not by more
-----------------------------------------------
E33 tested widening the override pool from 11 single members to 66 one- and
two-member averages, and it made the result WORSE (both-gates 6 -> 4) for the
reason E16 predicted: widening a pool without adding information is pure overfit
risk. So round 5 adds only members that carry information the pool did not
already have -- two model families that were not installable before, and two
count-model probabilities that existed only as one column among forty-six. It
does NOT re-open pairs, and it does NOT add gbmW/gbmR, which belong to R5-05 and
are judged by R5-05's own criterion in `exp_recency_r5.py`.

    UPLIFT_DATA_DIR=... UPLIFT_CACHE_DIR=... python harness/uplift/run_final_r5.py --conf=60 --tag=_r5
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_final_r4

# The round-4 pool, plus the four round-5 candidates. Order is fixed and
# alphabetical within the addition so the candidate list is deterministic.
run_final_r4.OVERRIDE_POOL = run_final_r4.OVERRIDE_POOL + ("xgb", "lgbm", "nb", "poi")

if __name__ == "__main__":
    if not any(a.startswith("--tag=") for a in sys.argv[1:]):
        sys.argv.append("--tag=_r5")
    print(f"round-5 override pool ({len(run_final_r4.OVERRIDE_POOL)} members): "
          f"{', '.join(run_final_r4.OVERRIDE_POOL)}\n")
    run_final_r4.main()
