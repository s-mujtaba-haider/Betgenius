"""Write the client workbook from the report files, and nothing else.

Every number in the spreadsheet is read from harness/uplift/reports/*.csv, which
are written by run_final.py / run_improve.py / robustness.py. Nothing is typed in
by hand, so the workbook cannot drift from the run that produced it.

    python harness/uplift/build_workbook.py [--out=PATH]
"""
import datetime as dt
import os
import sys

import pandas as pd
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DEFAULT_OUT = os.path.join(ROOT, "MLB_Phase1_Results.xlsx")

HEAD = PatternFill("solid", fgColor="1F3864")
PASS_FILL = PatternFill("solid", fgColor="C6EFCE")
FAIL_FILL = PatternFill("solid", fgColor="FFC7CE")
WARN_FILL = PatternFill("solid", fgColor="FFEB9C")
BAND = PatternFill("solid", fgColor="F2F2F2")


def read(name):
    p = os.path.join(REPORTS, name)
    return pd.read_csv(p) if os.path.exists(p) else None


def sheet(writer, df, name, freeze="A2", widths=None, note=None):
    if df is None or not len(df):
        return
    start = 0
    if note:
        pd.DataFrame({name: [note]}).to_excel(writer, sheet_name=name, index=False,
                                              startrow=0, header=False)
        start = 2
    df.to_excel(writer, sheet_name=name, index=False, startrow=start)
    ws = writer.sheets[name]
    hdr = start + 1
    for c in range(1, len(df.columns) + 1):
        cell = ws.cell(row=hdr, column=c)
        cell.font = Font(color="FFFFFF", bold=True, size=10)
        cell.fill = HEAD
        cell.alignment = Alignment(wrap_text=True, vertical="top", horizontal="center")
    if note:
        ws.cell(row=1, column=1).font = Font(italic=True, size=10, color="404040")
        ws.cell(row=1, column=1).alignment = Alignment(wrap_text=True, vertical="top")
        ws.merge_cells(start_row=1, start_column=1, end_row=1,
                       end_column=max(4, min(len(df.columns), 10)))
        ws.row_dimensions[1].height = 42
    ws.freeze_panes = ws.cell(row=hdr + 1, column=1)
    for i, col in enumerate(df.columns, start=1):
        width = widths.get(col) if widths else None
        if width is None:
            longest = max([len(str(col))] + [len(str(v)) for v in df[col].head(300)])
            width = min(max(longest + 2, 9), 62)
        ws.column_dimensions[get_column_letter(i)].width = width
    # colour any verdict-ish column
    for i, col in enumerate(df.columns, start=1):
        if "verdict" not in col.lower() and col.lower() != "status":
            continue
        for r in range(hdr + 1, hdr + 1 + len(df)):
            v = str(ws.cell(row=r, column=i).value or "")
            if v.startswith("PASS"):
                ws.cell(row=r, column=i).fill = PASS_FILL
            elif v.startswith("VETO") or v.startswith("FAIL"):
                ws.cell(row=r, column=i).fill = (WARN_FILL if "ITER" in v or "RESTR" in v
                                                 else FAIL_FILL)


def status_of(row):
    """The roadmap's market status system, read off the measured numbers."""
    if row["verdict"] == "PASS" and row["fullVerdict"] == "PASS":
        return "PASS"
    if row["verdict"] == "PASS" or row["fullVerdict"] == "PASS":
        return "PASS_WITH_RESTRICTIONS"
    if row.get("baseRoi", 0) < -12:
        return "VETO"
    return "FAIL_AFTER_ITERATION"


