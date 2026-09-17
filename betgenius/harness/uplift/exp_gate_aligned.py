"""E24: choose the selection knobs on the objective the GATE actually scores.

The misalignment
----------------
`run_final.choose_side` picks a market's side by SELECT **units**. The global
filter is ranked by markets-clearing-the-gate and then by **units**. But the gate
is not a units test:

    n >= 500   ->  PASS iff ROI > 0
    n <  500   ->  PASS iff the 95% CI lower bound clears zero

That is ROI *subject to a sample floor*, and units is ROI x n -- a quantity a
rule can raise by taking more bets at a worse price. Round 3 found this inside
the model search ("the objective rewards disagreement, because disagreement makes
volume"); E23 found the same thing inside the selection rule, from the other
side: a calibrated-edge filter that lifts held-out ROI on six of eight markets
still loses on units, because it cuts the board in half.

So this file changes the objective and nothing else.

What may move, and why each is production-legal
-----------------------------------------------
Every knob here may only **tighten**, so an arm-B board is a strict SUBSET of the
arm-A board in the same cell. Unservable rows cannot be introduced by
construction, and round 1's 36%-unservable failure cannot recur.

  confidence floor   searched UPWARD from 60, never below. Production already
                     ships this control: Dashboard.tsx renders confidence tiers
                     at 60 / 70 / 80 / 90 and its headline card counts picks at
                     >= 65. A higher floor is a subset of the isEvPassPick board.
  EV floor           searched upward from the global floor, never below.
  side               the lever MLB_EV_SIDE_POLICY already pulls per market.

What may not move: the gate, the meaning of Full OOS or of the Verdict Window,
the `ev_pass` parity of the three game markets, and the floor downward. The
model, the features and the data are untouched.

The sample floor, without reading the verdict window
----------------------------------------------------
SELECT-A at inner cut q holds q x 50% of the scored rows; the verdict window
holds 50%. A board rate yielding n picks in SELECT-A therefore yields about n/q
in a window of the verdict window's length, so requiring `n >= 500q` on SELECT-A
is the floor that projects to the gate's 500. Only the arithmetic of the
quantiles is used -- no verdict row, outcome or count is read.

    python harness/uplift/exp_gate_aligned.py [--jobs=N] [--tag=_e24]
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
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = run_final.ORDER
QUANTILES = (0.5, 0.6, 0.7)
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")
CONFS_UP = (60, 65, 70, 75, 80)          # never below the production floor
GATE_N = G.EV_GATE_MIN_GRADED             # 500


def specs():
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(run_final.MEMBERS, r))
    return out


def prob(c, spec):
    return np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)


def halves(c):
    return c["frame"][np.isfinite(c["probs"]["price"])]["commenceTime"].quantile(0.5)


def subcuts_of(c, cut):
    t = c["frame"]["commenceTime"]
    t = t[np.isfinite(c["probs"]["price"]) & (t < cut)]
    return {q: t.quantile(q) for q in QUANTILES}


def gate_of(f, mask, lo, hi):
    """mlbgate.verdict on a fast-path board; bootstrap only below the n floor."""
    s = f.score(mask, lo, hi)
    if s["n"] == 0:
        return False, s
    if s["n"] >= GATE_N:
        return bool(s["roi"] > 0), s
    a = 0 if lo is None else int(np.searchsorted(f.t, f._ns(lo), "left"))
    b = f.n if hi is None else int(np.searchsorted(f.t, f._ns(hi), "left"))
    pr = f.profit[a:b][mask[a:b]]
    _, ci_lo, _ = G.bootstrap_mean_ci(pr)
    return bool(ci_lo > 0), s


# --------------------------------------------------------------------------
# stage 1: the global (spec, EV floor, collapse), shared by every arm
# --------------------------------------------------------------------------
def stage1_market(market):
    c = build_cache.load(market)
    if c is None:
        return []
    cut = halves(c)
    sub = subcuts_of(c, cut)
    par = policy.parity_for(market)
    rows = []
    for spec in specs():
        p = prob(c, spec)
        for col in run_final.COLLAPSE:
            f = boardfast.Fast(c, p, col)
            for tau in run_final.TAUS:
                mask = f.board_mask(tau, None, 60, par)
                for q in QUANTILES:
                    gp, s = gate_of(f, mask, None, sub[q])
                    rows.append(dict(market=market, innerCut=q, spec="+".join(spec),
                                     nMembers=len(spec), tau=tau, collapse=col,
                                     aPass=int(gp), aUnits=s["units"], aN=s["n"]))
            del f
    return rows


def choose_global(g):
    """run_final.choose_global's objective, unchanged, on SELECT-A."""
    r = (g[g.aN >= run_final.MIN_SELECT_N]
         .groupby(["spec", "tau", "collapse", "nMembers"])
         .agg(selectPasses=("aPass", "sum"), selectUnits=("aUnits", "sum"))
         .reset_index()
         .sort_values(["selectPasses", "selectUnits", "nMembers"],
                      ascending=[False, False, True]))
    t = r.iloc[0]
    return tuple(t["spec"].split("+")), float(t["tau"]), str(t["collapse"])


