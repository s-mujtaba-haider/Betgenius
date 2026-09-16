#!/usr/bin/env python3
"""Extract M6 ev_gate / side-gate metrics from harness JSON outputs."""
import json
import glob
import os
import sys


def tier_find(tiers, label, side="all"):
    for t in tiers:
        if t.get("tierLabel") == label and t.get("side") == side:
            return t
    return None


def gate_summary(gate, label):
    if not gate:
        return {f"{label}_pass": None}
    return {
        f"{label}_pass": gate.get("pass"),
        f"{label}_graded": gate.get("graded"),
        f"{label}_roi_pct": gate.get("roiPct"),
        f"{label}_reason": gate.get("reason"),
    }


def summarize(path):
    with open(path) as f:
        d = json.load(f)
    side = d.get("evGateBySide") or {}
    ef_all = tier_find(d.get("tiers", []), "ev_filtered", "all")
    ef_over = tier_find(d.get("tiers", []), "ev_filtered", "over")
    ef_under = tier_find(d.get("tiers", []), "ev_filtered", "under")
    out = {
        "file": os.path.basename(path),
        "market": d.get("market"),
        "source": d.get("dataSource"),
        "window": f"{d.get('windowStartIso', '')}..{d.get('windowEndIso', '')}",
        "all_graded": ef_all.get("graded") if ef_all else None,
        "all_roi_pct": ef_all.get("roiPct") if ef_all else None,
        "over_graded": ef_over.get("graded") if ef_over else None,
        "over_roi_pct": ef_over.get("roiPct") if ef_over else None,
        "under_graded": ef_under.get("graded") if ef_under else None,
        "under_roi_pct": ef_under.get("roiPct") if ef_under else None,
    }
    out.update(gate_summary(d.get("evGate"), "all"))
    out.update(gate_summary(side.get("over"), "over"))
    out.update(gate_summary(side.get("under"), "under"))
    return out


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "betgenius/harness/out"
    patterns = ["*_m6_*.json", "*gate_m5*.json"]
    seen = set()
    rows = []
    for pat in patterns:
        for path in sorted(glob.glob(os.path.join(base, pat))):
            if path in seen:
                continue
            seen.add(path)
            try:
                rows.append(summarize(path))
            except Exception as e:
                print(f"ERR {path}: {e}", file=sys.stderr)
    for row in rows:
        print(json.dumps(row, indent=2))
