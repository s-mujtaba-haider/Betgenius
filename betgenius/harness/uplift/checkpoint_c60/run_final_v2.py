"""THE result, second architecture. Same gate, same verdict window, same as-of
data. Three things changed, each chosen on data the verdict window never
overlaps, and each because a walk-forward test inside the SELECT half said so.

What changed, and why
---------------------
1. THE EV FILTER NOW APPLIES TO EVERY MARKET.
   run_final.py scores `totals`, `h2h` and `spreads` through the `ev_pass`
   slice -- confidence floor and the heavy-juice veto, no EV filter -- because
   production's GAME write path carries no `evPerUnit` column to filter on. That
   is a plumbing gap, not a statistical one: expected value is computable on a
   game price exactly as it is on a prop price. Scored through the same
   `ev_filtered` slice the props use, `h2h` goes from one profitable sub-period
   in three to three in three on the SELECT half, and `spreads` likewise. The
   production recommendation that falls out of this is to write `evPerUnit` on
   the game path; until that ships, the game boards here are ahead of what the
   product can serve, and the report says so in a column of its own.

2. THE GLOBAL FILTER IS CHOSEN ON PROFIT AT THE WORST SUB-PERIOD, NOT ON A COUNT
   OF GATE PASSES.
   The old objective counted how many markets cleared the gate on their SELECT
   halves. That is a discrete number sitting on an n >= 500 cliff, and it bought
   its count by starving the thin markets: at the filter it chose, eleven markets
   between them showed 13,743 SELECT picks worth 421 units, while a looser one
   showed 39,605 picks worth 1,003 units. The picks it threw away were
   profitable. The objective here is instead

       sum over markets of  n x (worst of three chronological sub-period ROIs)

   -- volume, but counted only at the rate the worst stretch of the SELECT half
   actually paid. It rewards a board for being big only if it was still making
   money in its weakest patch, and it is continuous, so it does not sit on a
   cliff.

3. THE PER-MARKET SIDE LEVER NOW HAS TO EARN ITS PLACE.
   Choosing each market's side on SELECT units was measurably an overfit: in the
   nested test, adding an unguarded side lever to an otherwise identical rule
   took held-out markets-in-profit from 9/11 down to 8/11. The lever is kept,
   because it is the one the shipped MLB_EV_SIDE_POLICY already pulls, but a
   side is now adopted only when it beats "both sides" by more than 25% on the
   same robust-units measure. In practice it rarely fires, which is the point.

How the changes were validated -- and what was NOT allowed to validate them
---------------------------------------------------------------------------
Every one of them was chosen and tested inside the SELECT half alone, by
splitting it again on the clock:

    SELECT-A   the first 50/60/70% of the SELECT half  -- the rule is chosen here
    SELECT-B   the rest of the SELECT half             -- the rule is scored here
    VERDICT    the later half of the OOS period        -- never read until the end

Three inner split points, because a ranking that holds at only one cut is not a
ranking. Rules that lost that test were dropped and are written up in
MLB_PHASE1_RESULTS.md, including per-market ensemble selection by log loss,
per-market EV floors, a walk-forward Platt rescale of every member, and choosing
the global filter on raw units.

The gate is untouched: n >= 500 and ROI > 0, else the 95% CI lower bound must
clear zero. verify_gate.py still proves the port.

    python harness/uplift/run_final_v2.py [--lag=N] [--price=best] [--tag=NAME]
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
import boardfast
import build_cache
import mlbgate as G
import policy
import pricemodels

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")

# the six walk-forward members the cache holds, plus the two price-only members
# pricemodels.py rebuilds from the cached frame
MEMBERS = ("price", "compact", "box", "gbm", "offset", "iso", "priceflex", "priceshop")
TAUS = (0.0, 0.01, 0.02, 0.03, 0.04)
CONFS = (0, 45, 50, 55, 60)
COLLAPSE = ("maxEv", "mostBooks")
MIN_SELECT_N = 250
N_BLOCKS_STAB = 3            # chronological sub-periods the objective reads
SIDE_MARGIN = 1.25           # a side must beat "both" by this much to be adopted
PARSIMONY_BAND = 0.05        # configs within 5% of the best are treated as tied
NESTED_QUANTILES = (0.50, 0.60, 0.70)   # inner cuts for the held-out rule check
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
    """The verdict cut: the median commence time of the scored rows. Unchanged
    from run_final.py, so the two runs are compared over identical windows."""
    scored = c["frame"][np.isfinite(c["probs"]["price"])]
    return scored["commenceTime"].quantile(0.5)


def board_of(c, spec, tau, side, cut, half, min_conf, collapse, parity="ev_filtered"):
    sel = policy.board(c["frame"], prob(c, spec), tau=tau,
                       one_per=policy.unit_key(c["market"]), side=side,
                       parity=parity, min_conf=min_conf, collapse=collapse)
    if half == "select":
        return sel[sel["commenceTime"] < cut]
    if half == "verdict":
        return sel[sel["commenceTime"] >= cut]
    return sel


def block_rois(sel, k=N_BLOCKS_STAB):
    """ROI of each of k equal-count chronological slices of a board."""
    if len(sel) < k * 40:
        return []
    s = sel.sort_values("commenceTime")
    return [G.grade(s.iloc[p])["roiPct"] for p in np.array_split(np.arange(len(s)), k)]


def robust_units(sel, min_n=MIN_SELECT_N):
    """Volume priced at the worst sub-period's rate. Negative if that rate is."""
    m = G.grade(sel)
    if m["graded"] < min_n:
        return None
    b = block_rois(sel)
    if not b:
        return None
    return m["graded"] * min(b) / 100.0


