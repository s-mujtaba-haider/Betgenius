"""E32 -- a volume guard on the per-market side lever.

`run_final.choose_side` maximises SELECT units over five side policies with no
volume constraint at all. On the expanded dataset that flipped
`batter_total_bases` from `under` to `over` and took its full-OOS board from
3,285 rows to 409 -- a 92% collapse out of 116,642 graded candidates. A side
surviving on that sliver was chosen because the sliver ran hot, which is exactly
the failure mode a held-out test exists to catch.

The guard: a side is eligible only if its SELECT-A board keeps at least `f` of
the both-sides board. If nothing qualifies, fall back to `both` -- the largest
board and the conservative direction. The objective is unchanged (SELECT-A
units), so the guard is the only difference between the arms.

`f` is swept over {0.25, 0.40, 0.50} and the result must hold at all three. A
guard that works at one value only is a threshold fitted to noise.

Scored by the SHIPPED gate on held-out SELECT-B. The verdict window is not read.

    python harness/uplift/exp_side_guard.py [--jobs=N] [--tag=_e32]
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
FRACTIONS = (0.25, 0.40, 0.50)
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")
CONF = 60


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


def stage1(market):
    """SELECT-A gate/units per (cut, spec, tau, collapse) for the global choice."""
    c = build_cache.load(market)
    if c is None:
        return []
    cut = halves(c)
    t = c["frame"]["commenceTime"]
    ok = np.isfinite(c["probs"]["price"])
    sub = {q: t[ok & (t < cut)].quantile(q) for q in QUANTILES}
    par = policy.parity_for(market)
    rows = []
    for spec in specs():
        p = prob(c, spec)
        for col in run_final.COLLAPSE:
            f = boardfast.Fast(c, p, col)
            for tau in run_final.TAUS:
                mask = f.board_mask(tau, None, CONF, par)
                for q in QUANTILES:
                    gp, s = gate_of(f, mask, None, sub[q])
                    rows.append(dict(market=market, innerCut=q, spec="+".join(spec),
                                     nMembers=len(spec), tau=tau, collapse=col,
                                     aPass=int(gp), aUnits=s["units"], aN=s["n"]))
            del f
    return rows


def choose_global(g):
    r = (g[g.aN >= run_final.MIN_SELECT_N]
         .groupby(["spec", "tau", "collapse", "nMembers"])
         .agg(selectPasses=("aPass", "sum"), selectUnits=("aUnits", "sum"))
         .reset_index()
         .sort_values(["selectPasses", "selectUnits", "nMembers"],
                      ascending=[False, False, True]))
    t = r.iloc[0]
    return tuple(t["spec"].split("+")), float(t["tau"]), str(t["collapse"])


def stage2(args):
    market, chosen = args
    c = build_cache.load(market)
    if c is None:
        return []
    cut = halves(c)
    t = c["frame"]["commenceTime"]
    ok = np.isfinite(c["probs"]["price"])
    sub = {q: t[ok & (t < cut)].quantile(q) for q in QUANTILES}
    par = policy.parity_for(market)
    rows = []
    for q in QUANTILES:
        spec, tau, col = chosen[q]
        f = boardfast.Fast(c, prob(c, spec), col)
        both_n = f.score(f.board_mask(tau, None, CONF, par), None, sub[q])["n"]
        cand = []
        for side in run_final.SIDES:
            s = f.score(f.board_mask(tau, side, CONF, par), None, sub[q])
            cand.append(dict(side=side, n=s["n"], units=s["units"]))
        cd = pd.DataFrame(cand)

        def pick(frac):
            e = cd[(cd.n >= run_final.MIN_SELECT_N) &
                   (cd.n >= frac * max(both_n, 1))] if frac else \
                cd[cd.n >= run_final.MIN_SELECT_N]
            if e.empty:
                return None
            e = e.assign(isNone=e.side.isna()).sort_values(
                ["units", "isNone"], ascending=[False, False])
            return e.iloc[0]["side"]

        arms = {"A:unguarded": pick(None)}
        for fr in FRACTIONS:
            arms[f"B:guard{fr:.2f}"] = pick(fr)
        for arm, side in arms.items():
            mask = f.board_mask(tau, side, CONF, par)
            _, sa = gate_of(f, mask, None, sub[q])
            gp, sb = gate_of(f, mask, sub[q], cut)
            rows.append(dict(arm=arm, innerCut=q, market=market,
                             spec="+".join(spec), tau=tau, collapse=col,
                             side=side or "both", bothN=both_n, aN=sa["n"],
                             keepFrac=round(sa["n"] / max(both_n, 1), 3),
                             bN=sb["n"],
                             bRoi=round(sb["roi"], 3) if sb["n"] else np.nan,
                             bUnits=round(sb["units"], 2), bGatePass=int(gp)))
        del f
    return rows


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_e32")
    jobs = int(next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--jobs=")), 11))
    import multiprocessing as mp
    print("E32 stage 1: the global filter on SELECT-A", flush=True)
    with mp.Pool(min(jobs, len(ORDER))) as pool:
        s1 = pd.DataFrame([r for sub in pool.map(stage1, ORDER) for r in sub])
    chosen = {q: choose_global(s1[s1.innerCut == q]) for q in QUANTILES}
    for q in QUANTILES:
        sp, tg, cl = chosen[q]
        print(f"  cut {q}: spec={'+'.join(sp)} EV floor={tg} collapse={cl}", flush=True)

    print("\nE32 stage 2: the side lever, guarded and unguarded", flush=True)
    with mp.Pool(min(jobs, len(ORDER))) as pool:
        d = pd.DataFrame([r for sub in pool.map(stage2, [(m, chosen) for m in ORDER])
                          for r in sub])
    d.to_csv(os.path.join(REPORTS, f"side_guard{tag}.csv"), index=False)

    pd.set_option("display.width", 250)
    print("\n--- held-out SELECT-B gate PASS per market x arm (of 3 cuts) ---")
    print(d.pivot_table(index="market", columns="arm", values="bGatePass",
                        aggfunc="sum").reindex(ORDER).to_string())
    print("\n--- the side each arm chose, and the share of the both-sides board it keeps ---")
    print(d.pivot_table(index="market", columns="arm", values="keepFrac",
                        aggfunc="mean").reindex(ORDER).round(2).to_string())
    g = d.groupby("arm").agg(gatePasses=("bGatePass", "sum"),
                             inProfit=("bRoi", lambda s: int((s > 0).sum())),
                             heldOutN=("bN", "sum"), heldOutUnits=("bUnits", "sum"),
                             medianRoi=("bRoi", "median"))
    print("\n--- pooled ---")
    print(g.round(2).to_string())
    st = d[d.market.isin(STRONG)].groupby("arm").agg(
        gatePasses=("bGatePass", "sum"), units=("bUnits", "sum"),
        medianRoi=("bRoi", "median"))
    print("\n--- the four strong markets (regression guard) ---")
    print(st.round(2).to_string())

    base, sbase = int(g.loc["A:unguarded", "gatePasses"]), int(st.loc["A:unguarded", "gatePasses"])
    print("\n" + "-" * 100)
    allok = True
    for fr in FRACTIONS:
        arm = f"B:guard{fr:.2f}"
        c1 = int(g.loc[arm, "gatePasses"]) > base
        c2 = int(st.loc[arm, "gatePasses"]) >= sbase
        allok &= (c1 and c2)
        print(f"{arm}  gate passes {int(g.loc[arm,'gatePasses'])} vs {base} -> "
              f"{'PASS' if c1 else 'FAIL'}   strong {int(st.loc[arm,'gatePasses'])} vs "
              f"{sbase} -> {'PASS' if c2 else 'FAIL'}")
    print(f"\nE32 holds at ALL fractions: {allok}  ->  "
          f"{'ADOPT' if allok else 'REJECT'}")
    print(f"-> {os.path.join(REPORTS, f'side_guard{tag}.csv')}")


if __name__ == "__main__":
    main()
