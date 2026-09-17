"""THE round-3+ result: the incumbent pipeline plus ONE per-market override.

Everything here is `run_final.py` except for a single addition, and that
addition is a rule rather than a choice:

    After the global filter is chosen the usual way, each market may REPLACE the
    global ensemble with a single member -- but only if that member wins on
    SELECT-A and beats the global spec on held-out SELECT-B by more than the
    noise band, at ALL THREE inner cuts, with the SAME member chosen every time.

Why this is not eleven chances to fit noise
-------------------------------------------
E8 lost the bet that a per-market SPEC search generalises, and nothing here
re-opens it. The difference is what the override is decided on:

  * it is decided on **log loss**, a proper scoring rule computed over every
    scored row, not on board ROI over a few hundred rows the model selected
    using its own largest errors;
  * it must hold at **three** inner cuts with the same answer each time, so a
    member that wins once is discarded;
  * it must clear **0.0011**, the noise band E8/E16/E19 measured, not merely
    come first;
  * and the fallback is the global spec, so a market that fails any of those
    conditions is left exactly as `run_final.py` would leave it.

On the expanded dataset four markets qualify and seven do not. Three of the four
resolve to `price` -- the market's own recalibrated number, with the model
removed entirely. That is the same finding round 3 reported ("the model is worse
than the price on 9 of 11 markets"), arriving through an adoption test instead of
a diagnostic, and it is acted on here rather than noted.

The verdict window is not read while any of this is decided. SELECT-A chooses,
SELECT-B scores, and the verdict window is opened once at the end.

    python harness/uplift/run_final_r4.py --conf=60 --tag=_r4
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
import mlbgate as G
import policy
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = run_final.ORDER
QUANTILES = (0.5, 0.6, 0.7)
NOISE = 0.0011
# The members an override may resolve to. The shipped six plus the round-3+
# families; every one of them is a walk-forward member already in the cache, so
# an override changes which probability the board reads and nothing else.
OVERRIDE_POOL = ("price", "compact", "box", "gbm", "offset", "iso",
                 "rf", "et", "gbmB", "gbmC", "gbmD")
# --pairs (E33) widens the candidate set from the 11 single members to all 1- and
# 2-member averages of them, 66 in total. Not 3-member: 231 candidates across 11
# markets is more chances to fit noise than the three guards can absorb, and E16
# settled that widening a pool without adding information is pure overfit risk.
PAIRS = "--pairs" in sys.argv


def candidates(have):
    mems = [m for m in OVERRIDE_POOL if m in have]
    out = [(m,) for m in mems]
    if PAIRS:
        out += list(itertools.combinations(mems, 2))
    return out


def logloss(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def select_board_n(c, combo, tau, min_conf, collapse, cut):
    """Rows the SELECT half would hold if this member decided the board.

    The viability half of the override rule. A member that is better calibrated
    to the price DISAGREES with it less, and a prop board is exactly the set of
    rows where the model disagrees enough for EV to clear the floor -- so a
    better-calibrated member can win on log loss and leave no board at all.
    Overriding pitcher_strikeouts to `price` took its full-OOS board from 2,407
    rows to 1. Log loss cannot see that, because it scores every row while the
    gate scores only the selected ones.

    500 is EV_GATE_MIN_GRADED, the gate's own floor, not a tuned number, and
    SELECT and VERDICT are equal halves by construction -- so a SELECT board
    under 500 projects to a verdict board under 500. Computed on SELECT only.
    """
    sel = policy.board(c["frame"], run_final.prob(c, combo), tau=tau,
                       one_per=policy.unit_key(c["market"]), side=None,
                       parity=policy.parity_for(c["market"]), min_conf=min_conf,
                       collapse=collapse)
    return int((sel["commenceTime"] < cut).sum()) if len(sel) else 0


def choose_override(c, spec, tau, min_conf, collapse):
    """The per-market member override, decided on SELECT only.

    Two conditions, both necessary:
      1. the member wins on SELECT-A and beats the global spec on held-out
         SELECT-B by more than the noise band, with the SAME member at all three
         inner cuts;
      2. it still leaves a SELECT board of at least EV_GATE_MIN_GRADED rows.

    Returns (member or None, rows) -- None means "keep the global spec".
    """
    d = c["frame"]
    y = d["overHit"].astype(int).to_numpy()
    t = d["commenceTime"]
    ok = np.isfinite(c["probs"]["price"])
    cut = t[ok].quantile(0.5)
    base = run_final.prob(c, spec)
    picks, gains, rows = [], [], []
    for q in QUANTILES:
        sub = t[ok & (t < cut)].quantile(q)
        A = (ok & (t < sub).to_numpy())
        B = (ok & (t >= sub).to_numpy() & (t < cut).to_numpy())
        if A.sum() < 500 or B.sum() < 200:
            return None, rows
        cand = []
        for combo in candidates(c["probs"]):
            p = run_final.prob(c, combo)
            g = np.isfinite(p)
            a, b = A & g, B & g
            if a.sum() < 500 or b.sum() < 200:
                continue
            cand.append((logloss(p[a], y[a]), "+".join(combo), logloss(p[b], y[b])))
        if not cand:
            return None, rows
        cand.sort()
        _, mem, llB = cand[0]
        gb = np.isfinite(base)
        llB_base = logloss(base[B & gb], y[B & gb])
        picks.append(mem)
        gains.append(llB_base - llB)
        rows.append(dict(market=c["market"], innerCut=q, chosen=mem,
                         llB_chosen=round(llB, 6), llB_global=round(llB_base, 6),
                         gain=round(llB_base - llB, 6)))
    same = len(set(picks)) == 1
    beats = all(g > NOISE for g in gains)
    nsel = (select_board_n(c, tuple(picks[0].split("+")), tau, min_conf, collapse, cut)
            if same else 0)
    viable = nsel >= G.EV_GATE_MIN_GRADED
    keep = bool(same and beats and viable)
    for r in rows:
        r["sameAtAllCuts"] = same
        r["beatsNoiseAtAllCuts"] = beats
        r["selectBoardN"] = nsel
        r["viable"] = viable
        r["ADOPTED"] = keep
    return (picks[0] if keep else None), rows


def main():
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    tag = next((a.split("=")[1] for a in flags if a.startswith("--tag=")), "_r4")
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")
    warmup = float(next((a.split("=")[1] for a in flags if a.startswith("--warmup=")),
                        policy.WARMUP))
    blocks = int(next((a.split("=")[1] for a in flags if a.startswith("--blocks=")),
                      policy.N_BLOCKS))
    confs = ([int(next(a.split("=")[1] for a in flags if a.startswith("--conf=")))]
             if any(a.startswith("--conf=") for a in flags) else list(run_final.CONFS))

    caches = [build_cache.load(m, lag, price, warmup, blocks) for m in ORDER]
    missing = [m for m, c in zip(ORDER, caches) if c is None]
    caches = [c for c in caches if c]
    if missing:
        print(f"not in cache: {', '.join(missing)}")
    cuts = {c["market"]: run_final.halves(c) for c in caches}

    spec, tau, min_conf, collapse, sweep = run_final.choose_global(caches, cuts, confs)
    sweep.to_csv(os.path.join(REPORTS, f"global_sweep{tag}.csv"), index=False)
    print(f"global filter chosen on the SELECT halves: spec={'+'.join(spec)}  "
          f"EV floor={tau}  confidence floor={min_conf}  ladder collapse={collapse}")

    ov, ovrows = {}, []
    for c in caches:
        mem, rows = choose_override(c, spec, tau, min_conf, collapse)
        ovrows.extend(rows)
        if mem:
            ov[c["market"]] = mem
    pd.DataFrame(ovrows).to_csv(os.path.join(REPORTS, f"overrides{tag}.csv"), index=False)
    print(f"\nper-market member overrides adopted on SELECT (of {len(caches)} markets): "
          f"{len(ov)}")
    for m, mem in ov.items():
        print(f"    {m:20s} -> {mem}")
    print(f"    every other market keeps the global spec '{'+'.join(spec)}'")

    rows, detail = [], {}
    for c in caches:
        m, cut = c["market"], cuts[c["market"]]
        mspec = tuple(ov[m].split("+")) if m in ov else spec
        side = run_final.choose_side(c, mspec, tau, cut, min_conf, collapse)
        p = run_final.prob(c, mspec)
        base = c["frame"].copy()
        base["entryOdds"], base["hit"], base["voided"] = base["overOdds"], base["overHit"], False
        boards = [
            run_final.summarise(base, "base (every candidate, flat)"),
            run_final.summarise(run_final.board_of(c, ("price",), tau, side, cut, None,
                                                   min_conf, collapse),
                                "price-only (full OOS)"),
            run_final.summarise(run_final.board_of(c, mspec, tau, side, cut, None,
                                                   min_conf, collapse),
                                "board (full OOS)"),
            run_final.summarise(policy.board(c["frame"], p, tau=tau, one_per=None,
                                             side=side, parity=policy.parity_for(m),
                                             min_conf=min_conf),
                                "all-lines (full OOS)"),
            run_final.summarise(run_final.board_of(c, mspec, tau, side, cut, "select",
                                                   min_conf, collapse),
                                "board SELECT half"),
            run_final.summarise(run_final.board_of(c, mspec, tau, side, cut, "verdict",
                                                  min_conf, collapse),
                                "board VERDICT half"),
        ]
        detail[m] = boards
        b = {x["board"]: x for x in boards}
        v, f = b["board VERDICT half"], b["board (full OOS)"]
        rows.append(dict(
            market=m, candidates=c["candidates"], graded=c["graded"], events=c["events"],
            fromDate=c["fromDate"], toDate=c["toDate"],
            spec="+".join(mspec), override=(ov.get(m) or ""), globalSpec="+".join(spec),
            tau=tau, minConf=min_conf, collapse=collapse,
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
        print(f"\n=== {m}   graded {c['graded']:,}  member {'+'.join(mspec)}"
              f"{'  [OVERRIDE]' if m in ov else ''}  side {side or 'both'}")
        print(pd.DataFrame(boards)[["board", "n", "winPct", "roi", "ciLo", "clusCiLo",
                                    "units", "events", "verdict"]].to_string(index=False))
        sys.stdout.flush()

    r = pd.DataFrame(rows)
    r.to_csv(os.path.join(REPORTS, f"final{tag}.csv"), index=False)
    flat = pd.concat([pd.DataFrame(v).assign(market=k) for k, v in detail.items()])
    flat[["market", "board", "n", "winPct", "roi", "ciLo", "clusCiLo", "units",
          "events", "verdict", "why"]].to_csv(
        os.path.join(REPORTS, f"boards{tag}.csv"), index=False)
    json.dump(dict(generatedAt=pd.Timestamp.utcnow().isoformat(),
                   globalSpec="+".join(spec), overrides=ov, tau=tau, lag=lag,
                   price=price, summary=rows, detail=detail),
              open(os.path.join(REPORTS, f"final{tag}.json"), "w"), indent=1, default=str)

    print("\n" + "=" * 132)
    print("MLB ROUND 3+ FINAL. Verdict window = later half of the out-of-sample period,"
          " never used to choose the filter, the side or the override.")
    print(f"gate unchanged: n>=500 and ROI>0, else 95% CI lower bound>0    "
          f"global spec={'+'.join(spec)}  EV floor={tau}  conf floor={min_conf}"
          f"  collapse={collapse}  price={price}  placebo lag={lag}d")
    print("=" * 132)
    show = ["market", "graded", "spec", "override", "side", "fullN", "fullRoi",
            "fullVerdict", "verdictFrom", "n", "winPct", "roi", "ciLo", "clusCiLo",
            "units", "verdict"]
    print(r[show].to_string(index=False))
    npass = int((r["verdict"] == "PASS").sum())
    nfull = int((r["fullVerdict"] == "PASS").sum())
    both = r[(r["verdict"] == "PASS") & (r["fullVerdict"] == "PASS")]
    print(f"\nPASS on the untouched VERDICT window : {npass} / {len(r)}"
          f"   ({', '.join(r[r.verdict == 'PASS'].market)})")
    print(f"PASS on the full out-of-sample period: {nfull} / {len(r)}"
          f"   ({', '.join(r[r.fullVerdict == 'PASS'].market)})")
    print(f"PASS on BOTH gates                   : {len(both)} / {len(r)}"
          f"   ({', '.join(both.market)})")
    print(f"units on the verdict window: {r['units'].sum():.1f}"
          f"   |   units full OOS: {r['fullUnits'].sum():.1f}")


if __name__ == "__main__":
    main()
