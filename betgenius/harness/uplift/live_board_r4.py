"""Generate and evaluate the CURRENT production board under the locked Round 4 config.

AUDIT / OBSERVATION ONLY. Nothing here chooses, tunes or changes anything:

  * every filter parameter is READ from reports/final_r4v.csv -- the shipped
    Round 4 run -- and none is searched, swept or overridden here;
  * the board is built by policy.board and graded by mlbgate.grade, the same two
    functions the headline table uses;
  * results are reported by settlement status, and a window whose outcomes are
    already settled is labelled as what it is: a slice of the historical
    out-of-sample period, NOT post-deployment evidence.

What "live" can and cannot mean in this project
-----------------------------------------------
The uplift harness is a BACKTEST harness. build_cache.build calls
features.graded(d), which keeps only rows whose outcome has settled, and
policy.walkforward needs overHit to fit anything at all. There is therefore no
code path in this harness that scores a game that has not finished, and no
persisted estimator to score one with. The most recent board it can produce is
the most recent SETTLED slate in the packaged snapshot.

    python harness/uplift/live_board_r4.py [--tag=_r4v] [--windows=1,7,30]
"""
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
import run_final

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_r4v")
    windows = [int(x) for x in next(
        (a.split("=")[1] for a in sys.argv[1:] if a.startswith("--windows=")),
        "1,7,30").split(",")]

    gen_at = pd.Timestamp.utcnow()
    cfg = pd.read_csv(os.path.join(REPORTS, "final" + tag + ".csv"))

    box = frames.load_box()
    per_window = []

    # PASS 1 -- the snapshot's own latest slate date, shared by every market.
    # Windowing each market from its OWN last date would silently compare a
    # September slate against a June one; the board a desk would see on the last
    # available day is a single date, and a market that stopped being offered
    # before it must show zero rather than be back-dated.
    prepared = {}
    snap_last = None
    for _, r in cfg.iterrows():
        m = r["market"]
        c = build_cache.load(m)
        if c is None:
            print("cache missing for " + m)
            continue
        priced = frames.load_candidates(m, box)
        priced["game_date"] = priced["game_date"].astype(str).str[:10]
        prepared[m] = (c, priced)
        lm = priced["game_date"].max()
        snap_last = lm if snap_last is None else max(snap_last, lm)
        print("  loaded " + m + "  last=" + str(lm))
        sys.stdout.flush()
    print("snapshot latest slate date: " + str(snap_last))
    sys.stdout.flush()

    # PASS 2 -- the board, windowed from the shared date
    for _, r in cfg.iterrows():
        m = r["market"]
        if m not in prepared:
            continue
        c, priced = prepared[m]

        spec = tuple(str(r["spec"]).split("+"))
        side = None if r["side"] == "both" else r["side"]
        p = run_final.prob(c, spec)
        sel = policy.board(c["frame"], p, tau=float(r["tau"]),
                           one_per=policy.unit_key(m), side=side,
                           parity=r["parity"], min_conf=int(r["minConf"]),
                           collapse=str(r["collapse"]))
        if len(sel):
            sel["game_date"] = sel["game_date"].astype(str).str[:10]

        f = c["frame"].copy()
        f["game_date"] = f["game_date"].astype(str).str[:10]
        f["_p"] = p
        last = snap_last
        market_last = priced["game_date"].max()

        for w in windows:
            lo = (pd.Timestamp(last) - pd.Timedelta(days=w - 1)).strftime("%Y-%m-%d")
            pw = priced[priced["game_date"] >= lo]
            fw = f[f["game_date"] >= lo]
            sw = sel[sel["game_date"] >= lo] if len(sel) else sel
            if len(sw):
                shipped = (G.ev_filtered_mask(sw) if r["parity"] == "ev_filtered"
                           else G.ev_pass_mask(sw))
                nship = int(shipped.sum())
            else:
                nship = 0
            pv = fw["_p"].to_numpy(float)
            valid = int(np.isfinite(pv).sum())
            conf_all = np.round(100 * np.maximum(pv, 1 - pv))
            met = (G.grade(sw) if len(sw) else
                   dict(graded=0, roiPct=np.nan, units=0.0, winRatePct=np.nan,
                        roiCiLoPct=np.nan))
            pending = int(sw["hit"].isna().sum()) if len(sw) else 0
            per_window.append(dict(
                window_days=w, market=m, from_date=lo, to_date=last,
                events=int(pw["game_pk"].nunique()),
                priced_candidates=int(len(pw)),
                graded_candidates=int(len(fw)),
                valid_candidates=valid,
                predictions=valid,
                confidence_60=int(np.nansum(conf_all >= int(r["minConf"]))),
                eligible=int(len(sw)),
                selected=int(len(sw)),
                rejected=int(len(fw) - len(sw)),
                unservable=int(len(sw) - nship),
                missing_outcome=int(len(pw) - len(fw)),
                outcome_status=("SETTLED" if len(sw) and pending == 0
                                else ("PENDING" if pending else "NO_BOARD_ROWS")),
                pending_rows=pending,
                n=met["graded"],
                win_pct=round(met["winRatePct"], 2) if met["graded"] else np.nan,
                roi=round(met["roiPct"], 2) if met["graded"] else np.nan,
                roi_ci_lo=round(met["roiCiLoPct"], 2) if met["graded"] else np.nan,
                units=round(met["units"], 2) if met["graded"] else 0.0,
                gate=(G.verdict(met)[0] if met["graded"] else "NO_DATA"),
                market_last_priced_date=market_last,
                side_policy=r["side"], model=r["spec"], parity=r["parity"],
                conf_floor=int(r["minConf"]), ev_floor=float(r["tau"])))
        print("  done " + m)
        sys.stdout.flush()

    d = pd.DataFrame(per_window)
    d.to_csv(os.path.join(REPORTS, "live_production_results_r4.csv"), index=False)

    L = []
    A = L.append
    A("BETGENIUS ROUND 4 FINAL -- CURRENT PRODUCTION / LIVE BOARD EVALUATION")
    A("=" * 78)
    A("Board generated (UTC)      : " + gen_at.isoformat())
    A("Data snapshot directory    : " + frames.DATA)
    A("Member cache directory     : " + build_cache.CACHE)
    A("Configuration read from    : reports/final" + tag + ".csv  (locked Round 4, unmodified)")
    A("Latest event date in data  : " + str(snap_last))
    A("Markets configured         : " + str(len(cfg)))
    A("")
    A("SETTLEMENT STATUS")
    A("-" * 78)
    tot_pending = int(d["pending_rows"].sum())
    A("Board rows with an unsettled outcome, all windows: " + str(tot_pending))
    if tot_pending == 0:
        A("Every board row the Round 4 pipeline can produce is already SETTLED.")
        A("No realized live-market PASS/FAIL result can be computed from an unsettled")
        A("board, because this harness produces no unsettled board rows: the candidate")
        A("loader keeps only rows whose outcome exists (frames.load_candidates) and the")
        A("cache builder keeps only graded rows (features.graded). See section 30 of")
        A("AUDIT_COMPLETE.txt.")
    A("")
    for w in windows:
        s = d[d.window_days == w]
        A("WINDOW: last " + str(w) + " day(s) of available data  ("
          + str(s["from_date"].min()) + " -> " + str(s["to_date"].max()) + ")")
        A("-" * 78)
        A("  games (max over markets)  " + format(int(s["events"].max()), ","))
        A("  markets with board rows   " + str(int((s["selected"] > 0).sum())) + " / " + str(len(s)))
        A("  priced candidate rows     " + format(int(s["priced_candidates"].sum()), ","))
        A("  graded candidate rows     " + format(int(s["graded_candidates"].sum()), ","))
        A("  model predictions         " + format(int(s["predictions"].sum()), ","))
        A("  confidence >= floor       " + format(int(s["confidence_60"].sum()), ","))
        A("  selected (board rows)     " + format(int(s["selected"].sum()), ","))
        A("  rejected by the filter    " + format(int(s["rejected"].sum()), ","))
        A("  unservable in production  " + format(int(s["unservable"].sum()), ","))
        A("  rows missing an outcome   " + format(int(s["missing_outcome"].sum()), ","))
        tot = s[s.n > 0]
        if len(tot):
            u = float(tot["units"].sum())
            n = int(tot["n"].sum())
            A("  settled picks             " + format(n, ",") + "   units "
              + format(u, "+.2f") + "   pooled ROI " + format(100.0 * u / n, "+.2f") + "%")
        A("")
        cols = ["market", "market_last_priced_date", "events", "priced_candidates",
                "predictions", "confidence_60", "selected", "unservable",
                "outcome_status", "n", "win_pct", "roi", "units", "gate"]
        A(s[cols].to_string(index=False))
        A("")
        settled = s[s.n > 0]
        A("  LIVE MARKETS WITH SETTLED RESULTS : " + str(len(settled)) + "/" + str(len(s)))
        A("  LIVE MARKETS PASSING OFFICIAL GATE: "
          + str(int((settled.gate == "PASS").sum())) + "/" + str(len(s))
          + "   (see the caveat below -- n is far under the gate's floor)")
        A("  LIVE MARKETS FAILING OFFICIAL GATE: "
          + str(int((settled.gate == "FAIL").sum())) + "/" + str(len(s)))
        A("  LIVE MARKETS PENDING              : "
          + str(int((s.pending_rows > 0).sum())) + "/" + str(len(s)))
        A("  LIVE MARKETS WITH NO BOARD ROWS   : "
          + str(int((s.selected == 0).sum())) + "/" + str(len(s)))
        A("")
    A("CAVEAT ON THE GATE COLUMN")
    A("-" * 78)
    A("The gate column applies the shipped rule (n>=500 -> ROI>0, else 95% CI lower")
    A("bound > 0) mechanically to each window. On a 1-, 7- or 30-day window no market")
    A("reaches n=500, so every evaluation falls on the CI arm, where a handful of picks")
    A("cannot produce a meaningful interval. These per-window gate values are NOT a")
    A("market verdict and must never be quoted as one. The market verdicts are in")
    A("results/final_matrix_r4v.csv and nowhere else.")
    A("")
    A("THESE WINDOWS ARE NOT POST-DEPLOYMENT EVIDENCE")
    A("-" * 78)
    A("Every date above falls inside the Round 4 out-of-sample period that produced the")
    A("headline table, and for most markets inside the verdict window itself. The rows")
    A("are therefore already counted in the historical result. They are reported here")
    A("to show what the production board LOOKS LIKE on the most recent available data --")
    A("coverage, volume, serving status -- not to add an independent result.")
    txt = "\n".join(L)
    open(os.path.join(REPORTS, "live_summary_r4.txt"), "w", encoding="utf-8").write(txt)
    print(txt)


if __name__ == "__main__":
    main()
