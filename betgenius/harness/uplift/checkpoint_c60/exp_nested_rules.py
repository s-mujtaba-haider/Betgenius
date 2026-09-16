"""E17: three selection RULES, each chosen on SELECT-A, each scored on SELECT-B.

Why this file exists
--------------------
run_final_v2.py's own nested check compares its rule against an INCUMBENT FILTER
HELD FIXED -- spec price+gbm+iso, EV floor 0.02, confidence floor 55. That filter
was chosen by run_final.py on the whole SELECT half, SELECT-B included, so in
that test the baseline is scored partly on the data that picked it while v2
re-derives everything from SELECT-A. The comparison is biased toward the
baseline, and a rejection taken from it is not safe to rely on.

Here every rule is re-derived from SELECT-A alone, on the same windows:

  baseline         run_final.py's objective (count of markets clearing the gate
                   on their SELECT half), its 41-spec grid, its unguarded side
                   lever, and policy.parity_for -- ev_pass on the game markets.
  baseline+gameEV  identical in every respect except that the three GAME markets
                   are scored through ev_filtered, the slice the props already
                   use. This is the one v2 change that cannot touch the eight
                   prop markets: the run asserts they come back bit-identical.
  v2               run_final_v2.py's rule -- robust-units objective, 92-spec
                   grid including the two price-only members, parsimony band,
                   guarded side lever, ev_filtered everywhere.

The verdict window is never read. The latest timestamp this file touches is the
SELECT/VERDICT cut, and it only ever uses it as an upper bound.

    python harness/uplift/exp_nested_rules.py
"""
import itertools
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
import run_final
import run_final_v2 as v2

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = v2.ORDER
GAME = policy.GAME_MARKETS
QUANTILES = v2.NESTED_QUANTILES


def base_specs():
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(run_final.MEMBERS, r))
    return out


def gate_of(f, mask, lo, hi):
    """mlbgate.verdict on a fast-path board. The bootstrap only runs when the
    board is under the n>=500 floor, which is the only branch that needs it."""
    s = f.score(mask, lo, hi)
    if s["n"] == 0:
        return "NO_DATA", s
    if s["n"] >= G.EV_GATE_MIN_GRADED:
        return ("PASS" if s["roi"] > 0 else "FAIL"), s
    a = 0 if lo is None else int(np.searchsorted(f.t, f._ns(lo), "left"))
    b = f.n if hi is None else int(np.searchsorted(f.t, f._ns(hi), "left"))
    pr = f.profit[a:b][mask[a:b]]
    _, ci_lo, _ = G.bootstrap_mean_ci(pr)
    return ("PASS" if ci_lo > 0 else "FAIL"), s


def parity_of(market, game_ev):
    return "ev_filtered" if (game_ev or market not in GAME) else policy.parity_for(market)


def choose_baseline(caches, cuts, fast, game_ev, confs=run_final.CONFS):
    """run_final.choose_global, on the fast path, with the game parity as a flag.

    `confs` is the confidence-floor grid. run_final.py sweeps (0, 55, 60);
    passing (60,) pins it to the value isEvPassPick already enforces and takes
    the knob out of the search entirely."""
    rows = []
    for spec in base_specs():
        for col in run_final.COLLAPSE:
            fs = [(c, fast(c, spec, col)) for c in caches]
            for tau in run_final.TAUS:
                for conf in confs:
                    passes, units, ns = 0, 0.0, 0
                    for c, f in fs:
                        m = c["market"]
                        mask = f.board_mask(tau, None, conf, parity_of(m, game_ev))
                        v, s = gate_of(f, mask, None, cuts[m])
                        if s["n"] < run_final.MIN_SELECT_N:
                            continue
                        units += s["units"]
                        ns += s["n"]
                        passes += (v == "PASS")
                    rows.append(dict(spec="+".join(spec), tau=tau, minConf=conf,
                                     collapse=col, selectPasses=passes,
                                     selectUnits=round(units, 1), selectN=ns,
                                     nMembers=len(spec)))
    r = pd.DataFrame(rows).sort_values(
        ["selectPasses", "selectUnits", "nMembers"], ascending=[False, False, True])
    top = r.iloc[0]
    return (tuple(top["spec"].split("+")), float(top["tau"]), int(top["minConf"]),
            str(top["collapse"]))


def side_baseline(c, f, tau, conf, cut, game_ev):
    """run_final.choose_side: unguarded, by SELECT units."""
    best, key = None, None
    par = parity_of(c["market"], game_ev)
    for side in run_final.SIDES:
        s = f.score(f.board_mask(tau, side, conf, par), None, cut)
        if s["n"] < run_final.MIN_SELECT_N:
            continue
        k = (s["units"], side is None)
        if key is None or k > key:
            key, best = k, side
    return best