def _fast_robust(f, tau, side, conf, cut, min_n=MIN_SELECT_N):
    """robust_units on the SELECT half, via the vectorised board. Same number
    the canonical path gives -- boardfast.selfcheck is what says so."""
    s = f.score(f.board_mask(tau, side, conf, "ev_filtered"), None, cut,
                kblocks=N_BLOCKS_STAB)
    if s["n"] < min_n or not s["blocks"]:
        return None, s
    return s["n"] * min(s["blocks"]) / 100.0, s


def choose_global(caches, cuts, fast):
    """ONE filter for all eleven markets, on the SELECT halves only.

    Four knobs -- ensemble spec, EV floor, confidence floor, ladder collapse --
    chosen once, jointly, across every market at the same time, by summed robust
    units. Eleven separate choices would be eleven chances to fit noise; this is
    a single choice whose cost, if it is wrong, is paid in every market at once.
    """
    rows = []
    for spec in specs():
        for col in COLLAPSE:
            fs = [(c, fast(c, spec, col)) for c in caches]
            for tau in TAUS:
                for conf in CONFS:
                    tot, ns, units = 0.0, 0, 0.0
                    for c, f in fs:
                        r, s = _fast_robust(f, tau, None, conf, cuts[c["market"]])
                        if r is None:
                            continue
                        tot += r
                        ns += s["n"]
                        units += s["units"]
                    rows.append(dict(spec="+".join(spec), tau=tau, minConf=conf,
                                     collapse=col, robustUnits=round(tot, 1),
                                     selectUnits=round(units, 1), selectN=ns,
                                     nMembers=len(spec)))
    r = pd.DataFrame(rows).sort_values(["robustUnits", "selectUnits", "nMembers"],
                                       ascending=[False, False, True])
    # Prefer the plateau, not the peak. Anything within PARSIMONY_BAND of the
    # best objective is, on this much data, the same answer; among those take
    # the fewest ensemble members and then the loosest floors, because a filter
    # that only works at one exact setting is a filter fitted to noise. This is
    # what keeps a 4,600-cell search from being 4,600 chances to overfit.
    best = float(r["robustUnits"].iloc[0])
    band = r[r["robustUnits"] >= best - PARSIMONY_BAND * abs(best)]
    band = band.sort_values(["nMembers", "minConf", "tau", "robustUnits"],
                            ascending=[True, True, True, False])
    top = band.iloc[0]
    return (tuple(top["spec"].split("+")), float(top["tau"]), int(top["minConf"]),
            str(top["collapse"]), r)


