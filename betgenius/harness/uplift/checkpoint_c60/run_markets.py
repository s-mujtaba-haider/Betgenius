"""The evaluation. Every market, walk-forward, published gate unchanged.

    python harness/uplift/run_markets.py [market ...] [--lag=N] [--price=median]
                                         [--tag=NAME] [--locked]

How a verdict is produced, and why it is worth something
-------------------------------------------------------
Every candidate is scored by a calibrator that was re-fit forward through time
and never saw a game that had not already finished. Those out-of-sample scores
are then cut in half on the clock:

  SELECT   the earlier half. The market's own model spec, its EV floor and any
           side restriction are chosen here, on total units, and nowhere else.
  VERDICT  the later half. Never looked at while choosing anything. The gate is
           applied to this window, and this is the verdict that is reported.

That split is the whole point. Searching hard over specs on SELECT cannot
manufacture a PASS, because the number that decides comes from a window the
search never touched -- an over-fitted choice shows up there as a FAIL, not as a
win. The full out-of-sample period is reported next to it for context, clearly
labelled, and is not the verdict.

Four boards are printed per market and are meant to be read together:

  base         every priced candidate, flat-bet. This is the vig.
  price-only   the market's own number recalibrated against itself, nothing
               else. Whatever the board earns above this line is what the
               box-score and matchup features actually added.
  board        the shipped filter: at most ONE bet per player-game (per game on
               the three game markets), on the best number available.
  all-lines    the same filter without that collapse, so alternate-ladder
               double counting is visible rather than banked.

mlbgate.verdict is the shipped rule, unmodified: n >= 500 and ROI > 0, else the
95% CI lower bound must clear zero. verify_gate.py proves the port reproduces
the harness's own published numbers.
"""
import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features
import frames
import mlbgate as G
import policy

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
MEMBERS = ("price", "compact", "box", "gbm", "offset", "iso")
SPECS = (("price",), ("price", "compact"), ("compact",), ("price", "box"),
         ("price", "compact", "gbm"), ("price", "box", "gbm"))
TAUS = (0.0, 0.01, 0.02, 0.04)
SIDES = (None, "over", "under")
MIN_SELECT_N = 250


def flat_baseline(g):
    """Flat-bet every candidate on the over. The overround, made visible."""
    d = g.copy()
    d["entryOdds"] = d["overOdds"]
    d["hit"] = d["overHit"]
    d["voided"] = False
    return d


def _avg(probs, spec):
    m = np.vstack([probs[s] for s in spec])
    return np.nanmean(m, axis=0)


def choose(g, probs, unit, cut):
    """Pick spec, EV floor and side on the SELECT half only, on total units."""
    best = dict(spec=("price", "box"), tau=0.0, side=None, units=-1e18, n=0)
    for spec in SPECS:
        p = _avg(probs, spec)
        for tau in TAUS:
            for side in SIDES:
                s = policy.board(g, p, tau=tau, one_per=unit, side=side)
                s = s[s["commenceTime"] < cut]
                met = G.grade(s)
                if met["graded"] < MIN_SELECT_N:
                    continue
                # tie-break toward the simpler board: fewer members, no floor,
                # no side restriction
                score = (met["units"], -len(spec), -tau, side is None)
                if score > (best["units"], -len(best["spec"]), -best["tau"], best["side"] is None):
                    best = dict(spec=spec, tau=tau, side=side, units=met["units"],
                                n=met["graded"])
    return best


