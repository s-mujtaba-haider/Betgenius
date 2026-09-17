"""Change one thing at a time and see whether the result survives.

A number that only holds at one setting is not a result. This runs the same
locked pipeline under each variation and reports the pass count and the total
units side by side:

  placebo lag 1 / 3 / 7 days   force the freshest box score a pick may see to be
                               older. A real form signal decays slowly; a
                               same-game leak dies at the first day of lag, so a
                               flat profile here is the evidence that the as-of
                               join is clean.
  median book instead of best  bet the median price rather than the best number
                               at that line. Line shopping is the shipped
                               convention (best_price.ts), so this is the
                               no-shopping floor, not the headline.
  warm-up 15% / 12 blocks      a different walk-forward refit schedule.

    python harness/uplift/robustness.py [--v2]

`--v2` runs the same six variants through run_final_v2.py instead, writing
reports/robustness_v2.csv. The variants themselves are identical, so the two
architectures are stress-tested the same way.
"""
import os
import subprocess
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")

VARIANTS = [
    ("locked (headline)", ["--tag=_base"]),
    ("placebo lag 1d", ["--lag=1", "--tag=_lag1"]),
    ("placebo lag 3d", ["--lag=3", "--tag=_lag3"]),
    ("placebo lag 7d", ["--lag=7", "--tag=_lag7"]),
    ("median book, no line shopping", ["--price=median", "--tag=_median"]),
    ("warm-up 15%, 12 refit blocks", ["--warmup=0.15", "--blocks=12", "--tag=_w15b12"]),
]


def main():
    v2 = "--v2" in sys.argv
    r4 = "--r4" in sys.argv
    runner = "run_final_v2.py" if v2 else ("run_final_r4.py" if r4 else "run_final.py")
    # --conf=N is passed straight through to every variant, so the stress test
    # exercises the SAME rule the headline uses rather than a looser one.
    conf = next((a for a in sys.argv[1:] if a.startswith("--conf=")), None)
    suffix = ("_v2" if v2 else ("_r4" if r4 else "")) + (f"_c{conf.split('=')[1]}" if conf else "")
    rows = []
    for label, args in VARIANTS:
        tag = next(a.split("=")[1] for a in args if a.startswith("--tag=")) + suffix
        args = ([a for a in args if not a.startswith("--tag=")] + [f"--tag={tag}"]
                + ([conf] if conf else []))
        path = os.path.join(REPORTS, f"final{tag}.csv")
        if not os.path.exists(path):
            print(f"  running {label} ...")
            r = subprocess.run([sys.executable, os.path.join(HERE, runner)] + args,
                               capture_output=True, text=True)
            if not os.path.exists(path):
                print(f"  {label}: no output\n{r.stdout[-800:]}{r.stderr[-800:]}")
                continue
        f = pd.read_csv(path)
        rows.append(dict(
            variant=label,
            marketsPassFullOOS=int((f["fullVerdict"] == "PASS").sum()),
            marketsPassVerdictWindow=int((f["verdict"] == "PASS").sum()),
            markets=len(f),
            unitsFullOOS=round(f["fullUnits"].sum(), 1),
            unitsVerdictWindow=round(f["units"].sum(), 1),
            passing=", ".join(f[f["fullVerdict"] == "PASS"]["market"])))
        print(f"  {label:32s} full OOS {rows[-1]['marketsPassFullOOS']}/{len(f)}"
              f"   verdict window {rows[-1]['marketsPassVerdictWindow']}/{len(f)}")
    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(REPORTS, f"robustness{suffix}.csv"), index=False)
    print("\n" + out.drop(columns=["passing"]).to_string(index=False))
    print(f"\n-> {os.path.join(REPORTS, 'robustness.csv')}")


if __name__ == "__main__":
    main()
