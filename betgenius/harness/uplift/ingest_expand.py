"""Phase 1 -- fetch the historical odds that are missing, and only those.

What the probes established, before a single credit was spent on data
--------------------------------------------------------------------
* `probe_api_coverage.py`: the Odds API historical endpoint returns
  **HTTP 422 "Historical odds are not available"** for 2020, 2021 and 2022. The
  earliest snapshot that carries player props is **2023-05**, where all eleven
  markets are present across 19 books. So 2020-2022 are not a decision, they are
  a wall.
* `probe_warehouse.ts`: `cache_mlb_historical_odds` genuinely stops at
  **2026-05-24** -- the constant in `dump_odds.ts` is a fact, not a throttle. It
  also starts at **2023-05-03**, so a season of warehouse odds already exists
  that the pipeline never reads.
* But `cache_mlb_boxscore_player_stats` starts **2024-04-01**. Odds without a box
  score cannot be graded, so 2023 is dead whichever source it comes from. That is
  why this file does not fetch it.
* `cache_mlb_historical_events` -- the event_id <-> game_pk bridge -- runs to
  **2026-06**. Past that the bridge is rebuilt here from team names and the local
  calendar date, and any game where that rebuild is ambiguous is DROPPED rather
  than guessed.

What is therefore worth fetching, in priority order
---------------------------------------------------
  A  2026-06-01 -> 2026-09-16, all markets. ~1,377 games that have box scores
     and no odds at all. In 2026-07/08/09 `runs_scored` and `batter_strikeouts`
     are fully populated, so this is the ONLY window that can repair the two
     markets that are currently 2024-only -- and it repairs them with the most
     recent data in the project.
  B  2026-03-01 -> 2026-05-31, all markets, for the games the warehouse never
     priced. ~597 games.
  C  2025-04 and 2025-05 only, `batter_runs_scored` + `batter_strikeouts`. Those
     are the only 2025 months where the settled columns are non-null; from
     2025-06 they are 0% and no amount of odds will grade them.

Point-in-time
-------------
Every pull is taken at **commence - 1 hour**, which is the convention
`ingest_odds_api.ts` already used for the three API-sourced markets. It is
strictly before first pitch, so nothing here can carry post-game information.
The snapshot the provider actually served is recorded per event, so the claim is
checkable rather than asserted.

Precedence and provenance
-------------------------
Nothing already in the warehouse is overwritten. New rows are written to
`apix_*.jsonl`, which `api_to_csv.py`'s default glob (`api_*`) does not match,
and are folded into a SEPARATE data directory so the `_c60` inputs are left
untouched. `frames.read_market` already prefers the warehouse row on a
(event, player, line) collision.

    python harness/uplift/ingest_expand.py --plan            # cost, fetch nothing
    python harness/uplift/ingest_expand.py --run --group=A
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
BASE = "https://api.the-odds-api.com/v4/historical/sports/baseball_mlb"
# How far before first pitch the entry price is taken. MEASURED, not assumed:
# probe_entry_lead.ts shows the warehouse's own entry snapshot -- min(snapshot)
# strictly before commence, which is what dump_odds.ts selects -- sits at
# ~6.0h for every month from 2024-03 to 2025-10, and at ~1.0h for 2026-04/05.
# `ingest_odds_api.ts` used 1h. So the project already contains a convention
# break at 2026, and pulling new data at 1h would deepen it: a one-hour line is
# sharper than a six-hour one, so edge measured against it is systematically
# smaller. 6h is both the dominant convention (395k of 536k graded rows) and the
# production-realistic one for a daily pick cron. Overridable with --lead=.
ENTRY_LEAD_H = 6.0
REGIONS = "us"
CREDITS_PER_MARKET = 10

ALL_MARKETS = ["h2h", "spreads", "totals", "batter_hits", "batter_total_bases",
               "batter_home_runs", "batter_rbis", "batter_runs_scored",
               "batter_strikeouts", "pitcher_strikeouts", "pitcher_outs"]
TWO_MARKETS = ["batter_runs_scored", "batter_strikeouts"]

GROUPS = {
    "A": dict(lo="2026-06-01", hi="2026-09-17", markets=ALL_MARKETS,
              why="box scores exist, zero odds; repairs the two 2024-only markets"),
    "B": dict(lo="2026-03-01", hi="2026-06-01", markets=ALL_MARKETS,
              why="2026 games the warehouse never priced"),
    "C": dict(lo="2025-04-01", hi="2025-06-01", markets=TWO_MARKETS,
              why="the only 2025 months where the settled columns are non-null"),
}


# --------------------------------------------------------------------------
def api_key():
    for k in ("ODDS_API_KEY", "THE_ODDS_API_KEY"):
        if os.environ.get(k):
            return os.environ[k]
    env = os.path.join(HERE, "..", ".env")
    if os.path.exists(env):
        for line in open(env, encoding="utf-8"):
            line = line.strip()
            if line.startswith(("ODDS_API_KEY=", "THE_ODDS_API_KEY=")):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("[expand] ODDS_API_KEY not found in env or harness/.env")


def get(url, timeout=45):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode()), dict(r.headers), None
    except urllib.error.HTTPError as e:
        return None, dict(e.headers or {}), f"HTTP {e.code}"
    except Exception as e:                                         # noqa: BLE001
        return None, {}, type(e).__name__


def snap_iso(commence):
    t = pd.Timestamp(commence)
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    return (t - pd.Timedelta(hours=ENTRY_LEAD_H)).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# the event_id <-> game_pk bridge
# --------------------------------------------------------------------------
_BRIDGE = {}
_PRICED = {}


def load_bridge():
    """Known events, and a team-name -> team_id map learned from them."""
    if _BRIDGE:
        return _BRIDGE["v"]
    import frames
    ev = pd.read_csv(os.path.join(DATA, "aux_events.csv"))
    ev["commence_time"] = pd.to_datetime(ev["commence_time"], format="mixed", utc=True)
    box = frames.load_box()
    ids = box.groupby("game_pk")["team_id"].unique()
    rows = []
    for e in ev.dropna(subset=["game_pk"]).itertuples(index=False):
        v = ids.get(int(e.game_pk))
        if v is None or len(v) != 2:
            continue
        for nm in (e.home_team, e.away_team):
            rows.append((nm, v[0]))
            rows.append((nm, v[1]))
    c = pd.DataFrame(rows, columns=["name", "team_id"]).value_counts().reset_index(name="n")
    tmap = dict(zip(c.sort_values("n", ascending=False).drop_duplicates("name")["name"],
                    c.sort_values("n", ascending=False).drop_duplicates("name")["team_id"]))
    # game_pk -> (date, frozenset of the two team ids), for the rebuilt bridge
    g = box.drop_duplicates("game_pk")[["game_pk", "game_date"]].set_index("game_pk")["game_date"]
    key = {}
    for gp, v in ids.items():
        if len(v) != 2 or gp not in g.index:
            continue
        key.setdefault((g.loc[gp], frozenset(int(x) for x in v)), []).append(int(gp))
    _BRIDGE["v"] = (ev, tmap, key, box)
    return _BRIDGE["v"]


def game_dates_for(commence):
    """The box-score `game_date` values a start time can correspond to.

    Measured, not assumed. Across the 5,726 events where the warehouse already
    carries the true game_pk, `game_date` equals the **commence UTC date** in
    5,648 cases (98.6%) and the next UTC day in 58; the remaining handful are
    events whose stored game_pk is itself wrong (offsets of 46 to 125 days).
    An earlier guess here -- shift back eight hours to get a US local date --
    was wrong for 1,300 events and, worse, silently resolved 550 of them to the
    WRONG game. So the UTC date is tried first and the next day only as a
    fallback, and a tie is never broken by preference.
    """
    ts = pd.Timestamp(commence)
    ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
    return [ts.strftime("%Y-%m-%d"), (ts + pd.Timedelta(days=1)).strftime("%Y-%m-%d")]


def resolve_game_pk(home, away, commence, tmap, key):
    """Team names + game date -> game_pk. Ambiguity is dropped, never guessed."""
    h, a = tmap.get(home), tmap.get(away)
    if h is None or a is None:
        return None, "team name unmapped"
    pair = frozenset((int(h), int(a)))
    for d in game_dates_for(commence):
        hits = key.get((d, pair), [])
        if len(hits) == 1:
            return hits[0], ""
        if len(hits) > 1:
            # a genuine doubleheader: same pair, same date, two game_pks, and
            # nothing in the provider's event distinguishes them. Dropped.
            return None, f"ambiguous ({len(hits)} games -- doubleheader)"
    return None, "no box-score game for that pair/date"


# --------------------------------------------------------------------------
def already_priced():
    """(market -> set of game_pk) already present in the existing dumps.

    Keyed on game_pk, NOT event_id, and that is load-bearing. The warehouse
    identifies the 2026 games it never priced with a synthetic `mlb_<game_pk>`
    id, while the provider knows the same game by a 32-hex id of its own. Keying
    the skip list on event_id would therefore fail to recognise an already-priced
    game and would import it a second time under a different id -- and
    `frames.read_market` de-duplicates on (event_id, player_name, line), so the
    duplicate would survive and the game would be bet twice.
    """
    if _PRICED:
        return _PRICED["v"]
    out = {}
    for m in ALL_MARKETS:
        s = set()
        for suf in ("", "_api"):
            p = os.path.join(DATA, f"odds_{m}{suf}.csv")
            if os.path.exists(p):
                s |= set(pd.read_csv(p, usecols=["game_pk"])["game_pk"].dropna().astype(int))
        out[m] = s
    _PRICED["v"] = out
    return out


def enumerate_provider_events(lo, hi, key_api, cache={}):
    """Every event the PROVIDER knows in a window, by its own id.

    The warehouse cannot supply these. For the 2026 games it never priced it
    stores a synthetic `mlb_<game_pk>` id, and handing that to the provider
    returns HTTP 422 -- which is how the first attempt at this pull failed on
    every one of its first 200 events. Only the provider's own 32-hex id works,
    so the day list is enumerated from the provider itself.

    Two snapshots a day, 11:00 and 20:00 UTC, unioned: a single midday snapshot
    misses games that had already started, and a single evening one misses the
    afternoon slate. One credit per call.
    """
    days = pd.date_range(lo.normalize(), min(hi, pd.Timestamp.now(tz="UTC")),
                         freq="D", tz="UTC")
    out = {}
    for d in days:
        for hh in ("11:00:00", "20:00:00"):
            iso = d.strftime(f"%Y-%m-%dT{hh}Z")
            if iso in cache:
                body = cache[iso]
            else:
                body, _, err = get(f"{BASE}/events?apiKey={key_api}&date={iso}")
                cache[iso] = body if not err else None
                time.sleep(0.03)
            if not body:
                continue
            for e in body.get("data", []):
                ct = pd.Timestamp(e["commence_time"])
                if lo <= ct < hi:
                    out[e["id"]] = e
    return list(out.values())


def build_targets(group, key_api):
    """Events to fetch for one group, with a resolved and validated game_pk."""
    spec = GROUPS[group]
    ev, tmap, key, box = load_bridge()
    priced = already_priced()
    lo, hi = pd.Timestamp(spec["lo"], tz="UTC"), pd.Timestamp(spec["hi"], tz="UTC")

    evs = enumerate_provider_events(lo, hi, key_api)
    print(f"[expand]   provider knows {len(evs):,} events in the window", flush=True)

    rows, unres = [], []
    for e in evs:
        ct = pd.Timestamp(e["commence_time"])
        gp, why = resolve_game_pk(e["home_team"], e["away_team"], ct, tmap, key)
        if gp is None:
            unres.append((e["id"], why))
            continue
        rows.append(dict(event_id=e["id"], game_pk=int(gp),
                         commence_time=ct.strftime("%Y-%m-%dT%H:%M:%SZ"),
                         home_team=e["home_team"], away_team=e["away_team"],
                         src="provider_events"))
    t = pd.DataFrame(rows)
    if t.empty:
        return t, pd.DataFrame(unres, columns=["event_id", "why"])
    # one provider event per game_pk; if two map to the same game, drop both
    # rather than guess which is the real one
    dup = t.game_pk.duplicated(keep=False)
    if dup.any():
        for e in t[dup].event_id:
            unres.append((e, "two provider events map to one game_pk"))
        t = t[~dup]
    # keep only games missing at least one wanted market
    t["missing"] = t.game_pk.map(
        lambda g: [m for m in spec["markets"] if g not in priced[m]])
    t = t[t.missing.map(len) > 0].reset_index(drop=True)
    return t, pd.DataFrame(unres, columns=["event_id", "why"])


# --------------------------------------------------------------------------
def fetch_one(key_api, markets, row):
    url = (f"{BASE}/events/{row['event_id']}/odds?apiKey={key_api}&regions={REGIONS}"
           f"&markets={','.join(markets)}&oddsFormat=american"
           f"&date={urllib.parse.quote(snap_iso(row['commence_time']))}")
    body, hd, err = get(url)
    if err or not body:
        return None, hd.get("x-requests-remaining", ""), err or "empty"
    data = body.get("data") or {}
    bks = data.get("bookmakers") or []
    if not bks:
        return None, hd.get("x-requests-remaining", ""), "no bookmakers"
    return dict(event_id=row["event_id"], game_pk=int(row["game_pk"]),
                commence_time=row["commence_time"],
                home_team=row["home_team"], away_team=row["away_team"],
                bookmakers=bks,
                # provenance
                snapshot=body.get("timestamp"),
                snapshot_requested=snap_iso(row["commence_time"]),
                previous_snapshot=body.get("previous_timestamp"),
                next_snapshot=body.get("next_timestamp"),
                regions=REGIONS, source="odds_api_historical",
                bridge=row["src"],
                retrieved_at=pd.Timestamp.utcnow().isoformat()), \
        hd.get("x-requests-remaining", ""), None


def main():
    args = {a.split("=")[0]: (a.split("=", 1)[1] if "=" in a else True) for a in sys.argv[1:]}
    groups = str(args.get("--group", "A,B,C")).split(",")
    limit = int(args.get("--limit", 0))
    do_run = "--run" in args
    global ENTRY_LEAD_H
    ENTRY_LEAD_H = float(args.get("--lead", ENTRY_LEAD_H))
    suffix = args.get("--suffix", "")
    key_api = api_key()
    print(f"[expand] entry snapshot = commence - {ENTRY_LEAD_H}h", flush=True)

    plans = {}
    for gname in groups:
        spec = GROUPS[gname]
        print(f"\n[expand] group {gname}: {spec['lo']} -> {spec['hi']}  "
              f"{len(spec['markets'])} markets  ({spec['why']})", flush=True)
        t, unres = build_targets(gname, key_api)
        if limit and len(t):
            t = t.head(limit)
        cost = int(sum(len(m) for m in t.missing) * CREDITS_PER_MARKET) if len(t) else 0
        print(f"[expand]   events to fetch: {len(t):,}   estimated cost: {cost:,} credits")
        if len(unres):
            print(f"[expand]   unresolved events dropped: {len(unres):,}")
            print(unres.why.value_counts().to_string())
        if len(t):
            t["ym"] = t.commence_time.str[:7]
            print(t.groupby("ym").agg(events=("event_id", "size"),
                                      src=("src", lambda s: s.iloc[0])).to_string())
        plans[gname] = t

    total = sum(int(sum(len(m) for m in t.missing) * CREDITS_PER_MARKET)
                for t in plans.values() if len(t))
    print(f"\n[expand] TOTAL estimated cost: {total:,} credits")
    if not do_run:
        print("[expand] --plan only. Nothing fetched, nothing written.")
        return

    for gname, t in plans.items():
        if not len(t):
            continue
        markets = GROUPS[gname]["markets"]
        out = os.path.join(DATA, f"apix{suffix}_group{gname}.jsonl")
        done = set()
        if os.path.exists(out):
            for line in open(out, encoding="utf-8"):
                try:
                    done.add(json.loads(line)["event_id"])
                except Exception:                                  # noqa: BLE001
                    pass
            print(f"[expand] {gname}: resuming, {len(done)} already stored", flush=True)
        todo = t[~t.event_id.isin(done)].to_dict("records")
        ok = fail = 0
        left = ""
        t0 = time.time()
        with open(out, "a", encoding="utf-8") as fh, ThreadPoolExecutor(max_workers=6) as pool:
            for i, (rec, lf, err) in enumerate(
                    pool.map(lambda r: fetch_one(key_api, markets, r), todo), 1):
                if lf:
                    left = lf
                if rec is None:
                    fail += 1
                else:
                    ok += 1
                    fh.write(json.dumps(rec) + "\n")
                if i % 100 == 0 or i == len(todo):
                    print(f"[expand] {gname} {i}/{len(todo)} ok={ok} miss={fail} "
                          f"credits_left={left} [{time.time() - t0:.0f}s]", flush=True)
        print(f"[expand] {gname} done ok={ok} miss={fail} -> {out}", flush=True)


if __name__ == "__main__":
    main()