def evaluate(market, box, lag=0, price="best", locked=False, spec=("price", "box")):
    t0 = time.time()
    c = frames.load_candidates(market, box, price=price)
    d, cols = features.build(market, c, box, lag_days=lag)
    g = features.graded(d)
    out = dict(market=market, candidates=int(len(d)), graded=int(len(g)),
               events=int(g["game_pk"].nunique()) if len(g) else 0,
               fromDate=g["game_date"].min() if len(g) else None,
               toDate=g["game_date"].max() if len(g) else None)
    if len(g) < 300:
        out["verdict"] = "NO_DATA"
        out["why"] = f"only {len(g)} graded candidates"
        return out, None, None

    probs, g = policy.walkforward(g, cols, members=MEMBERS)
    unit = policy.unit_key(market)
    scored = g[np.isfinite(probs["price"])]
    cut = scored["commenceTime"].quantile(0.5)

    pick = (dict(spec=spec, tau=0.0, side=None) if locked
            else choose(g, probs, unit, cut))
    p = _avg(probs, pick["spec"])
    out.update(spec="+".join(pick["spec"]), tau=pick["tau"], side=pick["side"] or "both")

    sel = policy.board(g, p, tau=pick["tau"], one_per=unit, side=pick["side"])
    allsel = policy.board(g, p, tau=pick["tau"], one_per=None, side=pick["side"])
    ponly = policy.board(g, probs["price"], tau=pick["tau"], one_per=unit, side=pick["side"])
    verdict_slice = sel[sel["commenceTime"] >= cut]
    select_slice = sel[sel["commenceTime"] < cut]

    rows = [policy.summarise(flat_baseline(g), "base"),
            policy.summarise(ponly, "price-only"),
            policy.summarise(sel, "board (full OOS)"),
            policy.summarise(allsel, "all-lines (full OOS)"),
            policy.summarise(select_slice, "board SELECT half"),
            policy.summarise(verdict_slice, "board VERDICT half")]
    b = {r["board"]: r for r in rows}
    v = b["board VERDICT half"]
    f = b["board (full OOS)"]
    out.update(
        baseRoi=b["base"]["roi"], baseN=b["base"]["n"],
        priceOnlyRoi=b["price-only"]["roi"], priceOnlyN=b["price-only"]["n"],
        fullN=f["n"], fullRoi=f["roi"], fullCiLo=f["ciLo"], fullUnits=f["units"],
        fullVerdict=f["verdict"],
        allLinesN=b["all-lines (full OOS)"]["n"], allLinesRoi=b["all-lines (full OOS)"]["roi"],
        allLinesVerdict=b["all-lines (full OOS)"]["verdict"],
        selectN=b["board SELECT half"]["n"], selectRoi=b["board SELECT half"]["roi"],
        verdictFrom=str(cut)[:10],
        n=v["n"], winPct=v["winPct"], roi=v["roi"], ciLo=v["ciLo"],
        clusCiLo=v["clusCiLo"], units=v["units"], events=v["events"],
        verdict=v["verdict"], why=v["why"],
        seconds=round(time.time() - t0, 1))
    return out, pd.DataFrame(rows), sel


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")
    tag = next((a.split("=")[1] for a in flags if a.startswith("--tag=")), "")
    locked = "--locked" in flags
    spec = tuple(next((a.split("=")[1] for a in flags if a.startswith("--spec=")),
                      "price,box").split(","))
    markets = args or [m for m in frames.MARKETS
                       if frames.market_files(m)]

    os.makedirs(REPORTS, exist_ok=True)
    box = frames.load_box()
    summary, detail = [], {}
    for m in markets:
        out, rows, sel = evaluate(m, box, lag=lag, price=price, locked=locked, spec=spec)
        summary.append(out)
        if rows is None:
            print(f"\n=== {m}: {out.get('why')}")
            continue
        detail[m] = rows.to_dict("records")
        print(f"\n=== {m}   candidates {out['candidates']:,}  graded {out['graded']:,}"
              f"   spec {out['spec']}  EV floor {out['tau']}  side {out['side']}"
              f"   [{out['seconds']}s]")
        print(rows[["board", "n", "winPct", "roi", "ciLo", "clusCiLo", "units",
                    "events", "verdict"]].to_string(index=False))
        if sel is not None and len(sel):
            sel[["market", "game_date", "eventId", "game_pk", "playerId", "player_name",
                 "line", "pickSide", "entryOdds", "confidence", "evPerUnit",
                 "actual", "hit"]].to_csv(os.path.join(REPORTS, f"picks_{m}{tag}.csv"),
                                          index=False)
        sys.stdout.flush()

    r = pd.DataFrame(summary)
    r.to_csv(os.path.join(REPORTS, f"results{tag}.csv"), index=False)
    json.dump(dict(generatedAt=pd.Timestamp.utcnow().isoformat(), lag=lag, price=price,
                   locked=locked, summary=summary, detail=detail),
              open(os.path.join(REPORTS, f"results{tag}.json"), "w"), indent=1, default=str)

    print("\n" + "=" * 126)
    print("MLB PHASE 1 — verdict window is the later half of the out-of-sample period,"
          " untouched by model selection")
    print(f"gate unchanged (n>=500 and ROI>0, else CI lower bound>0)   price={price}"
          f"  placebo lag={lag}d  spec={'LOCKED' if locked else 'chosen on SELECT half'}")
    print("=" * 126)
    cols = ["market", "graded", "baseRoi", "priceOnlyRoi", "spec", "tau", "side",
            "fullN", "fullRoi", "n", "roi", "ciLo", "clusCiLo", "units", "verdict"]
    print(r[[c for c in cols if c in r]].to_string(index=False))
    npass = int((r["verdict"] == "PASS").sum())
    print(f"\nPASS {npass} / {len(r)}   ({', '.join(r[r.verdict == 'PASS'].market)})")
    print(f"units on the verdict window: {r['units'].sum():.1f}")


if __name__ == "__main__":
    main()
