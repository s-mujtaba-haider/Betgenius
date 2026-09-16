#!/usr/bin/env python3
"""Extract ev_gate / tier metrics from harness JSON outputs."""
import json, glob, os, sys

def tier_find(tiers, label, side="all"):
    for t in tiers:
        if t.get("tierLabel") == label and t.get("side") == side:
            return t
    return None

def summarize(path):
    with open(path) as f:
        d = json.load(f)
    gate = d.get("evGate") or d.get("m3Gate") or {}
    ef = tier_find(d.get("tiers", []), "ev_filtered", "all")
    over = tier_find(d.get("tiers", []), "ev_filtered", "over")
    under = tier_find(d.get("tiers", []), "ev_filtered", "under")
    return {
        "file": os.path.basename(path),
        "market": d.get("market"),
        "source": d.get("dataSource"),
        "window": f"{d.get('windowStartIso','')}..{d.get('windowEndIso','')}",
        "gate_pass": gate.get("pass"),
        "gate_reason": gate.get("reason"),
        "graded": ef.get("graded") if ef else gate.get("graded"),
        "roi_pct": ef.get("roiPct") if ef else gate.get("roiPct"),
        "roi_ci_lo": ef.get("roiCiLoPct") if ef else gate.get("roiCiLoPct"),
        "avg_clv": ef.get("avgClvPct") if ef else gate.get("avgClvPct"),
        "over_roi": over.get("roiPct") if over else None,
        "under_roi": under.get("roiPct") if under else None,
    }

if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "betgenius/harness/out"
    patterns = ["*gate_m5*.json", "*clv_fix*.json", "*oos*.json", "*holdout*.json"]
    seen = set()
    for pat in patterns:
        for path in sorted(glob.glob(os.path.join(base, pat))):
            if path in seen:
                continue
            seen.add(path)
            try:
                print(json.dumps(summarize(path), indent=2))
            except Exception as e:
                print(f"ERR {path}: {e}")
