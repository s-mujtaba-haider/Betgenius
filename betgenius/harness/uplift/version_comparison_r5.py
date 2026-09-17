"""reports/version_comparison_r5.csv -- C60 vs Round 4 vs Round 5, market by market.

A technical comparison, not a ranking. The three runs differ on more than one
axis at once -- C60 runs on the original `data/`, rounds 4 and 5 on the
entry-time-corrected `data_expanded_6h/` -- so a market that moves between them
may be moving because of the data, the architecture, or both. The columns are
laid out so that is visible rather than hidden behind a single verdict.

Robustness is read per market from the six variant runs of each version, not
from the variant summary, so the x/6 in this file is that market's own count.

    python harness/uplift/version_comparison_r5.py
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_workbook

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")

# (label, final csv, dataset, the six robustness tags for that version)
VERSIONS = [
    ("C60", "final_c60.csv", "data/ (original, mixed entry convention)",
     ["_base_c60", "_lag1_c60", "_lag3_c60", "_lag7_c60", "_median_c60", "_w15b12_c60"]),
    ("Round4", "final_r4v.csv", "data_expanded_6h/ (T-6h)",
     ["_base_r4_c60", "_lag1_r4_c60", "_lag3_r4_c60", "_lag7_r4_c60",
      "_median_r4_c60", "_w15b12_r4_c60"]),
    ("Round5", "final_r5.csv", "data_expanded_6h/ (T-6h)",
     ["_base_r5_c60", "_lag1_r5_c60", "_lag3_r5_c60", "_lag7_r5_c60",
      "_median_r5_c60", "_w15b12_r5_c60"]),
]


def robustness_per_market(tags):
    """How many of the six variants this market passes the FULL-OOS gate in."""
    hit, seen = {}, 0
    for t in tags:
        p = os.path.join(REPORTS, f"final{t}.csv")
        if not os.path.exists(p):
            continue
        seen += 1
        f = pd.read_csv(p)
        for _, r in f.iterrows():
            hit[r["market"]] = hit.get(r["market"], 0) + int(r["fullVerdict"] == "PASS")
    return hit, seen


def main():
    rows = []
    for label, fname, dataset, tags in VERSIONS:
        p = os.path.join(REPORTS, fname)
        if not os.path.exists(p):
            print(f"  {label}: {fname} missing -- skipped")
            continue
        f = pd.read_csv(p)
        rob, nvar = robustness_per_market(tags)
        for _, r in f.iterrows():
            status = build_workbook.status_of(r)
            rows.append(dict(
                market=r["market"], version=label, dataset=dataset,
                model=r.get("spec", ""),
                override=r.get("override", "") if "override" in f.columns else "",
                globalSpec=r.get("globalSpec", r.get("spec", "")),
                side=r["side"], evFloor=r["tau"], confFloor=r["minConf"],
                gradedRows=r["graded"], games=r["events"],
                fullOosN=r["fullN"], fullOosRoi=r["fullRoi"], fullOosCiLo=r["fullCiLo"],
                fullOosGate=r["fullVerdict"],
                verdictFrom=r["verdictFrom"], verdictN=r["n"], verdictRoi=r["roi"],
                verdictCiLo=r["ciLo"], verdictClusCiLo=r["clusCiLo"],
                verdictGate=r["verdict"],
                robustnessVariantsPassed=rob.get(r["market"], None),
                robustnessVariantsRun=nvar,
                finalStatus=status))
        print(f"  {label:8s} {len(f)} markets   "
              f"both-gates PASS {int(((f['verdict'] == 'PASS') & (f['fullVerdict'] == 'PASS')).sum())}"
              f"/{len(f)}   robustness variants found {nvar}/6")
    out = pd.DataFrame(rows)
    order = {m: i for i, m in enumerate(out["market"].unique())}
    out = out.sort_values(["market", "version"],
                          key=lambda s: s.map(order) if s.name == "market" else s)
    out.to_csv(os.path.join(REPORTS, "version_comparison_r5.csv"), index=False)
    print(f"\n-> {os.path.join(REPORTS, 'version_comparison_r5.csv')}  ({len(out)} rows)")
    print("\nThis is a technical comparison. No ranking is implied, and the three "
          "versions do not differ on one axis alone.")


if __name__ == "__main__":
    main()