def main():
    caches = [build_cache.load(m) for m in ORDER]
    caches = [c for c in caches if c]
    for c in caches:
        c["probs"] = dict(c["probs"])
        c["probs"].update(pricemodels.build(c))
    cuts = {c["market"]: v2.halves(c) for c in caches}
    boardfast.selfcheck(caches, lambda c: v2.prob(c, ("price", "gbm", "iso")), quiet=False)

    _fc = {}

    def fast(c, spec, collapse):
        k = (spec, collapse)
        if _fc.get("key") != k:
            _fc.clear()
            _fc["key"] = k
        if c["market"] not in _fc:
            _fc[c["market"]] = boardfast.Fast(c, v2.prob(c, spec), collapse)
        return _fc[c["market"]]

    rows = []
    for q in QUANTILES:
        sub = {}
        for c in caches:
            t = c["frame"]["commenceTime"]
            t = t[np.isfinite(c["probs"]["price"]) & (t < cuts[c["market"]])]
            sub[c["market"]] = t.quantile(q)

        for rule, game_ev, confs in (("baseline", False, run_final.CONFS),
                                     ("baseline+gameEV", True, run_final.CONFS),
                                     ("baseline@conf60", False, (60,))):
            spec, tau, conf, col = choose_baseline(caches, sub, fast, game_ev, confs)
            for c in caches:
                m = c["market"]
                f = fast(c, spec, col)
                side = side_baseline(c, f, tau, conf, sub[m], game_ev)
                s = f.score(f.board_mask(tau, side, conf, parity_of(m, game_ev)),
                            sub[m], cuts[m])
                rows.append(dict(innerCut=q, rule=rule, market=m, spec="+".join(spec),
                                 tau=tau, minConf=conf, collapse=col,
                                 side=side or "both", n=s["n"],
                                 roi=round(s["roi"], 2) if s["n"] else np.nan,
                                 units=round(s["units"], 1)))
            print(f"  cut {q} {rule:16s} filter = {'+'.join(spec)} tau{tau} "
                  f"conf{conf} {col}", flush=True)

        spec, tau, conf, col, _ = v2.choose_global(caches, sub, fast)
        for c in caches:
            m = c["market"]
            side = v2.choose_side(c, spec, tau, sub[m], conf, col, fast)
            f = fast(c, spec, col)
            s = f.score(f.board_mask(tau, side, conf, "ev_filtered"), sub[m], cuts[m],
                        kblocks=v2.N_BLOCKS_STAB)
            rows.append(dict(innerCut=q, rule="v2", market=m, spec="+".join(spec),
                             tau=tau, minConf=conf, collapse=col, side=side or "both",
                             n=s["n"], roi=round(s["roi"], 2) if s["n"] else np.nan,
                             units=round(s["units"], 1)))
        print(f"  cut {q} {'v2':16s} filter = {'+'.join(spec)} tau{tau} "
              f"conf{conf} {col}", flush=True)

    d = pd.DataFrame(rows)
    d.to_csv(os.path.join(REPORTS, "nested_rules.csv"), index=False)

    # the structural claim behind baseline+gameEV, asserted rather than trusted
    a = d[d.rule == "baseline"].set_index(["innerCut", "market"])
    b = d[d.rule == "baseline+gameEV"].set_index(["innerCut", "market"])
    props = [m for m in ORDER if m not in GAME]
    idx = [(q, m) for q in QUANTILES for m in props]
    ia = a.loc[idx, ["n", "units"]]
    ib = b.loc[idx, ["n", "units"]]
    identical = ia.equals(ib)
    print(f"\nprop markets identical between baseline and baseline+gameEV: {identical}")
    if not identical:
        print(ia.compare(ib).to_string())

    pd.set_option("display.width", 240)
    print("\n--- held-out SELECT-B ROI %, rule chosen on SELECT-A only ---")
    print(d.pivot_table(index="market", columns=["rule", "innerCut"],
                        values="roi").round(2).to_string())
    g = d.dropna(subset=["roi"]).groupby("rule").agg(
        marketSplits=("market", "size"), inProfit=("roi", lambda s: int((s > 0).sum())),
        heldOutN=("n", "sum"), heldOutUnits=("units", "sum"),
        medianRoi=("roi", "median"))
    print("\n--- pooled over the three inner cuts ---")
    print(g.to_string())
    gm = d[d.market.isin(GAME)].dropna(subset=["roi"]).groupby("rule").agg(
        gameSplits=("market", "size"), gameInProfit=("roi", lambda s: int((s > 0).sum())),
        gameN=("n", "sum"), gameUnits=("units", "sum"))
    print("\n--- the three GAME markets only ---")
    print(gm.to_string())
    print("\n-> " + os.path.join(REPORTS, "nested_rules.csv"))


if __name__ == "__main__":
    main()
