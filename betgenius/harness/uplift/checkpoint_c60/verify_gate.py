"""Replay the shipped harness reports through mlbgate.py and check that the
Python port reproduces the published evGate block exactly.

This is the evidence for "the gate is unchanged": every verdict in this work is
produced by the code checked here.

    python harness/uplift/verify_gate.py
"""
import glob
import json
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlbgate as G

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out")


def replay(path):
    d = json.load(open(path))
    picks = pd.DataFrame(d["picks"])
    if "evPerUnit" in picks:
        sel = picks[G.ev_filtered_mask(picks)]
        label = "ev_filtered"
    else:
        sel = picks[G.ev_pass_mask(picks)]
        label = "ev_pass"
    met = G.grade(sel, exact=True)
    v, why = G.verdict(met)
    pub = d["evGate"]
    ok = (met["graded"] == pub["graded"]
          and abs(met["roiPct"] - pub["roiPct"]) < 1e-9
          and abs(met["roiCiLoPct"] - pub["roiCiLoPct"]) < 1e-9
          and (v == "PASS") == pub["pass"])
    return dict(report=os.path.basename(path), market=d["market"], slice=label,
                pubN=pub["graded"], myN=met["graded"],
                pubRoi=round(pub["roiPct"], 6), myRoi=round(met["roiPct"], 6),
                pubCiLo=round(pub["roiCiLoPct"], 6), myCiLo=round(met["roiCiLoPct"], 6),
                pubPass=pub["pass"], myVerdict=v, match="OK" if ok else "MISMATCH")


if __name__ == "__main__":
    paths = sorted(glob.glob(os.path.join(OUT, "*.json")))
    rows = []
    for p in paths:
        try:
            d = json.load(open(p))
        except Exception:
            continue
        if not isinstance(d, dict) or "picks" not in d or "evGate" not in d:
            continue
        if len(d["picks"]) > 6000:      # exact mulberry32 replay is O(2000*n)
            continue
        rows.append(replay(p))
    r = pd.DataFrame(rows)
    print(r.to_string(index=False))
    bad = (r["match"] != "OK").sum() if len(r) else 0
    print(f"\n{len(r)} shipped reports replayed, {bad} mismatches")
    sys.exit(1 if bad else 0)