def choose_side(c, spec, tau, cut, min_conf, collapse, fast):
    """This market's side, on its SELECT half only, and only if it is worth it.

    "Both sides" is the default and has to be beaten by SIDE_MARGIN on robust
    units before a restriction is adopted. The nested test is what set that bar:
    an unguarded version of this lever cost a held-out market.
    """
    f = fast(c, spec, collapse)
    base, _ = _fast_robust(f, tau, None, min_conf, cut)
    key = SIDE_MARGIN * max(base or 0.0, 0.0) + 1.0
    best = None
    for side in ("over", "under", "plus", "minus"):
        r, _ = _fast_robust(f, tau, side, min_conf, cut)
        if r is not None and r > key:
            key, best = r, side
    return best


def nested_check(caches, cuts, fast, tag):
    """Does the selection RULE survive being asked to generalise one step?

    The SELECT half is cut again on the clock. The whole rule -- the 4,600-cell
    global search, the parsimony band, the guarded side lever -- is run on
    SELECT-A alone, and the board it produces is then scored on SELECT-B, which
    it has never seen. The incumbent run_final.py filter is put through the same
    test on the same windows, so the two are compared like for like.

    This is the only honest way to ask whether a search this wide is finding
    something or fitting something, WITHOUT spending the verdict window to find
    out. It is run at three inner cuts because a ranking that holds at one cut
    is not a ranking.
    """
    rows = []
    for q in NESTED_QUANTILES:
        hi = {}
        for c in caches:
            t = c["frame"]["commenceTime"]
            t = t[np.isfinite(c["probs"]["price"]) & (t < cuts[c["market"]])]
            hi[c["market"]] = t.quantile(q)

        # the v2 rule, chosen on SELECT-A only
        sub = {c["market"]: hi[c["market"]] for c in caches}
        spec, tau, conf, col, _ = choose_global(caches, sub, fast)
        for c in caches:
            m = c["market"]
            side = choose_side(c, spec, tau, sub[m], conf, col, fast)
            f = fast(c, spec, col)
            s = f.score(f.board_mask(tau, side, conf, "ev_filtered"), sub[m], cuts[m],
                        kblocks=N_BLOCKS_STAB)
            rows.append(dict(innerCut=q, rule="v2", market=m,
                             spec="+".join(spec), tau=tau, minConf=conf, collapse=col,
                             side=side or "both", n=s["n"], roi=round(s["roi"], 2)
                             if s["n"] else np.nan, units=round(s["units"], 1)))

        # the incumbent filter, same windows, same scoring
        for c in caches:
            m = c["market"]
            f = fast(c, ("price", "gbm", "iso"), "maxEv")
            best, key = None, None
            for side in (None, "over", "under", "plus", "minus"):
                t = f.score(f.board_mask(0.02, side, 55, policy.parity_for(m)),
                            None, sub[m])
                if t["n"] < MIN_SELECT_N:
                    continue
                k = (t["units"], side is None)
                if key is None or k > key:
                    key, best = k, side
            s = f.score(f.board_mask(0.02, best, 55, policy.parity_for(m)), sub[m], cuts[m])
            rows.append(dict(innerCut=q, rule="baseline", market=m,
                             spec="price+gbm+iso", tau=0.02, minConf=55, collapse="maxEv",
                             side=best or "both", n=s["n"],
                             roi=round(s["roi"], 2) if s["n"] else np.nan,
                             units=round(s["units"], 1)))
        print(f"  nested cut {q}: v2 filter = {'+'.join(spec)} tau{tau} conf{conf} {col}",
              flush=True)

    d = pd.DataFrame(rows)
    d.to_csv(os.path.join(REPORTS, f"nested{tag}.csv"), index=False)
    g = d.dropna(subset=["roi"]).groupby("rule").agg(
        marketSplits=("market", "size"), inProfit=("roi", lambda s: int((s > 0).sum())),
        heldOutN=("n", "sum"), heldOutUnits=("units", "sum"),
        medianRoi=("roi", "median"))
    print("\n--- held-out SELECT-B tail, rule chosen on SELECT-A only ---")
    print(g.to_string())
    return d


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


