#!/usr/bin/env python3
"""D-481 SHIP 2 — Backfill the ~560 lost picks from rec_cache to pick_history.

These picks were rejected by the D-204 CHECK constraint (now fixed by D-481
SHIP 1's migration). They live in rec_cache (subscriber-facing) but never
landed in pick_history (documented-WR table). We replay each through
upsert_pick_history with the canonical payload shape, adding the
mlb_market_type field that the rec_cache row doesn't carry directly.

prop_type → mlb_market_type mapping (confirmed from
process-games-mlb/index.ts:1402 / 3169 / 3178 / 3190):
  pitcher_outs   → pitcher_outs        (D-476)
  runs_scored    → batter_runs_scored  (D-475)
  strikeouts     → batter_strikeouts   (D-474)
"""
import os, sys, json, urllib.request, urllib.parse
from collections import Counter

URL = "https://gzuzuqxvfjszlfclhcfz.supabase.co"

def env_key():
    with open(os.path.expanduser("~/Desktop/betting-deploy/betgenius/.env.local")) as f:
        for line in f:
            if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""

KEY = env_key()
HEADERS = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

PROP_TO_MARKET = {
    "pitcher_outs": "pitcher_outs",
    "runs_scored": "batter_runs_scored",
    "strikeouts": "batter_strikeouts",
}

def fetch_recs(prop, offset=0, limit=1000):
    qs = urllib.parse.urlencode({
        "prop_type": f"eq.{prop}",
        "sport": "eq.mlb",
        "select": "*",
        "limit": str(limit), "offset": str(offset),
        "order": "id.asc",
    })
    url = f"{URL}/rest/v1/recommendations_cache?{qs}"
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def call_rpc(payload):
    data = json.dumps({"payload": payload}).encode("utf-8")
    req = urllib.request.Request(
        f"{URL}/rest/v1/rpc/upsert_pick_history",
        data=data, headers=HEADERS, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return True, r.read().decode()
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return False, f"HTTP {e.code}: {body[:300]}"

def make_payload(rec, market):
    """Map rec_cache row → upsert_pick_history payload (jsonb_populate_record
    handles missing/null fields gracefully)."""
    # Copy all rec_cache columns that map to pick_history; add mlb_market_type.
    p = {
        "player_name": rec.get("player_name"),
        "team": rec.get("team"),
        "opponent": rec.get("opponent"),
        "game_time": rec.get("game_time"),
        "game_date": rec.get("game_date"),
        "is_home": rec.get("is_home"),
        "prop_type": rec.get("prop_type"),
        "line": rec.get("line"),
        "pick_side": rec.get("pick_side"),
        "odds": rec.get("odds"),
        "season_avg": rec.get("season_avg"),
        "recent_avg": rec.get("recent_avg"),
        "floor_val": rec.get("floor_val"),
        "ceiling_val": rec.get("ceiling_val"),
        "confidence": rec.get("confidence"),
        "verdict": rec.get("verdict"),
        "ai_analysis": rec.get("ai_analysis"),
        "projected_stat": rec.get("projected_stat"),
        "breakdown": rec.get("breakdown"),
        # Provenance + flags
        "source": "d481-backfill",
        "recommendation_shown": (rec.get("confidence") or 0) >= 60,
        "is_synthetic": False,
        "sport": "mlb",
        "is_mlb_beta": True,
        "mlb_market_type": market,  # the D-481 fix
        # Sanity flags from rec_cache
        "unbettable_juice_flag": rec.get("unbettable_juice_flag", False),
        "coin_flip_flag": rec.get("coin_flip_flag", False),
        "negative_stacking_flag": rec.get("negative_stacking_flag", False),
        "negative_factor_count": rec.get("negative_factor_count", 0),
    }
    # Factor scores that EXIST on rec_cache + match pick_history columns
    # (jsonb_populate_record will ignore unknown keys, but we copy the ones
    # we know map 1:1)
    for k in [
        "score_pitcher_k_rate", "score_pitcher_form", "score_opposing_lineup_k",
        "score_handedness_matchup", "score_pitch_count_trend", "score_rest_pitcher",
        "score_ballpark_factor", "score_weather_wind", "score_weather_temp",
        "score_umpire_k_zone", "score_lineup_consistency",
    ]:
        if rec.get(k) is not None:
            p[k] = rec.get(k)
    return p

def main():
    print("# D-481 SHIP 2 — Backfill lost picks from rec_cache to pick_history")
    print()
    print("## Pre-backfill counts in pick_history (should be 0)")
    for prop, market in PROP_TO_MARKET.items():
        c = count_pick_history(market)
        print(f"  pick_history mlb_market_type='{market}': {c}")
    print()

    grand_total = 0
    grand_ok = 0
    grand_fail = 0
    fail_samples = []

    for prop, market in PROP_TO_MARKET.items():
        print(f"### Processing prop_type='{prop}' → mlb_market_type='{market}'")
        recs = []
        offset = 0
        while True:
            page = fetch_recs(prop, offset)
            if not page:
                break
            recs.extend(page)
            if len(page) < 1000:
                break
            offset += 1000
        print(f"  rec_cache rows to backfill: {len(recs)}")
        ok = 0; fail = 0
        for r in recs:
            payload = make_payload(r, market)
            success, msg = call_rpc(payload)
            if success:
                ok += 1
            else:
                fail += 1
                if len(fail_samples) < 5:
                    fail_samples.append((r.get("player_name"), msg[:200]))
        print(f"    ok: {ok}  fail: {fail}")
        grand_total += len(recs)
        grand_ok += ok
        grand_fail += fail
        print()

    print("## Summary")
    print(f"  Total attempted:   {grand_total}")
    print(f"  Successful:        {grand_ok}")
    print(f"  Failed:            {grand_fail}")
    if fail_samples:
        print("  Failure samples:")
        for name, m in fail_samples:
            print(f"    {name}: {m}")
    print()

    print("## Post-backfill counts in pick_history")
    for prop, market in PROP_TO_MARKET.items():
        c = count_pick_history(market)
        print(f"  pick_history mlb_market_type='{market}': {c}")

def count_pick_history(market):
    qs = urllib.parse.urlencode({
        "mlb_market_type": f"eq.{market}",
        "sport": "eq.mlb",
        "select": "count",
    })
    url = f"{URL}/rest/v1/pick_history?{qs}"
    req = urllib.request.Request(url, headers={**HEADERS, "Prefer": "count=exact", "Range": "0-0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            cr = r.headers.get("content-range", "")
            return cr.split("/")[-1] if "/" in cr else "?"
    except Exception as e:
        return f"err: {e}"

if __name__ == "__main__":
    main()
