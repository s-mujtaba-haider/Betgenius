"""The one authoritative final table, and the counts that go with it.

Everything a report says about the eleven markets is read from here, so no
document can drift from the run that produced it. The status logic is the
project's own, unchanged, and lives in `build_workbook.status_of`:

    Gate (full OOS) PASS  and  Gate (verdict window) PASS  ->  PASS
    exactly one of the two PASS                            ->  PASS_WITH_RESTRICTIONS
    neither, and the market's flat-bet ROI is below -12%    ->  VETO
    neither, otherwise                                      ->  FAIL_AFTER_ITERATION

The two gates are the same gate (n >= 500 and ROI > 0, else the 95% CI lower
bound must clear zero) applied to two different windows. See the documentation
for what each window is and why they disagree.

    python harness/uplift/final_matrix.py [--tag=_v2]

`--tag` selects which run to tabulate: the default reads reports/final.csv, and
`--tag=_v2` reads reports/final_v2.csv. The table is built the same way either
way, so the two architectures are compared on identically-computed numbers.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_workbook

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")

COLS = [
    ("market", "Market"), ("candidates", "Priced candidates"), ("graded", "Graded"),
    ("events", "Games"), ("fromDate", "From"), ("toDate", "To"),
    ("side", "Side policy"), ("baseRoi", "Flat-bet ROI %"),
    ("priceOnlyRoi", "Price-recalibration ROI %"),
    ("fullN", "Full OOS board n"), ("fullRoi", "Full OOS board ROI %"),
    ("fullCiLo", "Full OOS ROI 95% CI low"), ("fullUnits", "Full OOS units"),
    ("fullVerdict", "Gate (full OOS)"),
    ("verdictFrom", "Verdict window from"), ("n", "Verdict board n"),
    ("winPct", "Verdict win %"), ("roi", "Verdict ROI %"),
    ("ciLo", "Verdict ROI 95% CI low"), ("clusCiLo", "Verdict game-clustered CI low"),
    ("units", "Verdict units"), ("verdict", "Gate (verdict window)"),
    ("robustPasses", "Robustness variants passed (of 6)"),
    ("status", "Final status"),
]


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "")
    f = pd.read_csv(os.path.join(REPORTS, f"final{tag}.csv"))
    f["status"] = f.apply(build_workbook.status_of, axis=1)

    rob_path = os.path.join(REPORTS, f"robustness{tag}.csv")
    if os.path.exists(rob_path):
        rob = pd.read_csv(rob_path)
        sets = [set(str(p).split(", ")) for p in rob["passing"]]
        f["robustPasses"] = [sum(m in s for s in sets) for m in f["market"]]
    else:
        f["robustPasses"] = ""

    out = f[[c for c, _ in COLS]].rename(columns=dict(COLS))
    out.to_csv(os.path.join(REPORTS, f"final_matrix{tag}.csv"), index=False)

    pd.set_option("display.width", 250)
    print(out.to_string(index=False))
    print()
    counts = f["status"].value_counts()
    print(f"markets evaluated            {len(f)}")
    print(f"Gate (full OOS) PASS         {int((f.fullVerdict == 'PASS').sum())}"
          f"   {', '.join(f[f.fullVerdict == 'PASS'].market)}")
    print(f"Gate (verdict window) PASS   {int((f.verdict == 'PASS').sum())}"
          f"   {', '.join(f[f.verdict == 'PASS'].market)}")
    for s in ("PASS", "PASS_WITH_RESTRICTIONS", "VETO", "FAIL_AFTER_ITERATION"):
        names = ", ".join(f[f.status == s].market)
        print(f"final {s:24s} {int(counts.get(s, 0))}   {names}")
    print(f"\nunits, full OOS {f.fullUnits.sum():.1f}   "
          f"units, verdict window {f.units.sum():.1f}")
    print(f"total graded candidates {int(f.graded.sum()):,}   "
          f"priced candidates {int(f.candidates.sum()):,}")
    print(f"evaluation period {f.fromDate.min()} -> {f.toDate.max()}")
    print(f"\n-> {os.path.join(REPORTS, 'final_matrix.csv')}")


if __name__ == "__main__":
    main()
