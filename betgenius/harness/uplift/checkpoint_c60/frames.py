"""Universe assembly: price -> outcome -> point-in-time features.

Three rules hold everywhere in this file, because each of them has produced a
fake edge at least once:

1. Dates are LOCAL CALENDAR DATES, as text. `game_date` read as a timestamp
   arrives shifted by the client timezone, which moves a late start across
   midnight and lets an as-of join match a game to its own box score.
2. As-of joins are strictly earlier. A feature for a game on date D may read
   box scores from dates < D only -- never == D.
3. Nothing is read from the game being bet except the settled stat itself, and
   that only to grade.
"""
import os
import re
import unicodedata

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# market -> (role, box-score column, kind)
MARKETS = {
    "batter_hits":        ("batter", "hits", "prop"),
    "batter_total_bases": ("batter", "total_bases", "prop"),
    "batter_home_runs":   ("batter", "home_runs", "prop"),
    "batter_rbis":        ("batter", "rbi", "prop"),
    "batter_runs_scored": ("batter", "runs_scored", "prop"),
    "batter_strikeouts":  ("batter", "batter_strikeouts", "prop"),
    "pitcher_strikeouts": ("pitcher", "strikeouts", "prop"),
    "pitcher_outs":       ("pitcher", "outs_derived", "prop"),
    "totals":             ("game", "total_runs", "game"),
    "h2h":                ("game", "home_win", "game"),
    "spreads":            ("game", "margin", "game"),
}

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def norm_name(s):
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace(".", " ").replace("'", "").replace("-", " ")
    s = _SUFFIX.sub(" ", s)
    return " ".join(s.split())


# ---------------------------------------------------------------------------
# box scores
# ---------------------------------------------------------------------------
def load_box():
    b = pd.read_csv(os.path.join(DATA, "boxscores.csv"), low_memory=False)
    b["game_date"] = b["game_date"].astype(str).str[:10]   # local calendar date
    b["nname"] = b["player_name"].map(norm_name)

    # innings_pitched is the decimal shorthand (5.1 = 5 and 1/3). The stored
    # `outs` column agrees with it wherever both exist but is null for most of
    # 2025, so outs is derived from IP everywhere instead.
    ip = b["innings_pitched"]
    frac = (ip - np.floor(ip)).round(1)
    b["outs_derived"] = np.where(ip.notna(), np.floor(ip) * 3 + np.round(frac * 3), np.nan)
    return b


def name_to_id(b):
    """Global normalized-name -> player_id. Ambiguous names are dropped rather
    than guessed: a wrong id silently grades one player with another's line."""
    g = b.groupby("nname")["player_id"].nunique()
    solo = set(g[g == 1].index)
    m = b[b["nname"].isin(solo)].drop_duplicates("nname").set_index("nname")["player_id"]
    return m.to_dict(), set(g[g > 1].index)


def team_scores(b):
    """Runs per (game_pk, team_id).

    Taken from the OPPOSING staff's charged runs: a team's pitchers' runs sum to
    what the other side scored. That column is populated for every game in the
    table, where the batters' own runs_scored column is not.
    """
    allowed = (b.dropna(subset=["pitcher_runs"])
                 .groupby(["game_pk", "team_id"])["pitcher_runs"].sum()
                 .rename("allowed").reset_index())
    two = allowed.groupby("game_pk")["team_id"].transform("size") == 2
    allowed = allowed[two].copy()
    tot = allowed.groupby("game_pk")["allowed"].transform("sum")
    allowed["scored"] = tot - allowed["allowed"]    # the other team's allowance
    return allowed[["game_pk", "team_id", "scored", "allowed"]]


def team_name_map(b, ev):
    """Team name -> team_id, resolved by co-occurrence.

    The odds warehouse carries team NAMES; the box score carries team IDS and
    nothing else. Every game contributes two of each, so the id that appears in
    (almost) every game a name appears in is that name's id.
    """
    ids = b.groupby("game_pk")["team_id"].unique()
    rows = []
    for _, r in ev.iterrows():
        v = ids.get(r["game_pk"])
        if v is None or len(v) != 2:
            continue
        rows.append((r["home_team"], v[0]))
        rows.append((r["home_team"], v[1]))
        rows.append((r["away_team"], v[0]))
        rows.append((r["away_team"], v[1]))
    c = pd.DataFrame(rows, columns=["name", "team_id"]).value_counts().reset_index(name="n")
    c = c.sort_values("n", ascending=False).drop_duplicates("name")
    return dict(zip(c["name"], c["team_id"]))