# --------------------------------------------------------------------------
# stage 2: the per-market layer, three arms
# --------------------------------------------------------------------------
def stage2_market(args):
    market, chosen = args
    c = build_cache.load(market)
    if c is None:
        return []
    cut = halves(c)
    sub = subcuts_of(c, cut)
    par = policy.parity_for(market)
    rows = []
    for q in QUANTILES:
        spec, tau_g, col = chosen[q]
        f = boardfast.Fast(c, prob(c, spec), col)
        floor = int(np.ceil(GATE_N * q))       # projects to 500 in a half-window
        taus = [t for t in run_final.TAUS if t >= tau_g] or [tau_g]

        # ---- arm A: the incumbent. side by SELECT-A units, confidence 60 ----
        bestA, keyA = None, None
        for side in run_final.SIDES:
            s = f.score(f.board_mask(tau_g, side, 60, par), None, sub[q])
            if s["n"] < run_final.MIN_SELECT_N:
                continue
            k = (s["units"], side is None)
            if keyA is None or k > keyA:
                keyA, bestA = k, side
        cfgA = (bestA, 60, tau_g)

        # ---- arms B and C: gate-aligned, tightening only -------------------
        cand = []
        for side in run_final.SIDES:
            for conf in CONFS_UP:
                for tau in taus:
                    s = f.score(f.board_mask(tau, side, conf, par), None, sub[q],
                                kblocks=3)
                    if s["n"] < floor:
                        continue
                    cand.append(dict(side=side, conf=conf, tau=tau, n=s["n"],
                                     roi=s["roi"], units=s["units"],
                                     minBlock=s["minBlock"]))
        cfgB = cfgC = cfgA
        if cand:
            cd = pd.DataFrame(cand)
            # arm B: best SELECT-A ROI among settings clearing the sample floor.
            # Ties -> the LOOSEST setting (biggest n), so the rule prefers the
            # plateau over a peak that exists at one exact threshold.
            b = cd.sort_values(["roi", "n"], ascending=[False, False]).iloc[0]
            cfgB = (b["side"], int(b["conf"]), float(b["tau"]))
            # arm C: same, restricted to settings whose worst chronological
            # third of SELECT-A is already positive
            st = cd[cd.minBlock > 0]
            if len(st):
                cc = st.sort_values(["roi", "n"], ascending=[False, False]).iloc[0]
                cfgC = (cc["side"], int(cc["conf"]), float(cc["tau"]))

        for arm, cfg in (("A:incumbent", cfgA), ("B:gateAligned", cfgB),
                         ("C:gateAligned+stab", cfgC)):
            side, conf, tau = cfg
            mask = f.board_mask(tau, side, conf, par)
            _, sa = gate_of(f, mask, None, sub[q])
            gp, sb = gate_of(f, mask, sub[q], cut)
            rows.append(dict(
                arm=arm, innerCut=q, market=market, spec="+".join(spec),
                globalTau=tau_g, collapse=col, side=side or "both", conf=conf,
                tau=tau, floor=floor, aN=sa["n"],
                aRoi=round(sa["roi"], 3) if sa["n"] else np.nan,
                bN=sb["n"], bRoi=round(sb["roi"], 3) if sb["n"] else np.nan,
                bUnits=round(sb["units"], 2), bGatePass=int(gp)))
        del f
    return rows


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_e24")
    jobs = int(next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--jobs=")), 11))
    import multiprocessing as mp

    print("E24 stage 1: the global filter, on SELECT-A", flush=True)
    with mp.Pool(min(jobs, len(ORDER))) as pool:
        s1 = pd.DataFrame([r for sub in pool.map(stage1_market, ORDER) for r in sub])
    chosen = {q: choose_global(s1[s1.innerCut == q]) for q in QUANTILES}
    for q in QUANTILES:
        sp, tg, cl = chosen[q]
        print(f"  cut {q}: spec={'+'.join(sp)}  EV floor={tg}  collapse={cl}", flush=True)

    print("\nE24 stage 2: the per-market layer, three arms", flush=True)
    with mp.Pool(min(jobs, len(ORDER))) as pool:
        d = pd.DataFrame([r for sub in pool.map(stage2_market,
                                                [(m, chosen) for m in ORDER])
                          for r in sub])
    path = os.path.join(REPORTS, f"gate_aligned{tag}.csv")
    d.to_csv(path, index=False)
    report(d)
    print(f"\n-> {path}")


def report(d):
    pd.set_option("display.width", 250)
    print("\n" + "=" * 104)
    print("HELD-OUT SELECT-B, scored by the SHIPPED GATE. The rule is re-derived on SELECT-A only.")
    print("=" * 104)

    print("\n--- gate PASS on held-out SELECT-B, per market x arm (of 3 inner cuts) ---")
    pv = d.pivot_table(index="market", columns="arm", values="bGatePass",
                       aggfunc="sum").reindex(ORDER)
    print(pv.to_string())

    print("\n--- held-out SELECT-B ROI %, per market x arm (mean over the 3 cuts) ---")
    print(d.pivot_table(index="market", columns="arm", values="bRoi",
                        aggfunc="mean").reindex(ORDER).round(2).to_string())

    print("\n--- held-out SELECT-B board n, per market x arm (mean over the 3 cuts) ---")
    print(d.pivot_table(index="market", columns="arm", values="bN",
                        aggfunc="mean").reindex(ORDER).round(0).to_string())

    g = d.groupby("arm").agg(splits=("bGatePass", "size"),
                             gatePasses=("bGatePass", "sum"),
                             inProfit=("bRoi", lambda s: int((s > 0).sum())),
                             heldOutN=("bN", "sum"),
                             heldOutUnits=("bUnits", "sum"),
                             medianRoi=("bRoi", "median"))
    print("\n--- pooled over all markets and all three inner cuts ---")
    print(g.round(2).to_string())

    st = d[d.market.isin(STRONG)].groupby("arm").agg(
        splits=("bGatePass", "size"), gatePasses=("bGatePass", "sum"),
        inProfit=("bRoi", lambda s: int((s > 0).sum())),
        units=("bUnits", "sum"), medianRoi=("bRoi", "median"))
    print("\n--- CONDITION 2, the four strong markets (regression guard) ---")
    print(st.round(2).to_string())

    base = int(g.loc["A:incumbent", "gatePasses"])
    sbase = int(st.loc["A:incumbent", "gatePasses"])
    print("\n" + "-" * 104)
    for arm in ("B:gateAligned", "C:gateAligned+stab"):
        gp, sp_ = int(g.loc[arm, "gatePasses"]), int(st.loc[arm, "gatePasses"])
        c1 = gp > base
        c2 = sp_ >= sbase
        print(f"{arm:22s}  CONDITION 1 gate passes {gp} vs {base} -> "
              f"{'PASS' if c1 else 'FAIL'}   |   CONDITION 2 strong {sp_} vs {sbase} -> "
              f"{'PASS' if c2 else 'FAIL'}   |   OVERALL "
              f"{'ADOPT' if (c1 and c2) else 'REJECT'}")

    print("\n--- the settings arm B chose, per market x cut ---")
    b = d[d.arm == "B:gateAligned"]
    print(b.pivot_table(index="market", columns="innerCut",
                        values="conf", aggfunc="first").reindex(ORDER).to_string())
    print("\n(side / confidence / EV floor)")
    b2 = b.assign(cfg=b.side + " / " + b.conf.astype(str) + " / " + b.tau.astype(str))
    print(b2.pivot_table(index="market", columns="innerCut", values="cfg",
                         aggfunc="first").reindex(ORDER).to_string())


if __name__ == "__main__":
    main()
