"""Phase 20 -- does the edge hold across seasons, or is it a 2024 artifact?

Splits the FULL out-of-sample board by season and by the price's own lead time,
because the two are confounded in this dataset and the confound is easy to miss:

    2024-03 .. 2025-10   the warehouse entry snapshot sits ~6.0h before first pitch
    2026-04 .. 2026-05   it sits ~1.0h before

Measured with probe_entry_lead.ts, not assumed. A six-hour-old number is softer
than a one-hour-old one -- the market has had six more hours to absorb lineups,
scratches and money -- so edge measured against it is systematically larger, and
a season split that ignores this reads a pricing change as a model decay.

    python harness/uplift/season_analysis.py [--tag=_c60] [--cache=cache]
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import mlbgate as G
import policy
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_c60")
    fin = pd.read_csv(os.path.join(REPORTS, f"final{tag}.csv"))
    rows = []
    for _, f in fin.iterrows():
        m = f["market"]
        c = build_cache.load(m)
        if c is None:
            continue
        spec = tuple(str(f["spec"]).split("+"))
        p = np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)
        side = None if f["side"] == "both" else f["side"]
        sel = policy.board(c["frame"], p, tau=float(f["tau"]),
                           one_per=policy.unit_key(m), side=side,
                           parity=str(f["parity"]), min_conf=int(f["minConf"]),
                           collapse=str(f["collapse"]))
        if not len(sel):
            continue
        sel = sel.copy()
        sel["season"] = pd.to_datetime(sel["commenceTime"], utc=True).dt.year
        for season, sub in sel.groupby("season"):
            met = G.grade(sub)
            rows.append(dict(market=m, season=int(season), n=met["graded"],
                             winPct=round(met["winRatePct"], 2),
                             roi=round(met["roiPct"], 2),
                             ciLo=round(met["roiCiLoPct"], 2),
                             units=round(met["units"], 1)))
    d = pd.DataFrame(rows)
    d.to_csv(os.path.join(REPORTS, f"season_split{tag}.csv"), index=False)
    pd.set_option("display.width", 220)
    for col in ("n", "roi", "units"):
        print(f"\n--- board {col} by season ---")
        print(d.pivot_table(index="market", columns="season", values=col)
               .reindex(run_final.ORDER).round(2).to_string())
    print("\n--- pooled across all markets ---")
    g = d.groupby("season").agg(markets=("market", "size"), n=("n", "sum"),
                                units=("units", "sum"))
    g["roi"] = (100 * g.units / g.n).round(2)
    print(g.to_string())
    print(f"\n-> {os.path.join(REPORTS, f'season_split{tag}.csv')}")


if __name__ == "__main__":
    main()
