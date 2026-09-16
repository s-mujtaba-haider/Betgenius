"""The improvement loop, and the experiment record it leaves behind.

A market that fails the global filter is not vetoed on the spot. It goes through
the levers the roadmap lists, in order, and every attempt is written down --
including the ones that did not work, because a table of only the things that
worked is indistinguishable from a table of things that got lucky.

Levers, all of them already precedented in the shipped system:

  model spec     price recalibration / compact vector / full vector / gradient
                 boosting, and averages of them            (Level 4 and Level 5)
  EV floor       a market-specific minimum edge                      (Level 7)
  side           over-only or under-only, the same lever
                 MLB_EV_SIDE_POLICY already pulls on hits,
                 total bases, game_total and game_side              (Level 7)
  confidence     the shipped conf >= 60 style floor                 (Level 7)
  sample floor   require N prior appearances for the player         (Level 7)

How a choice is kept honest
---------------------------
Every attempt is MEASURED on the SELECT half -- the earlier half of the
out-of-sample period. The winner is then carried, untouched, to the VERDICT half
and that is the number the gate sees. Because the verdict window was never
looked at during the search, searching harder cannot manufacture a PASS: an
over-fitted choice simply fails there. The full out-of-sample figure is printed
next to it for context and is never the verdict.

    python harness/uplift/run_improve.py [market ...] [--lag=N] [--price=best]
"""
import itertools
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import frames
import mlbgate as G
import policy

MEMBERS = ("price", "compact", "box", "gbm", "offset", "iso")
TAUS = (0.0, 0.01, 0.02, 0.04, 0.07)
SIDES = (None, "over", "under", "plus", "minus")
CONFS = (0, 55, 60, 65)
HISTS = (0, 10, 20)
MIN_SELECT_N = 250
REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def specs():
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(MEMBERS, r))
    return out


def apply_board(c, spec, tau, side, conf, hist, cut=None, half=None):
    g = c["frame"]
    p = np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)
    sel = policy.board(g, p, tau=tau, one_per=policy.unit_key(c["market"]), side=side)
    if conf:
        sel = sel[sel["confidence"] >= conf]
    if hist and "nHist" in sel:
        sel = sel[sel["nHist"].fillna(0) >= hist]
    if cut is not None and half == "select":
        sel = sel[sel["commenceTime"] < cut]
    elif cut is not None and half == "verdict":
        sel = sel[sel["commenceTime"] >= cut]
    return sel


def improve(c, log):
    """Search the levers on SELECT; return the winner and its VERDICT-half read."""
    g = c["frame"]
    scored = g[np.isfinite(c["probs"]["price"])]
    cut = scored["commenceTime"].quantile(0.5)
    best, best_key = None, None
    attempt = 0
    for spec in specs():
        for tau in TAUS:
            for side in SIDES:
                for conf in CONFS:
                    for hist in HISTS:
                        sel = apply_board(c, spec, tau, side, conf, hist, cut, "select")
                        met = G.grade(sel)
                        if met["graded"] < MIN_SELECT_N:
                            continue
                        attempt += 1
                        log.append(dict(market=c["market"], attempt=attempt,
                                        spec="+".join(spec), tau=tau,
                                        side=side or "both", minConf=conf, minHist=hist,
                                        selectN=met["graded"],
                                        selectRoi=round(met["roiPct"], 2),
                                        selectUnits=round(met["units"], 1)))
                        # simplest board that wins on units; ties broken toward
                        # fewer members, no floor, both sides, no restriction
                        key = (met["units"], -len(spec), -tau, side is None, -conf, -hist)
                        if best_key is None or key > best_key:
                            best_key = key
                            best = dict(spec=spec, tau=tau, side=side, minConf=conf,
                                        minHist=hist, selectUnits=met["units"],
                                        selectN=met["graded"],
                                        selectRoi=met["roiPct"])
    if best is None:
        return None, cut
    for half, label in (("verdict", "verdict"), (None, "full")):
        sel = apply_board(c, best["spec"], best["tau"], best["side"], best["minConf"],
                          best["minHist"], cut, half)
        met = G.grade(sel)
        v, why = G.verdict(met)
        clo = 100 * G.cluster_bootstrap_ci(sel)[1] if met["graded"] else np.nan
        best[f"{label}N"] = met["graded"]
        best[f"{label}Roi"] = round(met["roiPct"], 2)
        best[f"{label}CiLo"] = round(met["roiCiLoPct"], 2)
        best[f"{label}ClusCiLo"] = round(clo, 2) if np.isfinite(clo) else np.nan
        best[f"{label}Units"] = round(met["units"], 1)
        best[f"{label}Verdict"] = v
        best[f"{label}Why"] = why
        best[f"{label}WinPct"] = round(met["winRatePct"], 2)
    best["attempts"] = attempt
    return best, cut


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")
    markets = args or list(frames.MARKETS)

    os.makedirs(REPORTS, exist_ok=True)
    log, rows = [], []
    for m in markets:
        c = build_cache.load(m, lag, price)
        if not c:
            print(f"  {m}: not in cache")
            continue
        best, cut = improve(c, log)
        if best is None:
            print(f"  {m}: no configuration reached {MIN_SELECT_N} picks on the select half")
            continue
        best.update(market=m, spec="+".join(best["spec"]), side=best["side"] or "both",
                    verdictFrom=str(cut)[:10], graded=c["graded"])
        rows.append(best)
        print(f"{m:20s} {best['attempts']:4d} attempts -> spec {best['spec']:22s} "
              f"floor {best['tau']:<5} side {best['side']:<5} conf>={best['minConf']:<3} "
              f"hist>={best['minHist']:<3} | VERDICT n={best['verdictN']:<6,} "
              f"ROI {best['verdictRoi']:>6.2f}%  {best['verdictVerdict']}")
        sys.stdout.flush()

    r = pd.DataFrame(rows)
    cols = ["market", "graded", "attempts", "spec", "tau", "side", "minConf", "minHist",
            "selectN", "selectRoi", "fullN", "fullRoi", "fullVerdict",
            "verdictFrom", "verdictN", "verdictWinPct", "verdictRoi", "verdictCiLo",
            "verdictClusCiLo", "verdictUnits", "verdictVerdict", "verdictWhy"]
    r = r[[c for c in cols if c in r]]
    r.to_csv(os.path.join(REPORTS, f"improve_lag{lag}_{price}.csv"), index=False)
    pd.DataFrame(log).to_csv(os.path.join(REPORTS, f"improve_log_lag{lag}_{price}.csv"),
                             index=False)

    print("\n" + "=" * 128)
    print("PER-MARKET IMPROVEMENT LOOP — every knob chosen on the SELECT half,"
          " verdict read from the untouched VERDICT half")
    print("=" * 128)
    show = ["market", "attempts", "spec", "tau", "side", "minConf", "minHist",
            "fullN", "fullRoi", "verdictN", "verdictRoi", "verdictCiLo",
            "verdictClusCiLo", "verdictVerdict"]
    print(r[[c for c in show if c in r]].to_string(index=False))
    npass = int((r["verdictVerdict"] == "PASS").sum())
    print(f"\nPASS on the untouched verdict window: {npass} / {len(r)}   "
          f"({', '.join(r[r.verdictVerdict == 'PASS'].market)})")
    print(f"attempts logged: {len(log):,} -> reports/improve_log_lag{lag}_{price}.csv")


if __name__ == "__main__":
    main()
