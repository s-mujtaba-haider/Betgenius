"""THE result. Every market, one filter, and a verdict read from data that was
never used to choose anything.

The design, and why it is arranged this way
------------------------------------------
Each market's out-of-sample period is cut in half on the clock:

    SELECT    the earlier half -- everything is chosen here
    VERDICT   the later half  -- nothing is chosen here, the gate reads it

Two things are chosen, and only two:

  1. ONE global filter -- model spec and EV floor -- shared by all eleven
     markets, picked on the SELECT halves pooled together. Eleven separate
     choices would be eleven chances to fit noise; one choice across eleven
     markets is a single knob.
  2. Each market's SIDE (over / under / both), the one lever the shipped system
     already pulls per market -- MLB_EV_SIDE_POLICY restricts hits and total
     bases to unders, game_total to unders and game_side to aways today. Three
     options, chosen on that market's SELECT half.

Because the VERDICT half is never read while choosing, neither of those choices
can manufacture a PASS. An over-fitted choice shows up there as a FAIL. That is
the point of the arrangement, and it is why the headline number can be trusted
in a way that a number tuned on its own test set cannot.

The gate is the shipped one, untouched: n >= 500 and ROI > 0, else the 95% CI
lower bound must clear zero. verify_gate.py proves the port reproduces the
harness's own published verdicts bit for bit.

    python harness/uplift/run_final.py [--lag=N] [--price=best] [--tag=NAME]
"""
import itertools
import json
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

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
MEMBERS = ("price", "compact", "box", "gbm", "offset", "iso")
TAUS = (0.0, 0.01, 0.02, 0.04)
CONFS = (0, 55, 60)
COLLAPSE = ("maxEv", "mostBooks")
SIDES = (None, "over", "under", "plus", "minus")
MIN_SELECT_N = 250
ORDER = ["batter_hits", "batter_rbis", "totals", "spreads", "batter_total_bases",
         "batter_home_runs", "pitcher_strikeouts", "h2h", "batter_runs_scored",
         "pitcher_outs", "batter_strikeouts"]


def specs():
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(MEMBERS, r))
    return out


def prob(c, spec):
    return np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)


def halves(c):
    scored = c["frame"][np.isfinite(c["probs"]["price"])]
    return scored["commenceTime"].quantile(0.5)


def board_of(c, spec, tau, side, cut, half, min_conf=60, collapse="maxEv"):
    sel = policy.board(c["frame"], prob(c, spec), tau=tau,
                       one_per=policy.unit_key(c["market"]), side=side,
                       parity=policy.parity_for(c["market"]), min_conf=min_conf,
                       collapse=collapse)
    if half == "select":
        return sel[sel["commenceTime"] < cut]
    if half == "verdict":
        return sel[sel["commenceTime"] >= cut]
    return sel


def choose_global(caches, cuts):
    """ONE filter for all eleven markets, scored on the SELECT halves only.

    Three knobs -- model spec, EV floor, confidence floor -- chosen once, jointly,
    across every market at the same time. Eleven separate choices would be eleven
    chances to fit noise; this is a single choice whose cost, if it is wrong, is
    paid in every market at once.
    """
    rows = []
    for spec in specs():
        for tau in TAUS:
            for conf in CONFS:
                for col in COLLAPSE:
                    passes, units, ns = 0, 0.0, 0
                    for c in caches:
                        sel = board_of(c, spec, tau, None, cuts[c["market"]],
                                       "select", conf, col)
                        met = G.grade(sel)
                        if met["graded"] < MIN_SELECT_N:
                            continue
                        units += met["units"]
                        ns += met["graded"]
                        if G.verdict(met)[0] == "PASS":
                            passes += 1
                    rows.append(dict(spec="+".join(spec), tau=tau, minConf=conf,
                                     collapse=col, selectPasses=passes,
                                     selectUnits=round(units, 1), selectN=ns,
                                     nMembers=len(spec)))
    r = pd.DataFrame(rows).sort_values(
        ["selectPasses", "selectUnits", "nMembers"], ascending=[False, False, True])
    top = r.iloc[0]
    return (tuple(top["spec"].split("+")), float(top["tau"]), int(top["minConf"]),
            str(top["collapse"]), r)


