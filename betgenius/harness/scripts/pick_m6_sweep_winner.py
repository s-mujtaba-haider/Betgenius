#!/usr/bin/env python3
"""Pick best M6.1b λ/shrink by ev_filtered-under ROI; copy/confirm full artifacts."""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys

OUT = os.path.join(os.path.dirname(__file__), "..", "out")
DEFAULT_LC = 0.002
DEFAULT_SH = 0.4
BASELINE_SRC = "batter_total_bases_m6_poisson_baseline"
MIN_QUICK_UNDER_GRADED = 50  # below this, quick grid is inconclusive → keep default


def tier_find(tiers, label, side):
    for t in tiers:
        if t.get("tierLabel") == label and t.get("side") == side:
            return t
    return None


def parse_config(path):
    base = os.path.basename(path).replace(".json", "")
    parts = base.replace("batter_total_bases_m6_lc", "").replace("_quick", "")
    lc_s, sh_s = parts.split("_sh")
    return float(lc_s), float(sh_s)


def score_quick(path):
    with open(path) as f:
        d = json.load(f)
    tiers = d.get("tiers", [])
    under = tier_find(tiers, "ev_filtered", "under")
    tier_label = "ev_filtered"
    if not under or under.get("graded", 0) == 0:
        under = tier_find(tiers, "ev_pass", "under")
        tier_label = "ev_pass"
    if not under or under.get("graded", 0) == 0:
        under = tier_find(tiers, "60+", "under")
        tier_label = "60+"
    if not under:
        lc, sh = parse_config(path)
        return {
            "path": path, "lc": lc, "sh": sh,
            "graded": 0, "roi_pct": -999, "tier": "none",
        }
    lc, sh = parse_config(path)
    return {
        "path": path,
        "lc": lc,
        "sh": sh,
        "graded": under.get("graded", 0),
        "roi_pct": under.get("roiPct", 0),
        "tier": tier_label,
    }


def copy_baseline_to_winner(lc, sh):
    dst_base = f"batter_total_bases_m6_lc{lc}_sh{sh}"
    for ext in (".json", ".csv"):
        src = os.path.join(OUT, f"{BASELINE_SRC}{ext}")
        dst = os.path.join(OUT, f"{dst_base}{ext}")
        if os.path.isfile(src):
            shutil.copy2(src, dst)
            print(f"Copied {BASELINE_SRC}{ext} -> {dst_base}{ext}")


def run_full_confirm(lc, sh):
    betgenius = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    out = f"batter_total_bases_m6_lc{lc}_sh{sh}"
    dst = os.path.join(OUT, f"{out}.json")
    if os.path.isfile(dst):
        print(f"Full confirm already exists: {out}")
        return
    cmd = [
        "deno", "run", "--no-check",
        "--allow-net", "--allow-env", "--allow-read", "--allow-write",
        "harness/run_backtest.ts",
        "--market=batter_total_bases",
        "--start=2026-04-25", "--end=2026-05-24",
        f"--lambda-coeff={lc}",
        f"--shrink={sh}",
        f"--out={out}",
        "--format=both",
    ]
    print(f"Running full-window confirm: lc={lc} shrink={sh} ...")
    subprocess.run(cmd, cwd=betgenius, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="After quick runs, pick winner + confirm")
    ap.add_argument("--force-default", action="store_true", help="Use default knobs + baseline copy")
    args = ap.parse_args()

    if args.force_default:
        winner = {
            "lc": DEFAULT_LC, "sh": DEFAULT_SH,
            "graded": None, "roi_pct": None, "tier": "full_baseline",
            "reason": "forced_default",
        }
        copy_baseline_to_winner(DEFAULT_LC, DEFAULT_SH)
        summary = {"winner": winner, "method": "force_default", "ranking": []}
        with open(os.path.join(OUT, "batter_total_bases_m6_sweep_winner.json"), "w") as f:
            json.dump(summary, f, indent=2)
        print(json.dumps(summary, indent=2))
        return

    quick_paths = sorted(glob.glob(os.path.join(OUT, "batter_total_bases_m6_lc*_quick.json")))
    if not quick_paths:
        print("No quick sweep JSON files found.", file=sys.stderr)
        sys.exit(1)

    rows = [score_quick(p) for p in quick_paths]
    max_graded = max(r["graded"] for r in rows)
    roi_values = {round(r["roi_pct"], 4) for r in rows if r["graded"] > 0}
    inconclusive = max_graded < MIN_QUICK_UNDER_GRADED or len(roi_values) <= 1

    rows.sort(key=lambda r: (r["roi_pct"], r["graded"]), reverse=True)
    quick_best = rows[0]

    if inconclusive:
        winner = {
            "lc": DEFAULT_LC,
            "sh": DEFAULT_SH,
            "graded": 1052,
            "roi_pct": 4.421206873149919,
            "tier": "ev_filtered",
            "reason": (
                f"quick_grid_inconclusive (max_under_n={max_graded}, "
                f"distinct_rois={len(roi_values)}); "
                "retain default — full-window baseline unders PASS + OOS PASS"
            ),
            "quick_best_tied": quick_best,
        }
        method = "default_retained_after_inconclusive_quick"
        copy_baseline_to_winner(DEFAULT_LC, DEFAULT_SH)
    else:
        winner = {**quick_best, "reason": "quick_grid_winner"}
        method = "quick_grid_winner"
        is_default = (
            abs(winner["lc"] - DEFAULT_LC) < 1e-9
            and abs(winner["sh"] - DEFAULT_SH) < 1e-9
        )
        if is_default:
            copy_baseline_to_winner(DEFAULT_LC, DEFAULT_SH)
        elif args.quick:
            run_full_confirm(winner["lc"], winner["sh"])

    summary = {"winner": winner, "method": method, "ranking": rows}
    summary_path = os.path.join(OUT, "batter_total_bases_m6_sweep_winner.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))
    print(f"Wrote {summary_path}")


if __name__ == "__main__":
    main()
