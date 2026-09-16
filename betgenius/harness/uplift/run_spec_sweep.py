"""Choose the shipped filter ONCE, across every market at the same time.

Eleven separate per-market choices is eleven chances to fit noise. One choice,
made on total units summed over all eleven markets and never on any market's
verdict, is a single knob -- so the out-of-sample period stays a fair test of it
and no market's PASS can be an artefact of its own tuning.

The sweep reads the cache written by build_cache.py, so every spec is scored on
exactly the same walk-forward probabilities.

    python harness/uplift/run_spec_sweep.py [--lag=N] [--price=best]
"""
import itertools
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import frames
import mlbgate as G
import policy

MEMBERS = ("price", "compact", "box", "gbm", "offset", "iso")
TAUS = (0.0, 0.01, 0.02)


def specs():
    out = []
    for r in (1, 2, 3):
        for combo in itertools.combinations(MEMBERS, r):
            out.append(combo)
    return out


def score_spec(caches, spec, tau, one_per=True):
    rows = []
    for c in caches:
        g = c["frame"]
        p = np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)
        unit = policy.unit_key(c["market"]) if one_per else None
        sel = policy.board(g, p, tau=tau, one_per=unit)
        met = G.grade(sel)
        v, _ = G.verdict(met)
        rows.append(dict(market=c["market"], n=met["graded"], roi=round(met["roiPct"], 2),
                         units=round(met["units"], 1), verdict=v))
    r = pd.DataFrame(rows)
    return r, float(r["units"].sum()), int((r["verdict"] == "PASS").sum())


def main():
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")

    caches = [build_cache.load(m, lag, price) for m in frames.MARKETS]
    caches = [c for c in caches if c]
    print(f"{len(caches)} markets in cache (lag={lag}d, price={price})\n")

    rows = []
    for spec in specs():
        for tau in TAUS:
            _, units, npass = score_spec(caches, spec, tau)
            rows.append(dict(spec="+".join(spec), tau=tau, units=round(units, 1),
                             passes=npass))
    s = pd.DataFrame(rows).sort_values("units", ascending=False)
    print("every global spec, ranked by TOTAL UNITS across all markets")
    print("(the choice is made on this column; the pass count is shown but not used)")
    print(s.head(18).to_string(index=False))

    best = s.iloc[0]
    spec = tuple(best["spec"].split("+"))
    print(f"\nchosen: spec={best['spec']}  EV floor={best['tau']}  "
          f"({best['units']}u, {best['passes']} passes)")
    detail, units, npass = score_spec(caches, spec, best["tau"])
    print("\n" + detail.to_string(index=False))
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
    os.makedirs(out, exist_ok=True)
    s.to_csv(os.path.join(out, f"spec_sweep_lag{lag}_{price}.csv"), index=False)


if __name__ == "__main__":
    main()