# ---------------------------------------------------------------------------
# as-of roll-ups
# ---------------------------------------------------------------------------
def asof_rollup(hist, key, value_cols, windows=(25,), lag_days=0, prefix=""):
    """For every row of `hist`, aggregate `value_cols` over that key's earlier
    rows only.

    `hist` must carry `key`, `day` (integer local calendar day) and the value
    columns, one row per key-appearance. A row on day D sees rows on days
    strictly before D - lag_days: with lag_days=0 that is "everything before
    today", which is the real board; lag_days > 0 is the placebo used to prove
    the signal is form and not the game's own line.

    Each column gets its own sum AND its own non-null count, because several
    box-score columns are only populated for part of the window and a shared
    denominator would silently understate a rate.
    """
    h = hist.sort_values([key, "day"], kind="stable").reset_index(drop=True)
    n = len(h)
    out = {}
    for c in value_cols:
        for w in windows:
            out[f"{prefix}{c}_s{w}"] = np.zeros(n)
            out[f"{prefix}{c}_n{w}"] = np.zeros(n)
    vals = {c: h[c].to_numpy(float) for c in value_cols}
    days = h["day"].to_numpy()
    for _, rows in h.groupby(key, sort=False).indices.items():
        rows = np.asarray(rows)
        d = days[rows]
        first = np.searchsorted(d, d - lag_days, side="left")
        for c in value_cols:
            v = vals[c][rows]
            ok = ~np.isnan(v)
            cs = np.concatenate([[0.0], np.cumsum(np.where(ok, v, 0.0))])
            ns = np.concatenate([[0.0], np.cumsum(ok.astype(float))])
            for w in windows:
                s0 = np.maximum(0, first - w)
                out[f"{prefix}{c}_s{w}"][rows] = cs[first] - cs[s0]
                out[f"{prefix}{c}_n{w}"][rows] = ns[first] - ns[s0]
    for k, v in out.items():
        h[k] = v
    return h


def to_day(s):
    """Local calendar date -> integer day number.

    Unit-safe on purpose. pandas parses a date string to datetime64[us], not
    [ns], so dividing the int64 view by nanoseconds-per-day silently collapses
    every date in the sample into two or three buckets and the as-of roll-ups
    come back empty. Casting to datetime64[D] asks for days and gets days,
    whatever the parser chose underneath.
    """
    d = pd.to_datetime(s, format="%Y-%m-%d")
    return d.to_numpy().astype("datetime64[D]").astype("int64")


# ---------------------------------------------------------------------------
# candidates: price -> outcome
# ---------------------------------------------------------------------------
def market_files(market):
    """Warehouse dump first, provider dump second. Either may be absent."""
    return [p for p in (os.path.join(DATA, f"odds_{market}.csv"),
                        os.path.join(DATA, f"odds_{market}_api.csv"))
            if os.path.exists(p)]


def read_market(market):
    """The priced universe for a market, from whichever sources exist.

    Two markets (`batter_runs_scored`, `batter_strikeouts`) have no warehouse
    rows at all and one (`pitcher_outs`) has none after 2025-05-28, so for those
    the provider dump is the only source there is. Where both exist the
    warehouse row wins, so the 2026-05-24 warehouse cutoff is never quietly
    overwritten by a re-pull.
    """
    paths = market_files(market)
    if not paths:
        raise FileNotFoundError(f"no odds dump for {market} in {DATA}")
    parts = []
    for path in paths:
        f = pd.read_csv(path, low_memory=False)
        f["source"] = "odds_api" if path.endswith("_api.csv") else "warehouse"
        parts.append(f)
    c = pd.concat(parts, ignore_index=True)
    return c.drop_duplicates(["event_id", "player_name", "line"], keep="first")


def _american(p):
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    return np.where(p > 0.5, -100.0 * p / (1.0 - p), 100.0 * (1.0 - p) / p)


