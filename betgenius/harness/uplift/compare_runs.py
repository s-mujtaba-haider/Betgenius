"""Regression protection: the two architectures, market by market, side by side.

A change that lifts the headline while quietly turning two stable markets into
failures is not an improvement, so every market gets a row whether it moved or
not, and the decision column says plainly what happened to it.

    python harness/uplift/compare_runs.py [--a=  --b=_v2]
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_workbook

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
RANK = {"PASS": 3, "PASS_WITH_RESTRICTIONS": 2, "FAIL_AFTER_ITERATION": 1, "VETO": 0}


def load(tag):
    f = pd.read_csv(os.path.join(REPORTS, f"final{tag}.csv"))
    f["status"] = f.apply(build_workbook.status_of, axis=1)
    rob = os.path.join(REPORTS, f"robustness{tag}.csv")
    if os.path.exists(rob):
        sets = [set(str(p).split(", ")) for p in pd.read_csv(rob)["passing"]]
        f["robustPasses"] = [sum(m in s for s in sets) for m in f["market"]]
    else:
        f["robustPasses"] = ""
    return f.set_index("market")


def main():
    ta = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--a=")), "")
    tb = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--b=")), "_v2")
    a, b = load(ta), load(tb)
    rows = []
    for m in a.index:
        if m not in b.index:
            continue
        x, y = a.loc[m], b.loc[m]
        d = RANK.get(y["status"], 0) - RANK.get(x["status"], 0)
        decision = ("improved" if d > 0 else "REGRESSED" if d < 0 else
                    "held" if y["status"] == x["status"] else "changed")
        rows.append(dict(
            market=m, oldStatus=x["status"], newStatus=y["status"],
            oldFullRoi=x["fullRoi"], newFullRoi=y["fullRoi"],
            oldFullN=x["fullN"], newFullN=y["fullN"],
            oldVerdictRoi=x["roi"], newVerdictRoi=y["roi"],
            oldVerdictN=x["n"], newVerdictN=y["n"],
            oldCiLo=x["ciLo"], newCiLo=y["ciLo"],
            oldUnits=x["units"], newUnits=y["units"],
            oldRobust=x["robustPasses"], newRobust=y["robustPasses"],
            decision=decision))
    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(REPORTS, f"compare{ta or '_v1'}_vs{tb}.csv"), index=False)
    pd.set_option("display.width", 260)
    print(r.to_string(index=False))
    print()
    for label, f in ((f"run{ta or ' (baseline)'}", a), (f"run{tb}", f := b)):
        c = f["status"].value_counts()
        print(f"{label:16s} PASS {int(c.get('PASS', 0)):2d}   "
              f"PASS_WITH_RESTRICTIONS {int(c.get('PASS_WITH_RESTRICTIONS', 0)):2d}   "
              f"VETO {int(c.get('VETO', 0)):2d}   "
              f"FAIL_AFTER_ITERATION {int(c.get('FAIL_AFTER_ITERATION', 0)):2d}   "
              f"| full-OOS gate {int((f['fullVerdict'] == 'PASS').sum()):2d}/{len(f)}"
              f"   verdict gate {int((f['verdict'] == 'PASS').sum()):2d}/{len(f)}"
              f"   verdict units {f['units'].sum():7.1f}")
    print(f"\nimproved {int((r.decision == 'improved').sum())}   "
          f"held {int((r.decision == 'held').sum())}   "
          f"REGRESSED {int((r.decision == 'REGRESSED').sum())}"
          f"   {', '.join(r[r.decision == 'REGRESSED'].market)}")
    print(f"\n-> {os.path.join(REPORTS, f'compare{ta or '_v1'}_vs{tb}.csv')}")


if __name__ == "__main__":
    main()