def status(full_pass, verdict_pass, flat_roi):
    """The four-way status the client table reports, unchanged."""
    if full_pass and verdict_pass:
        return "PASS"
    if full_pass or verdict_pass:
        return "PASS_WITH_RESTRICTIONS"
    if flat_roi is not None and flat_roi < -12.0:
        return "VETO"
    return "FAIL_AFTER_ITERATION"


def main():
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")
    tag = next((a.split("=")[1] for a in flags if a.startswith("--tag=")), "_v2")
    warmup = float(next((a.split("=")[1] for a in flags if a.startswith("--warmup=")),
                        policy.WARMUP))
    blocks = int(next((a.split("=")[1] for a in flags if a.startswith("--blocks=")),
                      policy.N_BLOCKS))

    caches = [build_cache.load(m, lag, price, warmup, blocks) for m in ORDER]
    missing = [m for m, c in zip(ORDER, caches) if c is None]
    caches = [c for c in caches if c]
    if missing:
        print(f"not in cache: {', '.join(missing)}")
    for c in caches:
        c["probs"] = dict(c["probs"])
        c["probs"].update(pricemodels.build(c))
    cuts = {c["market"]: halves(c) for c in caches}

    # the search runs on the vectorised board; the result does not. Prove they
    # are the same board before the search is allowed to decide anything.
    boardfast.selfcheck(caches, lambda c: prob(c, ("price", "gbm", "iso")), quiet=False)

    # One (spec, collapse) group at a time, and no more. The search walks 92
    # specs x 2 collapses; caching a Fast for each would hold ~2,000 of them,
    # roughly 7GB, and the run would spend its life in the pager. The global
    # search already visits the whole group's tau/conf grid before moving on, so
    # a cache of one group is all it ever needs.
    _fcache = {}

    def fast(c, spec, collapse):
        k = (spec, collapse)
        if _fcache.get("key") != k:
            _fcache.clear()
            _fcache["key"] = k
        if c["market"] not in _fcache:
            _fcache[c["market"]] = boardfast.Fast(c, prob(c, spec), collapse)
        return _fcache[c["market"]]

    if "--nested" in sys.argv or "--nested-only" in sys.argv:
        print("\nnested rule check -- SELECT half cut again, verdict window untouched")
        nested_check(caches, cuts, fast, tag)
        if "--nested-only" in sys.argv:
            # deliberate: the decision to adopt this architecture is taken here,
            # on held-out SELECT data, at a point where no verdict-window number
            # for it has been computed at all.
            print("\n--nested-only: stopping before the verdict window is read.")
            return
        print()

    spec, tau, min_conf, collapse, sweep = choose_global(caches, cuts, fast)
    sweep.to_csv(os.path.join(REPORTS, f"global_sweep{tag}.csv"), index=False)
    print(f"global filter, chosen on the SELECT halves by robust units: "
          f"spec={'+'.join(spec)}  EV floor={tau}  confidence floor={min_conf}  "
          f"ladder collapse={collapse}")
    print(sweep.head(8).to_string(index=False))

    rows, detail = [], {}
    for c in caches:
        m, cut = c["market"], cuts[c["market"]]
        side = choose_side(c, spec, tau, cut, min_conf, collapse, fast)
        base = c["frame"].copy()
        base["entryOdds"], base["hit"], base["voided"] = base["overOdds"], base["overHit"], False
        boards = [
            summarise(base, "base (every candidate, flat)"),
            summarise(board_of(c, ("price",), tau, side, cut, None, min_conf, collapse),
                      "price-only (full OOS)"),
            summarise(board_of(c, spec, tau, side, cut, None, min_conf, collapse),
                      "board (full OOS)"),
            # SHIPPED PARITY: the board production could actually serve today.
            # isEvPassPick requires confidence >= 60 and the game write path
            # carries no evPerUnit, so this column pins BOTH back to the shipped
            # values rather than only the parity. Passing the chosen min_conf
            # here -- which is what this line used to do -- labelled a board
            # "shipped parity" that production would not have shown.
            summarise(board_of(c, spec, tau, side, cut, None, 60, collapse,
                               parity=policy.parity_for(m)),
                      "board (full OOS, shipped parity)"),
            summarise(board_of(c, spec, tau, side, cut, "verdict", 60, collapse,
                               parity=policy.parity_for(m)),
                      "board (VERDICT, shipped parity)"),
            summarise(board_of(c, spec, tau, side, cut, "select", min_conf, collapse),
                      "board SELECT half"),
            summarise(board_of(c, spec, tau, side, cut, "verdict", min_conf, collapse),
                      "board VERDICT half"),
        ]
        detail[m] = boards
        b = {x["board"]: x for x in boards}
        v, f = b["board VERDICT half"], b["board (full OOS)"]
        flat_roi = b["base (every candidate, flat)"]["roi"]
        st = status(f["verdict"] == "PASS", v["verdict"] == "PASS", flat_roi)
        rows.append(dict(
            market=m, candidates=c["candidates"], graded=c["graded"], events=c["events"],
            fromDate=c["fromDate"], toDate=c["toDate"],
            spec="+".join(spec), tau=tau, minConf=min_conf, collapse=collapse,
            parity="ev_filtered", side=side or "both",
            baseN=b["base (every candidate, flat)"]["n"], baseRoi=flat_roi,
            priceOnlyRoi=b["price-only (full OOS)"]["roi"],
            shippedParityN=b["board (full OOS, shipped parity)"]["n"],
            shippedParityRoi=b["board (full OOS, shipped parity)"]["roi"],
            shippedParityVerdict=b["board (full OOS, shipped parity)"]["verdict"],
            shippedParityVerdictN=b["board (VERDICT, shipped parity)"]["n"],
            shippedParityVerdictRoi=b["board (VERDICT, shipped parity)"]["roi"],
            shippedParityVerdictGate=b["board (VERDICT, shipped parity)"]["verdict"],
            shippedParityStatus=status(
                b["board (full OOS, shipped parity)"]["verdict"] == "PASS",
                b["board (VERDICT, shipped parity)"]["verdict"] == "PASS", flat_roi),
            fullN=f["n"], fullRoi=f["roi"], fullCiLo=f["ciLo"], fullUnits=f["units"],
            fullVerdict=f["verdict"],
            selectN=b["board SELECT half"]["n"], selectRoi=b["board SELECT half"]["roi"],
            verdictFrom=str(cut)[:10], n=v["n"], winPct=v["winPct"], roi=v["roi"],
            ciLo=v["ciLo"], clusCiLo=v["clusCiLo"], units=v["units"], events_v=v["events"],
            verdict=v["verdict"], why=v["why"], finalStatus=st))
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
                   spec="+".join(spec), tau=tau, minConf=min_conf, collapse=collapse,
                   lag=lag, price=price, summary=rows, detail=detail),
              open(os.path.join(REPORTS, f"final{tag}.json"), "w"), indent=1, default=str)

    print("\n" + "=" * 138)
    print("MLB PHASE 1 - FINAL v2. Verdict window = later half of the out-of-sample"
          " period, never used to choose the filter or the side.")
    print(f"gate unchanged: n>=500 and ROI>0, else 95% CI lower bound>0    "
          f"spec={'+'.join(spec)}  EV floor={tau}  conf floor={min_conf}"
          f"  collapse={collapse}  price={price}  placebo lag={lag}d")
    print("=" * 138)
    show = ["market", "graded", "baseRoi", "priceOnlyRoi", "side", "fullN", "fullRoi",
            "fullCiLo", "fullVerdict", "verdictFrom", "n", "winPct", "roi", "ciLo",
            "clusCiLo", "units", "verdict", "finalStatus"]
    print(r[show].to_string(index=False))
    for s in ("PASS", "PASS_WITH_RESTRICTIONS", "VETO", "FAIL_AFTER_ITERATION"):
        k = r[r.finalStatus == s]
        print(f"{s:24s} {len(k):2d}/{len(r)}   {', '.join(k.market)}")
    print(f"\nfull-OOS gate  {int((r['fullVerdict'] == 'PASS').sum())}/{len(r)}"
          f"   verdict gate {int((r['verdict'] == 'PASS').sum())}/{len(r)}")
    print(f"units on the verdict window: {r['units'].sum():.1f}"
          f"   |   units full OOS: {r['fullUnits'].sum():.1f}")


if __name__ == "__main__":
    main()
