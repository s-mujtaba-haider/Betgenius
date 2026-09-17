"""E23: does a nominal 5% edge actually pay 5%, and does fixing it help?

The board's filter is `evPerUnit > tau`. That number is a MODEL OUTPUT, and
nothing in the pipeline has ever checked whether it is calibrated. A model that
is well calibrated in PROBABILITY can still be badly calibrated in EDGE, because
edge is a difference between two nearly-equal numbers and inherits the error of
both: a half-point of probability error at -110 is a two-point edge error, and
selecting on `ev > tau` selects precisely the rows where that error is largest
and positive. That is the classic winner's curse, and it is a selection problem,
not a probability problem -- so a better model does not fix it.

This file does two things.

  1. MEASURES it. Per market, per predicted-edge bucket, on the SELECT half
     only: predicted edge against realised profit, with n. This is the table
     Phase 15 of the brief asks for and it is worth having whatever the
     experiment decides.

  2. TESTS a fix. A monotone map from predicted edge to realised profit, fitted
     ONLY on rows from earlier walk-forward folds -- the same contract
     `hybrid.blend_arrays` honours for `w` -- and applied forward. The board then
     filters on the CALIBRATED edge.

What is deliberately NOT changed
--------------------------------
Only the EV FILTER sees the calibrated number. The side choice still comes from
the raw EV comparison, and `confidence` is still round(100 * p) -- because
confidence >= 60 is the production contract and `isEvPassPick` reads exactly that
field. Rewriting confidence to make more rows servable would be changing the
product rule to pass the test, which the brief forbids and round 1 already
proved harmful. So this experiment can only ever REMOVE rows from a board, never
add them, and it cannot touch the three game markets at all: they are graded on
the `ev_pass` slice, which has no EV filter in production.

    python harness/uplift/exp_edge_calibration.py [--jobs=N] [--tag=_e23]
"""
import itertools
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import boardfast
import build_cache
import mlbgate as G
import policy
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = run_final.ORDER
QUANTILES = (0.5, 0.6, 0.7)
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")
CONF = 60
MIN_FIT = 1000                 # earlier OOS rows required before the map is used
BUCKETS = [-np.inf, 0.0, 0.01, 0.02, 0.03, 0.05, 0.07, 0.10, np.inf]
LABELS = ["<0%", "0-1%", "1-2%", "2-3%", "3-5%", "5-7%", "7-10%", "10%+"]


def raw_ev_and_profit(c, p):
    """The board's own EV for the side it would take, and that side's profit."""
    d = c["frame"]
    dec_o = G.american_to_decimal(d["overOdds"].to_numpy(float))
    dec_u = G.american_to_decimal(d["underOdds"].to_numpy(float))
    ev_o = p * dec_o - (1 - p)
    ev_u = (1 - p) * dec_u - p
    take = ev_o >= ev_u
    ev = np.where(take, ev_o, ev_u)
    odds = np.where(take, d["overOdds"].to_numpy(float), d["underOdds"].to_numpy(float))
    oh = d["overHit"].to_numpy(float)
    hit = np.where(take, oh, 1.0 - oh)
    profit = np.where(hit > 0.5, G.american_to_decimal(odds), -1.0)
    return ev, profit


def edges_of(c):
    """The walk-forward fold boundaries policy.walkforward used, recomputed."""
    t = pd.to_datetime(c["frame"]["commenceTime"], utc=True).to_numpy("datetime64[ns]")
    n = len(t)
    start = int(policy.WARMUP * n)
    if start < 50 or n - start < 50:
        return t, []
    e = [t[start]]
    step = max(1, (n - start) // policy.N_BLOCKS)
    for i in range(start + step, n, step):
        if t[i] > e[-1]:
            e.append(t[i])
    e.append(np.datetime64("2999-01-01T00:00:00"))
    return t, e


def calibrated_ev(c, p):
    """Predicted edge -> expected profit, fitted forward on the clock.

    At each fold boundary the map is fitted on every row ALREADY SCORED before
    it. Those predictions came from models trained strictly earlier, so they are
    already out of sample and fitting a map on them is not fitting on data the
    members have seen. Before MIN_FIT such rows exist the raw edge is passed
    through unchanged -- the conservative direction, since the map can only ever
    shrink a board.
    """
    ev, profit = raw_ev_and_profit(c, p)
    t, edges = edges_of(c)
    out = np.array(ev, dtype=float)
    ok = np.isfinite(p) & np.isfinite(ev)
    for lo, hi in zip(edges[:-1], edges[1:]):
        te = (t >= lo) & (t < hi) & ok
        tr = (t < lo) & ok
        if te.sum() == 0 or tr.sum() < MIN_FIT:
            continue
        iso = IsotonicRegression(out_of_bounds="clip", increasing=True)
        iso.fit(ev[tr], profit[tr])
        out[te] = iso.predict(ev[te])
    return out


class FastCal(boardfast.Fast):
    """boardfast.Fast with the EV FILTER reading a calibrated edge.

    `self.ev` is what `board_mask` compares against tau AND what `maxEv` collapse
    orders a player's ladder by, so overriding it changes both -- which is the
    intent: if the calibrated edge is the honest one, it should also decide which
    rung of a ladder is the best bet. Everything else -- side, confidence, odds,
    profit, the juice veto -- is untouched and still comes from the raw board.
    """

    def __init__(self, c, p, collapse, ev_cal):
        super().__init__(c, p, collapse)
        self.ev = np.asarray(ev_cal, float)
        d = c["frame"]
        by = self.ev if (collapse == "maxEv" or "nBooks" not in d) else d["nBooks"].to_numpy(float)
        self.order = np.lexsort((-self.ev, -by))
        key = policy.unit_key(self.market)
        codes = (pd.MultiIndex.from_arrays([d[k] for k in key]).factorize()[0]
                 if len(key) > 1 else d[key[0]].factorize()[0])
        self._codes = codes[self.order]


def specs():
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(run_final.MEMBERS, r))
    return out


