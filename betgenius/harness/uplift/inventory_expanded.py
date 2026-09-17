"""The data inventory, measured from the actual files -- not from any log.

Runs against whichever dataset `UPLIFT_DATA_DIR` selects, so the same code
produces the before and after tables and the comparison is like for like:

    python harness/uplift/inventory_expanded.py --tag=base
    UPLIFT_DATA_DIR=.../data_expanded python harness/uplift/inventory_expanded.py --tag=exp

Every row of the funnel is counted at the point the pipeline actually applies
it, and the DID_NOT_PLAY / DATA_MISSING split is the one `frames.load_candidates`
now records: a null settled stat is a hole in the backfill, not a void, and the
two are no longer added together.
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")
ORDER = ["batter_hits", "batter_rbis", "totals", "spreads", "batter_total_bases",
         "batter_home_runs", "pitcher_strikeouts", "h2h", "batter_runs_scored",
         "pitcher_outs", "batter_strikeouts"]
SEASONS = [2023, 2024, 2025, 2026]


def yearly(ts):
    y = pd.to_datetime(ts, format="mixed", utc=True).dt.year.value_counts()
    return {f"y{s}": int(y.get(s, 0)) for s in SEASONS}


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "")
    print(f"DATA  -> {frames.DATA}")
    box = frames.load_box()
    print(f"box   -> {len(box):,} player-game rows, {box.game_pk.nunique():,} games, "
          f"{box.game_date.min()} -> {box.game_date.max()}\n")

    rows = []
    for m in ORDER:
        role, col, kind = frames.MARKETS[m]
        raw = frames.read_market(m)
        gd = box.drop_duplicates("game_pk").set_index("game_pk")["game_date"]
        c1 = raw.copy()
        c1["game_date"] = c1["game_pk"].map(gd)
        c1 = c1[c1["game_date"].notna()]
        c2 = c1[(c1["n_twoway"].fillna(0) > 0) & c1["p_fair_over"].notna()]
        c3 = c2[c2["imp_over_best"].notna() & c2["imp_under_best"].notna()]

        cand = frames.load_candidates(m, box)
        f = frames.LAST_FUNNEL.get(m, {})
        graded = cand[cand["overHit"].notna()]
        pushes = int(len(cand) - len(graded))

        r = dict(market=m,
                 rawOddsRows=len(raw),
                 matchedToGame=len(c1),
                 twoSided=len(c2),
                 bestPriceBothSides=len(c3),
                 idResolved=int(f.get("priced", len(c3))) if kind != "game" else len(c3),
                 didNotPlay=int(f.get("didNotPlay", 0)),
                 dataMissing=int(f.get("dataMissing", 0)),
                 withOutcome=len(cand),
                 pushes=pushes,
                 gradedRows=len(graded),
                 games=int(graded.game_pk.nunique()),
                 first=str(graded.game_date.min()), last=str(graded.game_date.max()))
        r.update(yearly(graded["commenceTime"]))
        rows.append(r)

    d = pd.DataFrame(rows)
    pd.set_option("display.width", 260)
    print("=" * 130)
    print("FUNNEL -- where priced rows go")
    print("=" * 130)
    print(d[["market", "rawOddsRows", "matchedToGame", "twoSided", "didNotPlay",
             "dataMissing", "withOutcome", "pushes", "gradedRows", "games"]].to_string(index=False))
    print("\n" + "=" * 130)
    print("GRADED MODEL ROWS BY SEASON  (the rows the model actually sees)")
    print("=" * 130)
    s = d[["market", "y2023", "y2024", "y2025", "y2026", "gradedRows", "games",
           "first", "last"]]
    print(s.to_string(index=False))
    print("\ntotals: " + "  ".join(
        f"{k}={int(d[k].sum()):,}" for k in ("y2023", "y2024", "y2025", "y2026",
                                             "gradedRows")))

    print("\n" + "=" * 130)
    print("DATA AVAILABLE / WITH ODDS / WITH VALID OUTCOMES / USED BY MODEL / STILL UNUSED")
    print("=" * 130)
    gb = box.drop_duplicates("game_pk")[["game_pk", "game_date"]]
    allgames = set(gb.game_pk)
    priced = set()
    for m in ORDER:
        priced |= set(frames.read_market(m)["game_pk"].dropna().astype(int))
    used = set()
    for m in ORDER:
        cand = frames.load_candidates(m, box)
        used |= set(cand[cand["overHit"].notna()].game_pk.unique())
    print(f"  DATA AVAILABLE       {len(allgames):,} games with box scores "
          f"({box.game_date.min()} -> {box.game_date.max()})")
    print(f"  DATA WITH ODDS       {len(allgames & priced):,} games")
    print(f"  DATA USED BY MODEL   {len(used):,} games (graded in >=1 market)")
    print(f"  DATA STILL UNUSED    {len(allgames - used):,} games")
    rest = gb[~gb.game_pk.isin(used)]
    if len(rest):
        print("\n  unused games by month:")
        print(rest.groupby(rest.game_date.str[:7]).size().to_string())

    out = os.path.join(REPORTS, f"inventory_{tag or 'base'}.csv")
    d.to_csv(out, index=False)
    print(f"\n-> {out}")


if __name__ == "__main__":
    main()
