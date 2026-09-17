"""Phase 1.1 -- what the Odds API historical endpoint will actually give us.

Read-only and deliberately cheap. The historical /events list costs 1 credit per
call; a per-event odds pull costs 10 credits per market per region, so this file
answers "does this season/market exist at all" with the 1-credit endpoint first
and only spends 10-credit calls on a handful of confirmations.

Nothing here writes to data/. It prints a coverage matrix and stops.

    python harness/uplift/probe_api_coverage.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "https://api.the-odds-api.com/v4/historical/sports/baseball_mlb"

# one mid-season probe date per season, plus the edges of the window we care about
PROBE_DATES = [
    "2020-08-15T18:00:00Z", "2021-07-15T18:00:00Z", "2022-07-15T18:00:00Z",
    "2023-07-15T18:00:00Z", "2023-05-15T18:00:00Z",
    "2024-07-15T18:00:00Z", "2025-07-15T18:00:00Z",
    "2026-04-15T18:00:00Z", "2026-06-15T18:00:00Z", "2026-07-15T18:00:00Z",
    "2026-08-15T18:00:00Z", "2026-09-10T18:00:00Z",
]

MARKETS = ["h2h", "spreads", "totals",
           "batter_hits", "batter_total_bases", "batter_home_runs", "batter_rbis",
           "batter_runs_scored", "batter_strikeouts",
           "pitcher_strikeouts", "pitcher_outs"]


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
    raise SystemExit("[probe] ODDS_API_KEY not found in env or harness/.env")


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=40) as r:
            return json.loads(r.read().decode()), dict(r.headers), None
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode()).get("message", "")[:120]
        except Exception:                                          # noqa: BLE001
            msg = ""
        return None, dict(e.headers or {}), f"HTTP {e.code} {msg}"
    except Exception as e:                                         # noqa: BLE001
        return None, {}, type(e).__name__


def main():
    key = api_key()
    print("=" * 108)
    print("A. HISTORICAL EVENT COVERAGE  (1 credit per call)")
    print("=" * 108)
    rows, usable = [], []
    for d in PROBE_DATES:
        body, hd, err = get(f"{BASE}/events?apiKey={key}&date={urllib.parse.quote(d)}")
        n = len(body.get("data", [])) if body else 0
        snap = body.get("timestamp") if body else None
        rows.append(dict(probeDate=d[:10], events=n, snapshotReturned=(snap or "")[:19],
                         error=err or "",
                         creditsLeft=hd.get("x-requests-remaining", "")))
        if n:
            usable.append((d, body["data"]))
        time.sleep(0.15)
    ev = pd.DataFrame(rows)
    print(ev.to_string(index=False))

    print("\n" + "=" * 108)
    print("B. MARKET AVAILABILITY PER SEASON  (10 credits per market per region -- one event each)")
    print("=" * 108)
    print("probing one event per season with ALL markets in a single call\n")
    out = []
    for d, evs in usable:
        e = evs[0]
        url = (f"{BASE}/events/{e['id']}/odds?apiKey={key}&regions=us"
               f"&markets={','.join(MARKETS)}&oddsFormat=american"
               f"&date={urllib.parse.quote(d)}")
        body, hd, err = get(url)
        got, books = {}, set()
        if body:
            data = body.get("data") or {}
            for bk in data.get("bookmakers") or []:
                books.add(bk.get("key"))
                for mk in bk.get("markets") or []:
                    got[mk["key"]] = got.get(mk["key"], 0) + len(mk.get("outcomes") or [])
        r = dict(season=d[:7], event=f"{e.get('away_team','?')[:12]}@{e.get('home_team','?')[:12]}",
                 books=len(books), err=(err or "")[:40],
                 creditsLeft=hd.get("x-requests-remaining", ""))
        for m in MARKETS:
            r[m] = got.get(m, 0)
        out.append(r)
        time.sleep(0.2)
    mk = pd.DataFrame(out)
    pd.set_option("display.width", 250)
    print(mk.to_string(index=False))

    print("\n--- reading: outcome counts per market (0 = market absent at that snapshot) ---")
    if len(mk):
        print("\nearliest season each market appears:")
        for m in MARKETS:
            s = mk[mk[m] > 0]["season"]
            print(f"  {m:22s} {s.min() if len(s) else 'NEVER SEEN'}")
        print(f"\nbookmakers seen in the most recent probe: {mk.iloc[-1]['books']}")
    print(f"\ncredits remaining: {ev.creditsLeft.replace('', pd.NA).dropna().iloc[-1] if len(ev) else '?'}")
    print("\n[probe] nothing written. This was availability only.")


if __name__ == "__main__":
    main()
