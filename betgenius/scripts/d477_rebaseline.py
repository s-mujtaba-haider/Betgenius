#!/usr/bin/env python3
"""D-477 SHIP 1 — Real-only tier economics re-baseline.

READ-ONLY. Pulls all sport in (mlb, nba) resolved REAL (via pick_history_real
view), sane odds (-2000 ≤ odds ≤ +2000), and computes per-tier n, WR, avg
odds, per-pick BE, EDGE, ROI for both lifetime + 30d windows.

Mirrors D-470's per-tier table methodology but uses pick_history_real (the
canonical real-picks view created in D-477) instead of pick_history directly.

Output ranks tiers by ROI within each (sport, window) so we can see whether
the calibration ordering holds when contamination is removed.
"""
import os, sys, json, urllib.parse, urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta

URL = "https://gzuzuqxvfjszlfclhcfz.supabase.co"

def env_key():
    with open(os.path.expanduser("~/Desktop/betting-deploy/betgenius/.env.local")) as f:
        for line in f:
            if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                return line.split("=", 1)[1].strip().strip('"')
    return ""

KEY = env_key()
if not KEY:
    sys.exit("missing SUPABASE_SERVICE_ROLE_KEY")

def fetch_page(sport, offset, limit=1000):
    """Query the D-477 pick_history_real view directly.
    The view's WHERE clause embeds the canonical synthetic/quarantine/void/
    null-date filter, so the API surface stays clean. PostgREST cannot
    express SQL COALESCE(field, false)=false via inline filters when one
    of the field's possible values is NULL (e.g. is_d214_quarantined on
    MLB rows) — the view solves this by applying COALESCE server-side.
    """
    qs = urllib.parse.urlencode({
        "sport": f"eq.{sport}",
        "odds": "gte.-2000",
        "select": "confidence,odds,hit,resolved_at,game_date,pick_side,prop_type",
        "limit": str(limit), "offset": str(offset),
        "order": "resolved_at.asc",
    })
    u = f"{URL}/rest/v1/pick_history_real?{qs}&odds=lte.2000"
    req = urllib.request.Request(u, headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())

def fetch_all(sport):
    rows = []; offset = 0
    while True:
        page = fetch_page(sport, offset)
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    return rows

def be(o):
    return abs(o)/(abs(o)+100.0) if o<0 else 100.0/(o+100.0)
def roi_dollar(hit, o):
    return ((o/100.0) if o>0 else (100.0/abs(o))) if hit else -1.0
def tier_of(c):
    if c >= 90: return "ELITE 90+"
    if c >= 80: return "STRONG 80-89"
    if c >= 70: return "GOOD 70-79"
    if c >= 60: return "LEAN 60-69"
    return "PASS <60"

TIER_ORDER = ["ELITE 90+", "STRONG 80-89", "GOOD 70-79", "LEAN 60-69", "PASS <60"]

def aggregate(items):
    if not items: return None
    n = len(items)
    wins = sum(1 for r in items if r["hit"])
    wr = wins/n*100
    avg_o = sum(r["odds"] for r in items)/n
    bep = sum(be(r["odds"]) for r in items)/n*100
    edge = wr - bep
    roi = sum(roi_dollar(r["hit"], r["odds"]) for r in items)/n*100
    return dict(n=n, wr=wr, avg_odds=avg_o, be=bep, edge=edge, roi=roi)

def print_table(label, by_tier):
    print(f"## {label}")
    print()
    print(f"  {'Tier':14s} {'n':>6s}  {'WR':>6s}  {'avg_odds':>9s}  {'BE':>6s}  {'EDGE':>7s}  {'ROI':>7s}")
    print(f"  {'-'*14} {'-'*6}  {'-'*6}  {'-'*9}  {'-'*6}  {'-'*7}  {'-'*7}")
    for tier in TIER_ORDER:
        a = by_tier.get(tier)
        if not a:
            print(f"  {tier:14s} {'(none)':>6s}")
            continue
        print(f"  {tier:14s} {a['n']:>6d}  {a['wr']:>5.1f}%  "
              f"{a['avg_odds']:>+8.0f}  {a['be']:>5.1f}%  "
              f"{a['edge']:>+6.1f}%  {a['roi']:>+6.1f}%")
    print()