def prob(c, spec):
    return np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)


def halves(c):
    return c["frame"][np.isfinite(c["probs"]["price"])]["commenceTime"].quantile(0.5)


def gate_of(f, mask, lo, hi):
    s = f.score(mask, lo, hi)
    if s["n"] == 0:
        return False, s
    if s["n"] >= G.EV_GATE_MIN_GRADED:
        return bool(s["roi"] > 0), s
    a = 0 if lo is None else int(np.searchsorted(f.t, f._ns(lo), "left"))
    b = f.n if hi is None else int(np.searchsorted(f.t, f._ns(hi), "left"))
    pr = f.profit[a:b][mask[a:b]]
    _, ci_lo, _ = G.bootstrap_mean_ci(pr)
    return bool(ci_lo > 0), s


def one_market(market):
    c = build_cache.load(market)
    if c is None:
        return [], []
    cut = halves(c)
    par = policy.parity_for(market)
    t = c["frame"]["commenceTime"]
    ok = np.isfinite(c["probs"]["price"])
    subcuts = {q: t[ok & (t < cut)].quantile(q) for q in QUANTILES}
    tarr = pd.to_datetime(t, utc=True).to_numpy("datetime64[ns]")
    selmask = tarr < np.datetime64(pd.Timestamp(cut).tz_convert("UTC").tz_localize(None))

    # ---- (1) the measurement, on the SELECT half, at the shipped spec --------
    diag = []
    for spec in (("gbm",), ("price",), ("price", "gbm", "iso")):
        p = prob(c, spec)
        ev, profit = raw_ev_and_profit(c, p)
        m = np.isfinite(p) & np.isfinite(ev) & selmask
        b = pd.cut(ev[m], BUCKETS, labels=LABELS, right=False)
        g = pd.DataFrame(dict(bucket=b, ev=ev[m], profit=profit[m])).groupby(
            "bucket", observed=False).agg(n=("ev", "size"), predEdgePct=("ev", "mean"),
                                          realEdgePct=("profit", "mean"))
        g["predEdgePct"] *= 100
        g["realEdgePct"] *= 100
        g["gapPct"] = g.predEdgePct - g.realEdgePct
        diag.append(g.reset_index().assign(market=market, spec="+".join(spec)))

    # ---- (2) the nested test, matched cell by cell --------------------------
    rows = []
    if par != "ev_filtered":
        return diag, rows          # game markets have no EV filter in production
    for spec in specs():
        p = prob(c, spec)
        ev_cal = calibrated_ev(c, p)
        for arm in ("off", "on"):
            for col in run_final.COLLAPSE:
                f = (boardfast.Fast(c, p, col) if arm == "off"
                     else FastCal(c, p, col, ev_cal))
                for tau in run_final.TAUS:
                    for q in QUANTILES:
                        sub = subcuts[q]
                        best, key = None, None
                        for side in run_final.SIDES:
                            s = f.score(f.board_mask(tau, side, CONF, par), None, sub)
                            if s["n"] < run_final.MIN_SELECT_N:
                                continue
                            k = (s["units"], side is None)
                            if key is None or k > key:
                                key, best = k, side
                        mask = f.board_mask(tau, best, CONF, par)
                        gp, sa = gate_of(f, mask, None, sub)
                        sb = f.score(mask, sub, cut)
                        rows.append(dict(
                            arm=arm, innerCut=q, market=market, spec="+".join(spec),
                            nMembers=len(spec), tau=tau, collapse=col,
                            side=best or "both", aN=sa["n"],
                            aUnits=round(sa["units"], 2), aPass=int(gp), bN=sb["n"],
                            bRoi=round(sb["roi"], 3) if sb["n"] else np.nan,
                            bUnits=round(sb["units"], 2)))
                del f
    return diag, rows


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_e23")
    jobs = int(next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--jobs=")), 11))
    print("E23: edge calibration", flush=True)
    if jobs > 1:
        import multiprocessing as mp
        with mp.Pool(min(jobs, len(ORDER))) as pool:
            out = pool.map(one_market, ORDER)
    else:
        out = [one_market(m) for m in ORDER]
    diag = pd.concat([g for sub, _ in out for g in sub], ignore_index=True)
    d = pd.DataFrame([r for _, sub in out for r in sub])
    diag.to_csv(os.path.join(REPORTS, f"edge_buckets{tag}.csv"), index=False)
    d.to_csv(os.path.join(REPORTS, f"edge_calibration{tag}.csv"), index=False)

    pd.set_option("display.width", 250)
    print("\n" + "=" * 100)
    print("PHASE 15 MEASUREMENT -- predicted edge vs realised, SELECT half only, spec=gbm")
    print("=" * 100)
    g = diag[diag.spec == "gbm"]
    for col in ("n", "predEdgePct", "realEdgePct"):
        print(f"\n--- {col} ---")
        print(g.pivot_table(index="market", columns="bucket", values=col,
                            observed=False, sort=False)
               .reindex(ORDER)[LABELS].round(2).to_string())
    print("\n--- pooled over all 11 markets ---")
    pool_ = (g.assign(w=g.n)
              .groupby("bucket", observed=False)
              .apply(lambda s: pd.Series(dict(
                  n=s.n.sum(),
                  predEdgePct=np.average(s.predEdgePct, weights=s.n.clip(lower=1)),
                  realEdgePct=np.average(s.realEdgePct, weights=s.n.clip(lower=1)))),
                     include_groups=False))
    pool_["gapPct"] = pool_.predEdgePct - pool_.realEdgePct
    print(pool_.round(2).to_string())

    if len(d) == 0:
        print("\nno prop cells scored")
        return
    print("\n" + "=" * 100)
    print("MATCHED READING -- calibrated-edge filter minus raw-edge filter, on SELECT-B")
    print("=" * 100)
    key = ["innerCut", "market", "spec", "tau", "collapse"]
    w = d.pivot_table(index=key, columns="arm", values=["bN", "bUnits", "bRoi"]).reset_index()
    w.columns = ["_".join(x).strip("_") for x in w.columns]
    w["dUnits"] = w.bUnits_on - w.bUnits_off
    for tau in sorted(d.tau.unique()):
        s = w[w.tau == tau]
        print(f"  EV floor {tau:<5} cells {len(s):5,}  units off {s.bUnits_off.sum():9.1f}"
              f"  on {s.bUnits_on.sum():9.1f}  delta {s.dUnits.sum():+9.1f}"
              f"  rows off {int(s.bN_off.sum()):7,} on {int(s.bN_on.sum()):7,}")
    t0 = w[w.tau == 0.0]
    pm = t0.groupby("market").agg(cells=("dUnits", "size"), nOff=("bN_off", "sum"),
                                  nOn=("bN_on", "sum"), unitsOff=("bUnits_off", "sum"),
                                  unitsOn=("bUnits_on", "sum"), dUnits=("dUnits", "sum"))
    pm["roiOff"] = 100 * pm.unitsOff / pm.nOff.replace(0, np.nan)
    pm["roiOn"] = 100 * pm.unitsOn / pm.nOn.replace(0, np.nan)
    print("\n--- per market at EV floor 0.00 ---")
    print(pm.reindex([m for m in ORDER if m in pm.index]).round(2).to_string())
    nwin = int((pm.dUnits > 0).sum())
    print(f"\nCONDITION 1  pooled units at floor 0.00: off {t0.bUnits_off.sum():.1f}"
          f"  on {t0.bUnits_on.sum():.1f} -> "
          f"{'PASS' if t0.bUnits_on.sum() > t0.bUnits_off.sum() else 'FAIL'}")
    print(f"CONDITION 2  markets improved: {nwin} / {len(pm)}")
    stm = t0[t0.market.isin(STRONG)]
    print(f"CONDITION 3  strong-market cells in profit: "
          f"off {int((stm.bRoi_off > 0).sum())}/{len(stm)}   "
          f"on {int((stm.bRoi_on > 0).sum())}/{len(stm)}")
    print(f"\n-> {os.path.join(REPORTS, f'edge_calibration{tag}.csv')}")


if __name__ == "__main__":
    main()