def choose_side(c, spec, tau, cut, min_conf=60, collapse="maxEv"):
    """This market's side policy, on its SELECT half only.

    The one lever the shipped system already pulls per market:
    MLB_EV_SIDE_POLICY restricts hits and total bases to unders, game_total to
    unders and game_side to aways today. Five options on a signed handicap,
    three elsewhere, and nothing else is tuned per market.
    """
    best, key = None, None
    for side in SIDES:
        met = G.grade(board_of(c, spec, tau, side, cut, "select", min_conf, collapse))
        if met["graded"] < MIN_SELECT_N:
            continue
        k = (met["units"], side is None)
        if key is None or k > key:
            key, best = k, side
    return best


def _unused_choose_board(c, spec, cut):
    """This market's side policy and EV floor, on its SELECT half only.

    Two knobs, both already precedented in the shipped system: which side of the
    market the board is allowed to show (MLB_EV_SIDE_POLICY) and how much edge a
    pick must carry before it is shown (the evPerUnit > 0 rule). Twenty-five
    combinations, scored on data the verdict window never overlaps.
    """
    best, key = (None, 0.0), None
    for side in SIDES:
        for tau in BOARD_TAUS:
            met = G.grade(board_of(c, spec, tau, side, cut, "select", min_conf, collapse))
            if met["graded"] < MIN_SELECT_N:
                continue
            k = (met["units"], side is None, tau is None)
            if key is None or k > key:
                key, best = k, (side, tau)
    return best


def summarise(sel, label, key="eventId"):
    met = G.grade(sel)
    v, why = G.verdict(met)
    clo = 100 * G.cluster_bootstrap_ci(sel, key=key)[1] if met["graded"] else np.nan
    return dict(board=label, n=met["graded"], winPct=round(met["winRatePct"], 2),
                roi=round(met["roiPct"], 2), ciLo=round(met["roiCiLoPct"], 2),
                clusCiLo=round(clo, 2) if np.isfinite(clo) else np.nan,
                units=round(met["units"], 1),
                events=int(sel["game_pk"].nunique()) if len(sel) else 0,
                verdict=v, why=why)


