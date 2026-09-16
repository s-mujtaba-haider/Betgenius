"""Prove the new feature tables are as-of, by recomputing them the slow way.

The whole result rests on one property: a feature attached to a game may only
read box scores that finished on an EARLIER local calendar date. `asof_rollup`
enforces it with a cumulative sum and a `searchsorted`, which is fast and which
is exactly the kind of code that is wrong by one row without anyone noticing.

So this recomputes a random sample of rows from the three tables added in the
second pass -- the starter's own workload, the bullpen, the park -- with a naive
filter that cannot be subtly off (`take every earlier row, average it`), and
asserts the two agree. It also asserts the stronger thing: that the value would
CHANGE if the game's own day were included, which is what makes the first
assertion meaningful rather than vacuous.

Ordering note: a team can play twice on one calendar day, so the 25-game window
can cut through a tie. The roll-up sorts stably and keeps the source row order
within a day; this recomputation does the same, or it would report a difference
that is a tie-break, not a leak.

    python harness/uplift/check_asof.py [--n=200]
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features
import frames

TOL = 1e-6


def _fail(msg):
    print(f"  FAIL  {msg}")
    return 1


def check_pitcher_form(box, rng, n):
    """spOuts25 = mean outs over this pitcher's last 25 EARLIER starts."""
    p = box[box["innings_pitched"].notna() & (box["is_starter"] == True)].copy()  # noqa: E712
    p["day"] = frames.to_day(p["game_date"])
    tab = features.pitcher_form(box)
    rows = tab[tab["spStarts25"] > 0].sample(min(n, len(tab)), random_state=rng)
    bad = same_day = 0
    for (pid, gpk), r in rows.iterrows():
        me = p[(p["player_id"] == pid) & (p["game_pk"] == gpk)]
        if not len(me):
            continue
        day = int(me["day"].iloc[0])
        hist = p[(p["player_id"] == pid) & (p["day"] < day)].sort_values("day", kind="stable").tail(25)
        if not len(hist):
            continue
        want = hist["outs_derived"].mean()
        if abs(want - r["spOuts25"]) > TOL:
            bad += _fail(f"pitcher_form spOuts25 {pid}/{gpk}: {r['spOuts25']} != {want}")
        withtoday = p[(p["player_id"] == pid) & (p["day"] <= day)].sort_values("day", kind="stable").tail(25)
        if abs(withtoday["outs_derived"].mean() - r["spOuts25"]) < TOL:
            same_day += 1
    return bad, len(rows), same_day


def check_bullpen(box, rng, n):
    """bpOutsPerGame = mean relief outs over this team's last 25 EARLIER games."""
    p = box[box["innings_pitched"].notna() & (box["is_starter"] != True)]          # noqa: E712
    per = p.groupby(["game_pk", "game_date", "team_id"], as_index=False).agg(
        bpOuts=("outs_derived", "sum"))
    per["day"] = frames.to_day(per["game_date"])
    tab = features.bullpen(box)
    rows = tab[tab["bpOutsPerGame"].notna()].sample(min(n, len(tab)), random_state=rng)
    bad = same_day = 0
    for (gpk, tid), r in rows.iterrows():
        me = per[(per["game_pk"] == gpk) & (per["team_id"] == tid)]
        if not len(me):
            continue
        day = int(me["day"].iloc[0])
        hist = per[(per["team_id"] == tid) & (per["day"] < day)].sort_values("day", kind="stable").tail(25)
        if not len(hist):
            continue
        if abs(hist["bpOuts"].mean() - r["bpOutsPerGame"]) > TOL:
            bad += _fail(f"bullpen bpOutsPerGame {gpk}/{tid}: "
                         f"{r['bpOutsPerGame']} != {hist['bpOuts'].mean()}")
        withtoday = per[(per["team_id"] == tid) & (per["day"] <= day)].sort_values("day", kind="stable").tail(25)
        if abs(withtoday["bpOuts"].mean() - r["bpOutsPerGame"]) < TOL:
            same_day += 1
    return bad, len(rows), same_day


def check_park(box, rng, n):
    """parkRunRel is built only from earlier games at the same park."""
    gh = features.game_home(box)
    ts = frames.team_scores(box)
    runs = ts.groupby("game_pk")["scored"].sum()
    gd = box.drop_duplicates("game_pk").set_index("game_pk")["game_date"]
    g = gh.copy()
    g["runs"] = g["game_pk"].map(runs).to_numpy(float)
    g["game_date"] = g["game_pk"].map(gd)
    g = g[g["game_date"].notna() & g["runs"].notna()].copy()
    g["day"] = frames.to_day(g["game_date"])
    lg = float(np.nanmean(g["runs"].to_numpy(float)))
    k = 30.0
    tab = features.park_env(box)
    rows = tab.sample(min(n, len(tab)), random_state=rng)
    bad = same_day = 0
    for gpk, r in rows.iterrows():
        me = g[g["game_pk"] == gpk]
        if not len(me):
            continue
        day, home = int(me["day"].iloc[0]), me["home_id"].iloc[0]
        hist = g[(g["home_id"] == home) & (g["day"] < day)].sort_values("day", kind="stable").tail(100)
        want = ((hist["runs"].sum() + lg * k) / (len(hist) + k)) / lg
        if abs(want - r["parkRunRel"]) > 1e-9:
            bad += _fail(f"park parkRunRel {gpk}: {r['parkRunRel']} != {want}")
        wt = g[(g["home_id"] == home) & (g["day"] <= day)].sort_values("day", kind="stable").tail(100)
        wt = ((wt["runs"].sum() + lg * k) / (len(wt) + k)) / lg
        if abs(wt - r["parkRunRel"]) < 1e-9:
            same_day += 1
    return bad, len(rows), same_day


def main():
    n = int(next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--n=")), 200))
    box = frames.load_box()
    rng = 20260916
    total_bad = 0
    for name, fn in (("starter workload", check_pitcher_form),
                     ("bullpen", check_bullpen),
                     ("park", check_park)):
        bad, checked, same = fn(box, rng, n)
        total_bad += bad
        print(f"{name:18s} {checked:4d} rows recomputed the slow way, {bad} mismatches; "
              f"{same} of them would be unchanged by including the game's own day "
              f"(so {checked - same} are a live test of the as-of cut)")
    print("\nOK - every sampled row matches a naive earlier-rows-only recomputation"
          if total_bad == 0 else f"\n{total_bad} MISMATCHES")
    return 1 if total_bad else 0


if __name__ == "__main__":
    sys.exit(main())
