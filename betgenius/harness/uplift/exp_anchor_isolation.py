"""E22: isolate the price anchor from the EV floor it was confounded with.

Round 3 rejected the anchored architecture (E21) and said so honestly, but its
own write-up records why the rejection could not be final:

    "arm C's search also moved the EV floor from 0.00 to 0.04, so the
     batter_hits collapse is not cleanly attributable to the anchor. The anchor
     is confounded with a tighter floor. Isolating it needs a fresh
     pre-registration, not a re-reading of this one."

`reports/hybrid_anchored.csv` shows the confound is mechanical, not incidental.
The anchor pulls the model toward the price, which COMPRESSES the EV
distribution; an EV floor of 0.04 then bites on a distribution that no longer
reaches 0.04. Arm C's boards are 3.5x to 60x smaller than arm A's on the same
market and the same window -- `pitcher_strikeouts` 571 -> 9, `batter_hits`
253 -> 71, `totals` 261 -> 0. That is the floor doing the cutting, not the
anchor doing the choosing, and no conclusion about the anchor survives it.

So this file builds every cell of the grid TWICE, anchor off and anchor on, and
reports the difference at MATCHED settings. Two readings come out of one run:

  free      each arm searches the whole grid on SELECT-A and is scored on
            SELECT-B. Reproduces round 3's comparison, confound included.
  matched   anchor ON minus anchor OFF in the same (spec, EV floor, collapse)
            cell, on SELECT-B. This is the isolation, and it is what E22 is
            judged on.

Nothing here reads the verdict window. The latest timestamp this file touches is
the SELECT/VERDICT cut, used only as an upper bound: SELECT-B ends there.

    python harness/uplift/exp_anchor_isolation.py [--jobs=N] [--tag=_e22]
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
import hybrid
import mlbgate as G
import policy
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = run_final.ORDER
QUANTILES = (0.5, 0.6, 0.7)
STRONG = ("batter_hits", "batter_rbis", "batter_total_bases", "batter_strikeouts")
CONF = 60                       # the production contract; never searched


def specs():
    out = []
    for r in (1, 2, 3):
        out.extend(itertools.combinations(run_final.MEMBERS, r))
    return out


def prob(c, spec):
    return np.nanmean(np.vstack([c["probs"][s] for s in spec]), axis=0)


def halves(c):
    scored = c["frame"][np.isfinite(c["probs"]["price"])]
    return scored["commenceTime"].quantile(0.5)


def gate_of(f, mask, lo, hi):
    """mlbgate.verdict on a fast-path board; bootstrap only below the n floor."""
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
    """Every (arm, cut, spec, tau, collapse) cell for one market.

    Returns a list of row dicts. One market per worker: the cache is the big
    object and this way each process holds exactly one.
    """
    c = build_cache.load(market)
    if c is None:
        return []
    cut = halves(c)
    par = policy.parity_for(market)
    t = c["frame"]["commenceTime"]
    ok = np.isfinite(c["probs"]["price"])
    subcuts = {q: t[ok & (t < cut)].quantile(q) for q in QUANTILES}

    rows = []
    for spec in specs():
        p_off = prob(c, spec)
        p_on = hybrid.blend_arrays(c, p_off)
        for arm, p in (("off", p_off), ("on", p_on)):
            for col in run_final.COLLAPSE:
                f = boardfast.Fast(c, p, col)
                for tau in run_final.TAUS:
                    # SELECT-A gate/units for the free reading, per cut
                    for q in QUANTILES:
                        sub = subcuts[q]
                        # side chosen on SELECT-A only, exactly as run_final does
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
                            side=best or "both",
                            aN=sa["n"], aUnits=round(sa["units"], 2), aPass=int(gp),
                            bN=sb["n"],
                            bRoi=round(sb["roi"], 3) if sb["n"] else np.nan,
                            bUnits=round(sb["units"], 2)))
                del f
    return rows


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_e22")
    jobs = int(next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--jobs=")), 11))

    print(f"E22: anchor isolation. {len(specs())} specs x {len(run_final.TAUS)} EV floors"
          f" x {len(run_final.COLLAPSE)} collapses x {len(QUANTILES)} inner cuts"
          f" x 2 arms x {len(ORDER)} markets", flush=True)

    if jobs > 1:
        import multiprocessing as mp
        with mp.Pool(min(jobs, len(ORDER))) as pool:
            out = pool.map(one_market, ORDER)
    else:
        out = [one_market(m) for m in ORDER]
    d = pd.DataFrame([r for sub in out for r in sub])
    path = os.path.join(REPORTS, f"anchor_isolation{tag}.csv")
    d.to_csv(path, index=False)
    print(f"{len(d):,} cells -> {path}", flush=True)
    report(d)


def report(d):
    pd.set_option("display.width", 250)

    # ---- self-check: a price-only spec cannot be moved by a price anchor -----
    po = d[d.spec == "price"].pivot_table(
        index=["innerCut", "market", "tau", "collapse"], columns="arm",
        values=["bN", "bUnits"])
    same = bool(np.allclose(po[("bN", "off")], po[("bN", "on")]) and
                np.allclose(po[("bUnits", "off")].fillna(0),
                            po[("bUnits", "on")].fillna(0)))
    print(f"\nself-check -- anchoring the price to itself is a no-op: {same}")

    # ------------------------- the MATCHED reading ---------------------------
    key = ["innerCut", "market", "spec", "tau", "collapse"]
    w = d.pivot_table(index=key, columns="arm", values=["bN", "bUnits", "bRoi"])
    w = w.reset_index()
    w.columns = ["_".join(x).strip("_") for x in w.columns]
    w["dUnits"] = w["bUnits_on"] - w["bUnits_off"]
    w["dN"] = w["bN_on"] - w["bN_off"]

    print("\n" + "=" * 100)
    print("MATCHED READING -- anchor ON minus anchor OFF in the SAME cell, on held-out SELECT-B")
    print("=" * 100)
    for tau in sorted(d.tau.unique()):
        s = w[w.tau == tau]
        print(f"  EV floor {tau:<5}  cells {len(s):5,}   "
              f"units off {s.bUnits_off.sum():9.1f}   on {s.bUnits_on.sum():9.1f}   "
              f"delta {s.dUnits.sum():+9.1f}   "
              f"board rows off {int(s.bN_off.sum()):8,} on {int(s.bN_on.sum()):8,}")

    t0 = w[w.tau == 0.0]
    print("\n--- per market, at EV floor 0.00 (the matched setting E22 is judged on) ---")
    pm = t0.groupby("market").agg(
        cells=("dUnits", "size"),
        nOff=("bN_off", "sum"), nOn=("bN_on", "sum"),
        unitsOff=("bUnits_off", "sum"), unitsOn=("bUnits_on", "sum"),
        dUnits=("dUnits", "sum"),
        cellsAnchorWins=("dUnits", lambda s: int((s > 0).sum())))
    pm["roiOff"] = 100 * pm.unitsOff / pm.nOff.replace(0, np.nan)
    pm["roiOn"] = 100 * pm.unitsOn / pm.nOn.replace(0, np.nan)
    pm = pm.reindex([m for m in ORDER if m in pm.index])
    print(pm.round(2).to_string())

    nwin = int((pm.dUnits > 0).sum())
    print(f"\nCONDITION 1  pooled units at floor 0.00: "
          f"off {t0.bUnits_off.sum():.1f}  on {t0.bUnits_on.sum():.1f}  "
          f"-> {'PASS' if t0.bUnits_on.sum() > t0.bUnits_off.sum() else 'FAIL'}")
    print(f"CONDITION 2  markets improved at floor 0.00: {nwin} / {len(pm)}  "
          f"(need >= 6) -> {'PASS' if nwin >= 6 else 'FAIL'}")

    # ------------------------- the FREE reading ------------------------------
    print("\n" + "=" * 100)
    print("FREE READING -- each arm searches the grid on SELECT-A, scored on SELECT-B")
    print("=" * 100)
    free = []
    for arm in ("off", "on"):
        for q in QUANTILES:
            s = d[(d.arm == arm) & (d.innerCut == q)]
            agg = (s.groupby(["spec", "tau", "collapse", "nMembers"])
                    .agg(selectPasses=("aPass", "sum"), selectUnits=("aUnits", "sum"))
                    .reset_index()
                    .sort_values(["selectPasses", "selectUnits", "nMembers"],
                                 ascending=[False, False, True]))
            top = agg.iloc[0]
            pick = s[(s.spec == top.spec) & (s.tau == top.tau) &
                     (s.collapse == top.collapse)]
            free.append(pick.assign(chosenSpec=top.spec, chosenTau=top.tau,
                                    chosenCollapse=top.collapse))
    fr = pd.concat(free)
    print(fr.drop_duplicates(["arm", "innerCut"])[
        ["arm", "innerCut", "chosenSpec", "chosenTau", "chosenCollapse"]].to_string(index=False))
    g = fr.dropna(subset=["bRoi"]).groupby("arm").agg(
        splits=("market", "size"), inProfit=("bRoi", lambda s: int((s > 0).sum())),
        heldOutN=("bN", "sum"), heldOutUnits=("bUnits", "sum"),
        medianRoi=("bRoi", "median"))
    print("\n--- pooled ---")
    print(g.round(2).to_string())

    # --------------------- CONDITION 3, regression guard ---------------------
    print("\n--- CONDITION 3, the four strong markets (regression guard) ---")
    for label, frame in (("free", fr), ):
        st = frame[frame.market.isin(STRONG)].dropna(subset=["bRoi"])
        gg = st.groupby("arm").agg(splits=("bRoi", "size"),
                                   inProfit=("bRoi", lambda s: int((s > 0).sum())),
                                   units=("bUnits", "sum"),
                                   medianRoi=("bRoi", "median"))
        print(f"[{label}]")
        print(gg.round(2).to_string())
    stm = t0[t0.market.isin(STRONG)]
    off_prof = int((stm.bRoi_off > 0).sum())
    on_prof = int((stm.bRoi_on > 0).sum())
    print(f"[matched, floor 0.00] strong-market cells in profit: "
          f"off {off_prof}/{len(stm)}   on {on_prof}/{len(stm)}")

    print("\n--- per market x EV floor, matched delta in held-out units ---")
    print(w.pivot_table(index="market", columns="tau", values="dUnits",
                        aggfunc="sum").reindex(ORDER).round(1).to_string())


if __name__ == "__main__":
    main()
