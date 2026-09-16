#!/usr/bin/env python3
"""Copy M5 gate JSON to M6 baseline artifact and add evGateBySide from tiers."""
import json
import shutil
import sys

EV_GATE_MIN_GRADED = 500


def evaluate_side(tiers, side):
    tier = next(
        (t for t in tiers if t.get("tierLabel") == "ev_filtered" and t.get("side") == side),
        None,
    )
    if not tier:
        return {
            "pass": False,
            "graded": 0,
            "roiPct": 0,
            "roiCiLoPct": 0,
            "roiCiHiPct": 0,
            "avgClvPct": None,
            "pctPositiveClvPct": None,
            "clvN": 0,
            "bonusClvPositive": False,
            "reason": f"ev_filtered/{side} tier not found",
        }
    bonus = tier.get("avgClvPct") is not None and tier["avgClvPct"] > 0
    graded = tier.get("graded", 0)
    if graded == 0:
        return {
            "pass": False,
            "graded": 0,
            "roiPct": tier.get("roiPct", 0),
            "roiCiLoPct": tier.get("roiCiLoPct", 0),
            "roiCiHiPct": tier.get("roiCiHiPct", 0),
            "avgClvPct": tier.get("avgClvPct"),
            "pctPositiveClvPct": tier.get("pctPositiveClvPct"),
            "clvN": tier.get("clvN", 0),
            "bonusClvPositive": bonus,
            "reason": "no graded picks in ev_filtered slice",
        }
    passed = tier["roiPct"] > 0 if graded >= EV_GATE_MIN_GRADED else tier["roiCiLoPct"] > 0
    if graded >= EV_GATE_MIN_GRADED:
        base = (
            f"graded n={graded} >= {EV_GATE_MIN_GRADED} and ROI {tier['roiPct']:.2f}% > 0%"
            if passed
            else f"graded n={graded} >= {EV_GATE_MIN_GRADED} but ROI {tier['roiPct']:.2f}% <= 0%"
        )
    else:
        base = (
            f"graded n={graded} < {EV_GATE_MIN_GRADED} but ROI CI lower bound {tier['roiCiLoPct']:.2f}% > 0%"
            if passed
            else f"graded n={graded} < {EV_GATE_MIN_GRADED} and ROI CI lower bound {tier['roiCiLoPct']:.2f}% <= 0%"
        )
    reason = base if side == "all" else f"{side}-only: {base}"
    return {
        "pass": passed,
        "graded": graded,
        "roiPct": tier["roiPct"],
        "roiCiLoPct": tier["roiCiLoPct"],
        "roiCiHiPct": tier["roiCiHiPct"],
        "avgClvPct": tier.get("avgClvPct"),
        "pctPositiveClvPct": tier.get("pctPositiveClvPct"),
        "clvN": tier.get("clvN", 0),
        "bonusClvPositive": bonus,
        "reason": reason,
    }


def augment(src, dst):
    with open(src) as f:
        data = json.load(f)
    tiers = data.get("tiers", [])
    data["evGateBySide"] = {
        "all": evaluate_side(tiers, "all"),
        "over": evaluate_side(tiers, "over"),
        "under": evaluate_side(tiers, "under"),
    }
    data["evGate"] = data["evGateBySide"]["all"]
    with open(dst, "w") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {dst}")


if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2]
    augment(src, dst)
