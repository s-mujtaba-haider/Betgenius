"""Fold an Odds API historical dump into the same candidate shape dump_odds.ts
produces, so nothing downstream has to know where a market's prices came from.

Only `batter_runs_scored` and `batter_strikeouts` need this: both have zero rows
in cache_mlb_historical_odds in every season, which is why neither had ever been
given a verdict. Every other market is read straight from the warehouse and the
2026-05-24 warehouse cutoff is left alone.

    python harness/uplift/api_to_csv.py data/api_rs_bk_2024.jsonl [more.jsonl ...]
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames


def implied(price):
    p = float(price)
    return (-p / (-p + 100.0)) if p < 0 else (100.0 / (p + 100.0))


def rows_from(paths):
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue                      # truncated final line of a killed run
                for bk in ev.get("bookmakers", []):
                    for mk in bk.get("markets", []):
                        for o in mk.get("outcomes", []):
                            if o.get("price") is None or o.get("point") is None:
                                continue
                            yield dict(market=mk["key"], event_id=ev["event_id"],
                                       game_pk=ev["game_pk"],
                                       commence_time=ev["commence_time"],
                                       home_team=ev["home_team"], away_team=ev["away_team"],
                                       book=bk["key"], player_name=o.get("description", ""),
                                       line=float(o["point"]),
                                       side=str(o["name"]).lower(),
                                       imp=implied(o["price"]))


def main(paths):
    df = pd.DataFrame(rows_from(paths))
    if df.empty:
        print("no rows parsed")
        return
    key = ["market", "event_id", "game_pk", "commence_time", "home_team", "away_team",
           "player_name", "line"]
    w = (df.pivot_table(index=key + ["book"], columns="side", values="imp", aggfunc="first")
           .reset_index())
    for c in ("over", "under"):
        if c not in w:
            w[c] = np.nan
    w["fair"] = np.where(w["over"].notna() & w["under"].notna(),
                         w["over"] / (w["over"] + w["under"]), np.nan)
    g = w.groupby(key, as_index=False).agg(
        n_books=("book", "size"),
        n_over=("over", "count"),
        n_under=("under", "count"),
        imp_over_med=("over", "median"),
        imp_under_med=("under", "median"),
        imp_over_best=("over", "min"),
        imp_under_best=("under", "min"),
        p_fair_over=("fair", "mean"),
        n_twoway=("fair", "count"))
    out_cols = ["event_id", "game_pk", "commence_time", "home_team", "away_team",
                "player_name", "line", "n_books", "n_over", "n_under",
                "imp_over_med", "imp_under_med", "imp_over_best", "imp_under_best",
                "p_fair_over", "n_twoway"]
    for market, sub in g.groupby("market"):
        path = os.path.join(frames.DATA, f"odds_{market}_api.csv")
        sub[out_cols].to_csv(path, index=False)
        print(f"{market:22s} {len(sub):7,} candidates  "
              f"{sub.event_id.nunique():,} events  -> {os.path.basename(path)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        args = [os.path.join(frames.DATA, f) for f in sorted(os.listdir(frames.DATA))
                if f.startswith("api_") and f.endswith(".jsonl")]
    main(args)