def main():
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")
    tag = next((a.split("=")[1] for a in flags if a.startswith("--tag=")), "")
    warmup = float(next((a.split("=")[1] for a in flags if a.startswith("--warmup=")),
                        policy.WARMUP))
    blocks = int(next((a.split("=")[1] for a in flags if a.startswith("--blocks=")),
                      policy.N_BLOCKS))

    caches = [build_cache.load(m, lag, price, warmup, blocks) for m in ORDER]
    missing = [m for m, c in zip(ORDER, caches) if c is None]
    caches = [c for c in caches if c]
    if missing:
        print(f"not in cache: {', '.join(missing)}")
    cuts = {c["market"]: halves(c) for c in caches}

    spec, tau, min_conf, collapse, sweep = choose_global(caches, cuts)
    sweep.to_csv(os.path.join(REPORTS, f"global_sweep{tag}.csv"), index=False)
    print(f"global filter chosen on the SELECT halves: spec={'+'.join(spec)}  "
          f"EV floor={tau}  confidence floor={min_conf}  ladder collapse={collapse}")
    print(f"(the EV floor applies to the prop markets; the three game markets are gated"
          f" on the ev_pass slice, as production gates them)")
    print(sweep.head(10).to_string(index=False))

    rows, detail = [], {}
    for c in caches:
        m, cut = c["market"], cuts[c["market"]]
        side = choose_side(c, spec, tau, cut, min_conf, collapse)
        p = prob(c, spec)
        base = c["frame"].copy()
        base["entryOdds"], base["hit"], base["voided"] = base["overOdds"], base["overHit"], False
        boards = [
            summarise(base, "base (every candidate, flat)"),
            summarise(board_of(c, ("price",), tau, side, cut, None, min_conf, collapse),
                      "price-only (full OOS)"),
            summarise(board_of(c, spec, tau, side, cut, None, min_conf, collapse),
                      "board (full OOS)"),
            summarise(policy.board(c["frame"], p, tau=tau, one_per=None, side=side,
                                   parity=policy.parity_for(m), min_conf=min_conf),
                      "all-lines (full OOS)"),
            summarise(board_of(c, spec, tau, side, cut, "select", min_conf),
                      "board SELECT half"),
            summarise(board_of(c, spec, tau, side, cut, "verdict", min_conf, collapse),
                      "board VERDICT half"),
        ]
        detail[m] = boards
        b = {x["board"]: x for x in boards}
        v, f = b["board VERDICT half"], b["board (full OOS)"]
        rows.append(dict(
            market=m, candidates=c["candidates"], graded=c["graded"], events=c["events"],
            fromDate=c["fromDate"], toDate=c["toDate"],
            spec="+".join(spec), tau=tau, minConf=min_conf, collapse=collapse,
            parity=policy.parity_for(m), side=side or "both",
            baseN=b["base (every candidate, flat)"]["n"],
            baseRoi=b["base (every candidate, flat)"]["roi"],
            priceOnlyRoi=b["price-only (full OOS)"]["roi"],
            fullN=f["n"], fullRoi=f["roi"], fullCiLo=f["ciLo"], fullUnits=f["units"],
            fullVerdict=f["verdict"],
            allLinesN=b["all-lines (full OOS)"]["n"],
            allLinesRoi=b["all-lines (full OOS)"]["roi"],
            allLinesVerdict=b["all-lines (full OOS)"]["verdict"],
            selectN=b["board SELECT half"]["n"], selectRoi=b["board SELECT half"]["roi"],
            verdictFrom=str(cut)[:10], n=v["n"], winPct=v["winPct"], roi=v["roi"],
            ciLo=v["ciLo"], clusCiLo=v["clusCiLo"], units=v["units"], events_v=v["events"],
            verdict=v["verdict"], why=v["why"]))
        print(f"\n=== {m}   candidates {c['candidates']:,}  graded {c['graded']:,}"
              f"  side {side or 'both'}   {c['fromDate']} -> {c['toDate']}")
        print(pd.DataFrame(boards)[["board", "n", "winPct", "roi", "ciLo", "clusCiLo",
                                    "units", "events", "verdict"]].to_string(index=False))
        sys.stdout.flush()

    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(REPORTS, f"final{tag}.csv"), index=False)
    flat = pd.concat([pd.DataFrame(v).assign(market=k) for k, v in detail.items()])
    flat = flat[["market", "board", "n", "winPct", "roi", "ciLo", "clusCiLo", "units",
                 "events", "verdict", "why"]]
    flat.to_csv(os.path.join(REPORTS, f"boards{tag}.csv"), index=False)
    json.dump(dict(generatedAt=pd.Timestamp.utcnow().isoformat(),
                   spec="+".join(spec), tau=tau, lag=lag, price=price,
                   summary=rows, detail=detail),
              open(os.path.join(REPORTS, f"final{tag}.json"), "w"), indent=1, default=str)

    print("\n" + "=" * 132)
    print("MLB PHASE 1 — FINAL. Verdict window = later half of the out-of-sample period,"
          " never used to choose the filter or the side.")
    print(f"gate unchanged: n>=500 and ROI>0, else 95% CI lower bound>0    "
          f"spec={'+'.join(spec)}  EV floor={tau}  conf floor={min_conf}"
          f"  collapse={collapse}  price={price}  placebo lag={lag}d")
    print("=" * 132)
    show = ["market", "graded", "baseRoi", "priceOnlyRoi", "parity", "side", "fullN", "fullRoi",
            "verdictFrom", "n", "winPct", "roi", "ciLo", "clusCiLo", "units", "verdict"]
    print(r[show].to_string(index=False))
    npass = int((r["verdict"] == "PASS").sum())
    nfull = int((r["fullVerdict"] == "PASS").sum())
    print(f"\nPASS on the untouched VERDICT window : {npass} / {len(r)}"
          f"   ({', '.join(r[r.verdict == 'PASS'].market)})")
    print(f"PASS on the full out-of-sample period: {nfull} / {len(r)}"
          f"   ({', '.join(r[r.fullVerdict == 'PASS'].market)})")
    print(f"units on the verdict window: {r['units'].sum():.1f}"
          f"   |   units full OOS: {r['fullUnits'].sum():.1f}")


if __name__ == "__main__":
    main()
