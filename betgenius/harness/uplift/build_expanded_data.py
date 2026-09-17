"""Fold the new pulls into a SEPARATE data directory, leaving `_c60`'s inputs alone.

The expanded dataset is assembled in `data_expanded/`, and everything downstream
reaches it through `UPLIFT_DATA_DIR`. `data/` is not written to, so the `_c60`
result stays reproducible from exactly the files that produced it -- which is
what makes the before/after comparison mean anything.

Precedence, unchanged from `frames.read_market`: the warehouse dump is listed
first and `drop_duplicates(keep="first")` on (event_id, player_name, line) keeps
it, so a freshly pulled row can only ever FILL A HOLE, never overwrite an
observation the warehouse already held.

The two markets that already have an `_api.csv` (`batter_runs_scored`,
`batter_strikeouts`, plus `pitcher_outs`) get the old and new API rows UNIONED,
old first, so the same rule applies within the API source as well.

    python harness/uplift/build_expanded_data.py
"""
import glob
import json
import os
import shutil
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "data")
DST = os.path.join(HERE, "data_expanded")

OUT_COLS = ["event_id", "game_pk", "commence_time", "home_team", "away_team",
            "player_name", "line", "n_books", "n_over", "n_under",
            "imp_over_med", "imp_under_med", "imp_over_best", "imp_under_best",
            "p_fair_over", "n_twoway"]

# provider market key -> the pipeline's market name (they agree except for the
# two-sided game markets, which dump_odds.ts stores split by side)
GAME_SPLIT = {"h2h", "spreads"}


def implied(price):
    p = float(price)
    return (-p / (-p + 100.0)) if p < 0 else (100.0 / (p + 100.0))


def rows_from(paths):
    """One row per (market, event, player/side, line, book)."""
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue                       # truncated final line
                home, away = ev.get("home_team"), ev.get("away_team")
                for bk in ev.get("bookmakers", []):
                    for mk in bk.get("markets", []):
                        key = mk["key"]
                        for o in mk.get("outcomes", []):
                            if o.get("price") is None:
                                continue
                            name = str(o.get("name", ""))
                            point = o.get("point")
                            if key in ("h2h",):
                                # the two sides ARE the two teams; the pipeline
                                # wants home as "over" at line 0
                                side = "over" if name == home else (
                                    "under" if name == away else None)
                                if side is None:
                                    continue
                                point, player = 0.0, ""
                            elif key in ("spreads",):
                                side = "over" if name == home else (
                                    "under" if name == away else None)
                                if side is None or point is None:
                                    continue
                                # dump_odds.ts stores the HOME number as `line`
                                point = float(point) if side == "over" else -float(point)
                                player = ""
                            elif key == "totals":
                                if point is None:
                                    continue
                                side = name.lower()
                                if side not in ("over", "under"):
                                    continue
                                point, player = float(point), ""
                            else:
                                if point is None:
                                    continue
                                side = name.lower()
                                if side not in ("over", "under"):
                                    continue
                                point = float(point)
                                player = o.get("description", "")
                            yield dict(market=key, event_id=ev["event_id"],
                                       game_pk=ev["game_pk"],
                                       commence_time=ev["commence_time"],
                                       home_team=home, away_team=away,
                                       book=bk["key"], player_name=player,
                                       line=point, side=side, imp=implied(o["price"]))


def aggregate(df):
    key = ["market", "event_id", "game_pk", "commence_time", "home_team",
           "away_team", "player_name", "line"]
    w = (df.pivot_table(index=key + ["book"], columns="side", values="imp",
                        aggfunc="first").reset_index())
    for c in ("over", "under"):
        if c not in w:
            w[c] = np.nan
    w["fair"] = np.where(w["over"].notna() & w["under"].notna(),
                         w["over"] / (w["over"] + w["under"]), np.nan)
    return w.groupby(key, as_index=False).agg(
        n_books=("book", "size"), n_over=("over", "count"), n_under=("under", "count"),
        imp_over_med=("over", "median"), imp_under_med=("under", "median"),
        imp_over_best=("over", "min"), imp_under_best=("under", "min"),
        p_fair_over=("fair", "mean"), n_twoway=("fair", "count"))


def main():
    args = {a.split("=")[0]: a.split("=", 1)[1] for a in sys.argv[1:] if "=" in a}
    pattern = args.get("--pattern", "apix_*.jsonl")
    dst = args.get("--out", DST)
    globals()["DST"] = dst
    os.makedirs(dst, exist_ok=True)
    # 1. everything that is not a freshly pulled market file is carried across
    for p in glob.glob(os.path.join(SRC, "*.csv")):
        shutil.copy2(p, os.path.join(dst, os.path.basename(p)))
    print(f"[expanded] carried {len(glob.glob(os.path.join(dst, '*.csv')))} source CSVs across")

    paths = sorted(glob.glob(os.path.join(SRC, pattern)))
    if not paths:
        print("[expanded] no apix_*.jsonl found -- nothing to fold in")
        return
    print(f"[expanded] parsing {len(paths)} new dumps: "
          f"{', '.join(os.path.basename(p) for p in paths)}", flush=True)
    df = pd.DataFrame(rows_from(paths))
    if df.empty:
        print("[expanded] parsed 0 rows")
        return
    print(f"[expanded] {len(df):,} price rows across {df.event_id.nunique():,} events")
    g = aggregate(df)

    rep = []
    for market, sub in g.groupby("market"):
        new = sub[OUT_COLS].copy()
        old_p = os.path.join(SRC, f"odds_{market}_api.csv")
        if os.path.exists(old_p):
            old = pd.read_csv(old_p)
            merged = pd.concat([old[OUT_COLS], new], ignore_index=True)
            merged = merged.drop_duplicates(["event_id", "player_name", "line"],
                                            keep="first")
            added = len(merged) - len(old)
        else:
            merged, added = new, len(new)
        out = os.path.join(dst, f"odds_{market}_api.csv")
        merged.to_csv(out, index=False)
        ct = pd.to_datetime(merged["commence_time"], format="mixed", utc=True)
        rep.append(dict(market=market, rowsTotal=len(merged), rowsAdded=added,
                        events=merged.event_id.nunique(),
                        games=merged.game_pk.nunique(),
                        first=str(ct.min())[:10], last=str(ct.max())[:10]))
    r = pd.DataFrame(rep).sort_values("rowsAdded", ascending=False)
    pd.set_option("display.width", 200)
    print("\n[expanded] per-market API files written to data_expanded/")
    print(r.to_string(index=False))
    print(f"\n[expanded] -> {DST}")
    print("[expanded] use it with:  UPLIFT_DATA_DIR=<that path>")


if __name__ == "__main__":
    main()
