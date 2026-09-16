"""Count what is actually on disk, so the data documentation cannot drift.

Writes reports/data_inventory.csv: one row per raw input file with its row count
and, where it has dates, its span. Then the per-market candidate counts as the
pipeline sees them, read from reports/final.csv rather than recounted, so the
inventory and the results agree by construction.

    python harness/uplift/data_inventory.py
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import frames

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
DATA = os.path.join(HERE, "data")


def count_rows(path):
    with open(path, "rb") as f:
        return max(sum(buf.count(b"\n") for buf in iter(lambda: f.read(1 << 20), b"")) - 1, 0)


def main():
    rows = []
    if os.path.isdir(DATA):
        for name in sorted(os.listdir(DATA)):
            p = os.path.join(DATA, name)
            if not os.path.isfile(p) or not name.endswith((".csv", ".jsonl")):
                continue
            n = count_rows(p)
            span_from = span_to = ""
            if name.endswith(".csv"):
                try:
                    head = pd.read_csv(p, nrows=5)
                    col = ("game_date" if "game_date" in head.columns
                           else "commence_time" if "commence_time" in head.columns else None)
                    if col:
                        s = pd.read_csv(p, usecols=[col], low_memory=False)[col].astype(str)
                        span_from, span_to = s.min()[:10], s.max()[:10]
                except Exception:                                   # noqa: BLE001
                    pass
            rows.append(dict(file=name, kind="raw input",
                             sizeMb=round(os.path.getsize(p) / 1e6, 1),
                             rows=n, fromDate=span_from, toDate=span_to))

    box = frames.load_box()
    rows.append(dict(file="boxscores.csv (parsed)", kind="derived",
                     sizeMb="", rows=len(box), fromDate=box["game_date"].min(),
                     toDate=box["game_date"].max()))
    rows.append(dict(file="distinct games in box scores", kind="derived", sizeMb="",
                     rows=int(box["game_pk"].nunique()), fromDate="", toDate=""))
    rows.append(dict(file="distinct players in box scores", kind="derived", sizeMb="",
                     rows=int(box["player_id"].nunique()), fromDate="", toDate=""))

    f = pd.read_csv(os.path.join(REPORTS, "final.csv"))
    for _, r in f.iterrows():
        rows.append(dict(file=f"market {r['market']}", kind="graded candidates",
                         sizeMb="", rows=int(r["graded"]),
                         fromDate=r["fromDate"], toDate=r["toDate"]))
    rows.append(dict(file="ALL MARKETS", kind="graded candidates", sizeMb="",
                     rows=int(f["graded"].sum()), fromDate=f["fromDate"].min(),
                     toDate=f["toDate"].max()))

    out = pd.DataFrame(rows)
    out.to_csv(os.path.join(REPORTS, "data_inventory.csv"), index=False)
    pd.set_option("display.width", 200)
    print(out.to_string(index=False))

    a = pd.Timestamp(f["fromDate"].min())
    b = pd.Timestamp(f["toDate"].max())
    days = (b - a).days
    print(f"\nevaluation span {a.date()} -> {b.date()} = {days} days "
          f"= {days / 365.25:.2f} years, across {b.year - a.year + 1} MLB seasons")
    print(f"box scores {box['game_date'].min()} -> {box['game_date'].max()}, "
          f"{box['game_pk'].nunique():,} games, {len(box):,} player-game rows")


if __name__ == "__main__":
    main()
