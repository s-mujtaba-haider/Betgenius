#!/usr/bin/env python3
"""Finalize M6.2/M6.3 quick runs: augment side gates + alias deliverable artifacts."""
import json
import os
import shutil
import subprocess
import sys

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
AUGMENT = os.path.join(os.path.dirname(__file__), "augment_gate_json.py")


def augment(path):
    subprocess.run([sys.executable, AUGMENT, path, path], check=True)


def tier_summary(path):
    with open(path) as f:
        d = json.load(f)
    tiers = d.get("tiers", [])
    out = {"market": d.get("market"), "window": d.get("windowStartIso", "")[:10]}
    for side in ("all", "over", "under"):
        t = next(
            (x for x in tiers if x.get("tierLabel") == "ev_filtered" and x.get("side") == side),
            None,
        )
        if not t or t.get("graded", 0) == 0:
            t = next(
                (x for x in tiers if x.get("tierLabel") == "ev_pass" and x.get("side") == side),
                None,
            )
            label = "ev_pass"
        else:
            label = "ev_filtered"
        if t:
            out[f"{side}_tier"] = label
            out[f"{side}_graded"] = t.get("graded")
            out[f"{side}_roi_pct"] = t.get("roiPct")
    side_gates = d.get("evGateBySide") or {}
    if side_gates:
        out["over_gate_pass"] = side_gates.get("over", {}).get("pass")
        out["under_gate_pass"] = side_gates.get("under", {}).get("pass")
    return out


def alias(quick_base, deliverable_base):
    for ext in (".json", ".csv"):
        src = os.path.join(OUT, f"{quick_base}{ext}")
        dst = os.path.join(OUT, f"{deliverable_base}{ext}")
        if os.path.isfile(src):
            shutil.copy2(src, dst)
            print(f"Aliased {quick_base}{ext} -> {deliverable_base}{ext}")


def main():
    k_quick = os.path.join(OUT, "pitcher_strikeouts_m6_full_window_quick.json")
    o_quick = os.path.join(OUT, "pitcher_outs_m6_isotonic_d780_quick.json")

    for p in (k_quick, o_quick):
        if not os.path.isfile(p):
            print(f"Missing {p}", file=sys.stderr)
            sys.exit(1)
        augment(p)

    alias("pitcher_strikeouts_m6_full_window_quick", "pitcher_strikeouts_m6_full_window")
    alias("pitcher_outs_m6_isotonic_d780_quick", "pitcher_outs_m6_isotonic_d780")

    poisson = os.path.join(OUT, "pitcher_outs_m6_poisson_full.json")
    if os.path.isfile(poisson):
        augment(poisson)

    summary = {
        "method": "quick_limit_500_full_detected_window",
        "m6_2_pitcher_k": {
            **tier_summary(k_quick),
            "apr_may_comparability": tier_summary(
                os.path.join(OUT, "pitcher_strikeouts_m6_apr_may_slice.json")
            )
            if os.path.isfile(os.path.join(OUT, "pitcher_strikeouts_m6_apr_may_slice.json"))
            else None,
            "note": "Quick sample on full warehouse window; Apr–May slice retained for comparability.",
        },
        "m6_3_outs": {
            "poisson": tier_summary(poisson) if os.path.isfile(poisson) else None,
            "isotonic_quick": tier_summary(o_quick),
            "note": "Isotonic path may lack evPerUnit; ev_pass used when ev_filtered empty.",
        },
    }

    out_path = os.path.join(OUT, "m6_remaining_summary.json")
    with open(out_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