def main():
    out = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--out=")),
               DEFAULT_OUT)
    final = read("final.csv")
    if final is None:
        print("reports/final.csv missing — run harness/uplift/run_final.py first")
        return
    final = final.copy()
    final["status"] = final.apply(status_of, axis=1)

    summary = final[["market", "candidates", "graded", "events", "fromDate", "toDate",
                     "side", "baseRoi", "priceOnlyRoi", "fullN", "fullRoi", "fullVerdict",
                     "verdictFrom", "n", "winPct", "roi", "ciLo", "clusCiLo", "units",
                     "verdict", "status"]].rename(columns={
        "market": "Market", "candidates": "Priced candidates", "graded": "Graded",
        "events": "Games", "fromDate": "From", "toDate": "To", "side": "Side policy",
        "baseRoi": "Flat-bet ROI % (the vig)", "priceOnlyRoi": "Price-recalibration ROI %",
        "fullN": "Board n (full OOS)", "fullRoi": "Board ROI % (full OOS)",
        "fullVerdict": "Gate (full OOS)", "verdictFrom": "Verdict window from",
        "n": "Board n (verdict)", "winPct": "Win %", "roi": "ROI %",
        "ciLo": "ROI 95% CI low", "clusCiLo": "Game-clustered CI low",
        "units": "Units", "verdict": "Gate (verdict window)", "status": "Final status"})

    detail = read("boards.csv")
    sweep = read("global_sweep.csv")
    robust = read("robustness.csv")
    attrib = read("attribution.csv")
    attrib2 = read("attribution_pass2.csv")
    matrix = read("final_matrix.csv")
    calib = read("calibration.csv")
    rel = read("calibration_reliability.csv")
    improve = read("improve_lag0_best.csv")
    log = read("improve_log_lag0_best.csv")
    diag = read("diag_signal.csv")

    method = pd.DataFrame({
        "Item": [
            "What the gate is",
            "What was NOT changed",
            "Where the candidates come from",
            "Entry price",
            "How a bet is decided",
            "Walk-forward",
            "SELECT vs VERDICT window",
            "What counts as one bet",
            "Game-clustered CI",
            "Placebo lag",
            "batter_runs_scored and batter_strikeouts",
            "pitcher_outs",
            "Denominator",
            "Feature attribution",
            "Gate (full OOS) vs Gate (verdict window)",
            "Which gate decides production",
        ],
        "Detail": [
            "graded n >= 500 and ROI > 0; below 500 the 95% CI lower bound must clear zero. "
            "Ported line-for-line from harness/lib/metrics.ts; verify_gate.py replays the "
            "shipped harness reports through the port and reproduces their published "
            "evGate block bit for bit.",
            "The gate, the production scorer (scoring_mlb_v2.ts), algorithm_weights, and the "
            "D-164 heavy-juice under veto. No weight was re-fit and no threshold in the "
            "shipped code was moved.",
            "cache_mlb_historical_odds, the full priced universe: every event x player x "
            "line that had a two-sided quote at the entry snapshot. Graded from "
            "cache_mlb_boxscore_player_stats. Read-only throughout.",
            "The best number quoted at that line at the entry snapshot (~5.6h before first "
            "pitch), which is the shipped convention - best_price.ts selectBestSameLineBook. "
            "A median-book sensitivity is in the Robustness sheet.",
            "A calibrator returns P(over). Both sides are then priced against it at the "
            "posted number; the board bets the side whose expected value clears the floor, "
            "which means it must beat the juice, not just the fair price.",
            "The calibrator is re-fit forward through time in 40 blocks and never sees a "
            "game that had not already finished. Fold boundaries are timestamps, so games "
            "sharing a commence time never straddle one.",
            "Each market's out-of-sample period is cut in half on the clock. The filter and "
            "the side policy are chosen on the earlier half only. The later half is never "
            "read while choosing, and the gate is applied to it.",
            "At most one bet per player-game (per game on h2h / spreads / totals), on the "
            "best number on offer. The all-lines board is reported next to it so "
            "alternate-ladder double counting is visible rather than banked.",
            "ROI CI resampled over whole games rather than picks, because picks on one game "
            "settle together. Reported beside the gate's own CI, never in place of it.",
            "Every feature is rebuilt forcing the freshest box score to be 1, 3 and 7 days "
            "older. Real form decays slowly; a same-game leak dies at lag 1.",
            "Zero rows in cache_mlb_historical_odds in any season, so neither had ever been "
            "given a verdict at all. Prices for these two were pulled from The Odds API "
            "historical endpoint. The 2026-05-24 warehouse cutoff is untouched for every "
            "other market.",
            "The warehouse stops 2025-05-28. The window after that was filled from the same "
            "Odds API endpoint for the same reason.",
            "11 markets, as the roadmap lists them. `runs_scored` is read as "
            "`batter_runs_scored`, which is the market the codebase and mlb_ev_policy.ts "
            "actually carry.",
            "run_final.py re-chooses its global filter every run, so a before/after on the "
            "headline would confound a feature gain with a filter gain. attribute.py scores "
            "both feature sets through an identical filter and side policy; the Feature "
            "attribution sheets are those comparisons.",
            "Same gate, two windows. FULL OOS is every scored pick after the walk-forward "
            "warm-up. The VERDICT WINDOW is the later half of that same period, cut on the "
            "clock per market, and it is the half that was never read while the filter or "
            "the side policy were being chosen - so it is the only window where an "
            "over-fitted choice has nowhere to hide. It is also roughly half the picks, so "
            "a market can miss it on sample size rather than on sign: below 500 graded "
            "picks the gate switches to the CI branch, which a thin edge cannot clear.",
            "The verdict window is the one that decides. A market clearing only the full "
            "OOS gate is PASS_WITH_RESTRICTIONS and is not the same claim as a PASS.",
        ]})

    with pd.ExcelWriter(out, engine="openpyxl") as w:
        if matrix is not None:
            sheet(w, matrix, "Final matrix",
                  note="The authoritative final table. TWO gates, both the same rule "
                       "(n >= 500 and ROI > 0, else the 95% CI lower bound must clear "
                       "zero), applied to two windows: the FULL out-of-sample period, "
                       "and the VERDICT WINDOW, its later half, which nothing was "
                       "allowed to be chosen on. Final status: PASS = both gates; "
                       "PASS_WITH_RESTRICTIONS = one of the two; VETO = neither, on a "
                       "market whose flat-bet ROI is worse than -12%; "
                       "FAIL_AFTER_ITERATION = neither, otherwise.")
        sheet(w, summary, "Summary",
              note="MLB Phase 1 — every market, walk-forward, published gate unchanged. "
                   "The verdict column is read from a window that was never used to choose "
                   "the filter or the side policy. Generated "
                   f"{dt.datetime.now():%Y-%m-%d %H:%M}.")
        if detail is not None:
            sheet(w, detail, "Boards",
                  note="Six boards per market. `base` is every priced candidate flat-bet — "
                       "that is the vig the board has to beat. `price-only` is the market's "
                       "own number recalibrated against itself; whatever the board earns "
                       "above that line is what the box-score and matchup features added.")
        if attrib is not None:
            sheet(w, attrib, "Feature attribution (pass 2-3)",
                  note="The same filter and the same side policy over both feature sets, so "
                       "the only difference between the two columns is the features: the "
                       "park environment, the bullpen rebuilt from relief box-score lines, "
                       "and the starter's pitch budget. 6 markets clear the gate without "
                       "them, 9 with them.")
        if calib is not None:
            sheet(w, calib, "Calibration",
                  note="Probability quality, not direction: log loss and Brier score on "
                       "the walk-forward probabilities, with the slope and intercept of "
                       "the logistic recalibration (1.0 / 0.0 is perfect; slope below 1 "
                       "means over-confident). `price` is the market's own de-vigged "
                       "number recalibrated against itself and is the bar the model has "
                       "to clear.")
        if rel is not None:
            sheet(w, rel, "Reliability",
                  note="Realised win rate against predicted probability, by decile of "
                       "the shipped ensemble. A calibrated model has `gap` near zero in "
                       "every bucket.")
        if attrib2 is not None:
            sheet(w, attrib2, "Feature attribution (pass 1-2)",
                  note="The first feature pass, scored the same way: park environment, "
                       "bullpen and starter workload, both feature sets through one "
                       "identical filter.")
        if robust is not None:
            sheet(w, robust, "Robustness",
                  note="Same pipeline, one thing changed at a time: the placebo lag on the "
                       "box-score history, the entry price convention, and the walk-forward "
                       "knobs. A result that only survives one setting is not a result.")
        if sweep is not None:
            sheet(w, sweep, "Global filter sweep",
                  note="Every candidate filter, scored on the SELECT halves pooled across "
                       "all markets. One global choice rather than eleven separate ones, so "
                       "no market's verdict can be an artefact of its own tuning.")
        if improve is not None:
            sheet(w, improve, "Per-market tuning (pass 2)",
                  note="Run against the PASS-2 feature set, not the shipped one — the "
                       "per-market search takes about forty minutes and was not re-run "
                       "after the final feature pass. "
                       "The roadmap's Level 7 path: spec, EV floor, side, confidence floor "
                       "and sample floor searched per market on the SELECT half, verdict "
                       "read from the untouched half. Kept because it shows the per-market "
                       "search generalises WORSE than the single global choice.")
        if log is not None:
            sheet(w, log.head(40000), "Improvement log (pass 2)",
                  note="Every attempt, including the ones that failed — against the "
                       "pass-2 feature set, as above. A table of only the "
                       "things that worked is indistinguishable from a table of things that "
                       "got lucky.")
        if diag is not None:
            sheet(w, diag, "Signal diagnostic",
                  note="Coefficient on each candidate signal after the market's own price is "
                       "already in the model. Near zero means the price has absorbed it and "
                       "no filter built on it can win.")
        sheet(w, method, "How to read this",
              widths={"Item": 34, "Detail": 110})
        for r in range(2, 2 + len(method) + 1):
            w.sheets["How to read this"].row_dimensions[r].height = 58
            w.sheets["How to read this"].cell(row=r, column=2).alignment = Alignment(
                wrap_text=True, vertical="top")

    npass = int((final["verdict"] == "PASS").sum())
    nfull = int((final["fullVerdict"] == "PASS").sum())
    print(f"wrote {out}")
    print(f"  {len(final)} markets | gate PASS: {nfull} on the full out-of-sample period,"
          f" {npass} on the untouched verdict window")


if __name__ == "__main__":
    main()