def load_candidates(market, box=None, price="best"):
    """The priced universe for one market, graded, one row per (event, line).

    price="best" takes the best number quoted at that line at the entry
    snapshot. That is the shipped convention, not a choice made here:
    supabase/functions/_shared/best_price.ts `selectBestSameLineBook` is what
    the production write path and harness/lib/game_candidates.ts both use, so a
    backtest priced any other way would not be measuring the same board.
    price="median" bets the median book instead and is reported alongside every
    verdict as the no-line-shopping sensitivity.
    """
    role, col, kind = MARKETS[market]
    box = load_box() if box is None else box
    c = read_market(market)

    # the official local game date comes from the box score, never from
    # commence_time -- a 10pm start is already tomorrow in UTC.
    gd = box.drop_duplicates("game_pk").set_index("game_pk")["game_date"]
    c["game_date"] = c["game_pk"].map(gd)
    c = c[c["game_date"].notna()].copy()

    # a candidate is only honest if both sides were quoted: without the other
    # side there is no de-vigged price and no second side to bet.
    c = c[(c["n_twoway"].fillna(0) > 0) & c["p_fair_over"].notna()].copy()

    imp_o = c["imp_over_best"] if price == "best" else c["imp_over_med"]
    imp_u = c["imp_under_best"] if price == "best" else c["imp_under_med"]
    c = c[imp_o.notna() & imp_u.notna()].copy()
    c["overOdds"] = _american(imp_o)
    c["underOdds"] = _american(imp_u)
    c["pFairOver"] = c["p_fair_over"].astype(float)
    c["overround"] = (c["imp_over_med"] + c["imp_under_med"]).astype(float)

    if kind == "game":
        ts = team_scores(box)
        ev = c.drop_duplicates("game_pk")[["game_pk", "home_team", "away_team"]]
        tmap = team_name_map(box, ev)
        c["home_id"] = c["home_team"].map(tmap)
        c["away_id"] = c["away_team"].map(tmap)
        sc = ts.set_index(["game_pk", "team_id"])["scored"]
        c["homeRuns"] = pd.Series(list(zip(c["game_pk"], c["home_id"]))).map(sc).to_numpy()
        c["awayRuns"] = pd.Series(list(zip(c["game_pk"], c["away_id"]))).map(sc).to_numpy()
        c = c[c["homeRuns"].notna() & c["awayRuns"].notna()].copy()
        if market == "totals":
            c["actual"] = c["homeRuns"] + c["awayRuns"]
            c["overHit"] = np.where(c["actual"] == c["line"], np.nan, c["actual"] > c["line"])
        elif market == "h2h":
            c["actual"] = c["homeRuns"] - c["awayRuns"]
            c["overHit"] = (c["actual"] > 0).astype(float)          # "over" = home
        else:  # spreads: line is the HOME number, home covers at margin + line > 0
            c["actual"] = c["homeRuns"] - c["awayRuns"]
            cover = c["actual"] + c["line"]
            c["overHit"] = np.where(cover == 0, np.nan, cover > 0)
        c["playerId"] = 0
        c["sideOver"], c["sideUnder"] = ("home", "away") if market != "totals" else ("over", "under")
    else:
        nm, _amb = name_to_id(box)
        c["nname"] = c["player_name"].map(norm_name)
        c["playerId"] = c["nname"].map(nm)
        c = c[c["playerId"].notna()].copy()
        c["playerId"] = c["playerId"].astype(int)
        stat = box.set_index(["player_id", "game_pk"])[col]
        c["actual"] = pd.Series(list(zip(c["playerId"], c["game_pk"]))).map(stat).to_numpy()
        # no box-score row for that player in that game = did not play = the
        # book voids the prop. Not a loss, and never graded as one.
        c = c[c["actual"].notna()].copy()
        c["overHit"] = np.where(c["actual"] == c["line"], np.nan, c["actual"] > c["line"])
        c["sideOver"], c["sideUnder"] = "over", "under"

    c["commenceTime"] = pd.to_datetime(c["commence_time"], format="mixed", utc=True)
    c["day"] = to_day(c["game_date"])
    c["market"] = market
    c["eventId"] = c["event_id"]
    return c.sort_values(["commenceTime", "eventId"]).reset_index(drop=True)