def now_utc():
    return datetime.now(timezone.utc)

# 30d window cutoff (compare resolved_at OR game_date::ts)
def is_30d(r, now):
    cut = now - timedelta(days=30)
    if r["resolved_at"]:
        try:
            ts = datetime.fromisoformat(r["resolved_at"].replace("Z","+00:00"))
            return ts >= cut
        except Exception:
            pass
    if r["game_date"]:
        try:
            ts = datetime.fromisoformat(r["game_date"]).replace(tzinfo=timezone.utc)
            return ts >= cut
        except Exception:
            pass
    return False

now = now_utc()
print(f"# D-477 real-only tier re-baseline (via pick_history_real view, sane odds)")
print(f"# Generated: {now.isoformat()}")
print()

for sport in ["mlb", "nba"]:
    rows = fetch_all(sport)
    print(f"# Sport {sport} — total real+sane-odds rows: {len(rows)}")

    # LIFETIME
    by_tier = defaultdict(list)
    for r in rows: by_tier[tier_of(r["confidence"])].append(r)
    by_tier_agg = {t: aggregate(items) for t, items in by_tier.items()}
    print_table(f"{sport.upper()} LIFETIME real-only", by_tier_agg)

    # 30d
    rows_30 = [r for r in rows if is_30d(r, now)]
    by_tier_30 = defaultdict(list)
    for r in rows_30: by_tier_30[tier_of(r["confidence"])].append(r)
    by_tier_30_agg = {t: aggregate(items) for t, items in by_tier_30.items()}
    print_table(f"{sport.upper()} 30d real-only (resolved_at OR game_date>=now-30d)", by_tier_30_agg)

    # STRONG + ELITE blended (the sellable number)
    se = by_tier_agg.get("ELITE 90+", {"n":0}).get("n",0) and (
         by_tier["ELITE 90+"] + by_tier["STRONG 80-89"])
    if se:
        ag = aggregate(by_tier["ELITE 90+"] + by_tier["STRONG 80-89"])
        print(f"  {sport.upper()} STRONG+ELITE blended LIFETIME: "
              f"n={ag['n']}, WR={ag['wr']:.1f}%, EDGE={ag['edge']:+.1f}%, ROI={ag['roi']:+.1f}%")
    se30 = by_tier_30["ELITE 90+"] + by_tier_30["STRONG 80-89"]
    if se30:
        ag = aggregate(se30)
        print(f"  {sport.upper()} STRONG+ELITE blended 30d:       "
              f"n={ag['n']}, WR={ag['wr']:.1f}%, EDGE={ag['edge']:+.1f}%, ROI={ag['roi']:+.1f}%")
    print()

# === DIFF vs D-470 contaminated numbers ===
print()
print("=" * 80)
print("## DIFF vs D-470 (contaminated, sample of 10,000 from pick_history)")
print()
print("  D-470 reported (MLB 30d, contaminated by synthetic-backfill):")
print("    Tier            n      WR    BE     EDGE      ROI")
print("    ELITE 90+      176   58.5%   55.2%  +3.4%    +4.1%")
print("    STRONG 80-89   205   58.5%   53.9%  +4.7%    +9.9%")
print("    GOOD 70-79     486   53.7%   54.5%  -0.8%    -6.1%   ← under suspicion (D-471 confirmed half artifact)")
print("    LEAN 60-69   1,566   61.5%   62.1%  -0.6%    -1.6%")
print("    PASS <60     5,562   46.0%   52.5%  -6.6%   -15.5%")
print()
print("  Compare to D-477 MLB LIFETIME real-only (above) — the true documented baseline.")
print("  Cells that SHIFT materially vs D-470 are flagged in d477_rebaseline.md.")
