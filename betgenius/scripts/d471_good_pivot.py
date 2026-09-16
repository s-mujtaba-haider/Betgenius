#!/usr/bin/env python3
"""D-471 SHIP 1 — GOOD-tier pivot. Mirrors D-470's LEAN methodology.

READ-ONLY. Pulls all sport=mlb, hit IS NOT NULL, 70<=confidence<=79,
-2000<=odds<=+2000 picks from pick_history and computes per-pick BE / ROI
aggregations by side, prop_type, odds-band, and side x odds-band cross-tab.
"""
import os, sys, json, urllib.parse, urllib.request
from collections import defaultdict

SUPABASE_URL = "https://gzuzuqxvfjszlfclhcfz.supabase.co"

def env_key():
    try:
        with open(os.path.expanduser("~/Desktop/betting-deploy/betgenius/.env.local")) as f:
            for line in f:
                if line.startswith("SUPABASE_SERVICE_ROLE_KEY="):
                    return line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

KEY = env_key()
if not KEY:
    sys.exit("missing SUPABASE_SERVICE_ROLE_KEY")

def fetch_page(offset, limit=1000):
    qs = urllib.parse.urlencode({
        "sport": "eq.mlb",
        "hit": "not.is.null",
        "confidence": "gte.70",
        "odds": "gte.-2000",
        "select": "confidence,pick_side,prop_type,odds,hit,is_synthetic,resolved_at",
        "limit": str(limit),
        "offset": str(offset),
        "order": "resolved_at.asc",
    })
    # Have to append the second confidence/odds filter manually (urlencode dedupes)
    url = f"{SUPABASE_URL}/rest/v1/pick_history?{qs}&confidence=lte.79&odds=lte.2000"
    req = urllib.request.Request(url, headers={
        "apikey": KEY,
        "Authorization": f"Bearer {KEY}",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())

def be_pct(odds):
    """American odds → break-even (decimal)."""
    if odds < 0:
        a = abs(odds)
        return a / (a + 100.0)
    else:
        return 100.0 / (odds + 100.0)

def roi_per_dollar(hit, odds):
    """Flat-stake ROI per $1 stake. hit bool, odds American int."""
    if hit:
        return (odds / 100.0) if odds > 0 else (100.0 / abs(odds))
    return -1.0

def odds_band(o):
    if o >= 150:    return "+150 or longer"
    if o >= 100:    return "+100 to +149"
    if o >= -110:   return "-110 to +99"
    if o >= -150:   return "-150 to -111"
    if o >= -200:   return "-200 to -151"
    if o >= -300:   return "-300 to -201"
    if o >= -500:   return "-500 to -301"
    return "-501 or worse"

BAND_ORDER = ["+150 or longer", "+100 to +149", "-110 to +99", "-150 to -111",
              "-200 to -151", "-300 to -201", "-500 to -301", "-501 or worse"]

# Fetch all GOOD-tier MLB resolved picks
rows = []
offset = 0
while True:
    page = fetch_page(offset)
    if not page:
        break
    rows.extend(page)
    if len(page) < 1000:
        break
    offset += 1000

print(f"# D-471 GOOD-tier pivot — n_total={len(rows)}")
print(f"# resolved_at range: {rows[0]['resolved_at']}  →  {rows[-1]['resolved_at']}")

real_rows = [r for r in rows if not r["is_synthetic"]]
synth_rows = [r for r in rows if r["is_synthetic"]]
print(f"# real n={len(real_rows)}  synthetic n={len(synth_rows)}")

def aggregate(label, items):
    if not items:
        return None
    n = len(items)
    wins = sum(1 for r in items if r["hit"])
    wr = wins / n * 100
    avg_odds = sum(r["odds"] for r in items) / n
    pp_be = sum(be_pct(r["odds"]) for r in items) / n * 100
    edge = wr - pp_be
    roi = sum(roi_per_dollar(r["hit"], r["odds"]) for r in items) / n * 100
    return dict(label=label, n=n, wr=wr, avg_odds=avg_odds, be=pp_be, edge=edge, roi=roi)

def print_row(r):
    print(f"  {r['label']:32s}  n={r['n']:5d}   WR={r['wr']:5.1f}%   "
          f"avg_odds={r['avg_odds']:+7.0f}   BE={r['be']:5.1f}%   "
          f"EDGE={r['edge']:+5.1f}%   ROI={r['roi']:+6.1f}%")

def section(title):
    print()
    print(f"## {title}")
    print()

# === FULL-TIER ECONOMICS (parity with D-470 baseline) ===
section("Full GOOD-tier economics (all is_synthetic)")
r = aggregate("GOOD overall", rows)
print_row(r)

section("Real GOOD-tier (is_synthetic=false — production-relevant)")
r_real = aggregate("GOOD real", real_rows)
print_row(r_real)

section("Synthetic GOOD-tier (is_synthetic=true)")
r_syn = aggregate("GOOD synth", synth_rows)
print_row(r_syn)

# Use the full cohort as the main lens (n=1,463); also report real-only as the cross-check.
MAIN = rows
LABEL_MAIN = f"full GOOD cohort (n={len(rows)})"

section(f"PIVOT BY SIDE — {LABEL_MAIN}")
by_side = defaultdict(list)
for r in MAIN:
    by_side[r["pick_side"]].append(r)
for side in sorted(by_side.keys(), key=lambda s: -len(by_side[s])):
    a = aggregate(f"side={side}", by_side[side])
    print_row(a)

section(f"PIVOT BY PROP_TYPE (n>=20) — {LABEL_MAIN}")
by_prop = defaultdict(list)
for r in MAIN:
    by_prop[r["prop_type"]].append(r)
prop_rows = []
for prop in sorted(by_prop.keys(), key=lambda p: -len(by_prop[p])):
    if len(by_prop[prop]) < 20:
        continue
    a = aggregate(prop, by_prop[prop])
    prop_rows.append(a)
    print_row(a)

# Note picks excluded by n<20
small_prop_count = sum(len(by_prop[p]) for p in by_prop if len(by_prop[p]) < 20)
print(f"  (excluded: {small_prop_count} picks across {sum(1 for p in by_prop if len(by_prop[p])<20)} small-n prop_types)")

section(f"PIVOT BY ODDS BAND — {LABEL_MAIN}")
by_band = defaultdict(list)
for r in MAIN:
    by_band[odds_band(r["odds"])].append(r)
for band in BAND_ORDER:
    if not by_band[band]:
        continue
    a = aggregate(band, by_band[band])
    print_row(a)

section(f"SIDE × ODDS BAND CROSS-TAB — {LABEL_MAIN}")
sides_of_interest = sorted({r["pick_side"] for r in MAIN},
                            key=lambda s: -sum(1 for r in MAIN if r["pick_side"] == s))
for side in sides_of_interest:
    items = [r for r in MAIN if r["pick_side"] == side]
    if len(items) < 30:
        continue
    print(f"  ── side={side} (n={len(items)}) ──")
    by_b = defaultdict(list)
    for r in items:
        by_b[odds_band(r["odds"])].append(r)
    for band in BAND_ORDER:
        if not by_b[band]:
            continue
        if len(by_b[band]) < 10:
            continue
        a = aggregate(f"{side} {band}", by_b[band])
        print_row(a)

# === WORST-CONTRIBUTOR ANALYSIS ===
section("WORST-CONTRIBUTOR ANALYSIS — which slices drive the headline ROI?")

def contribution(items):
    """Sum of per-$1 ROI contributions for these picks.
    contribution_pct = (sum of ROI per $1) / total_n * 100 — what % the slice
    contributes to overall ROI if all picks were weighted equally.
    Negative = drags headline down; positive = lifts it.
    """
    return sum(roi_per_dollar(r["hit"], r["odds"]) for r in items)

total_contrib = contribution(MAIN)
total_n = len(MAIN)
print(f"  total ΣROI/$ = {total_contrib:+.2f} on n={total_n} → headline ROI = {total_contrib/total_n*100:+.1f}%")
print()

# Side × odds-band slices ranked by ABSOLUTE NEGATIVE CONTRIBUTION
slices = []
for side, items in by_side.items():
    by_b = defaultdict(list)
    for r in items:
        by_b[odds_band(r["odds"])].append(r)
    for band, sub in by_b.items():
        if not sub:
            continue
        c = contribution(sub)
        slices.append({
            "label": f"{side} × {band}",
            "n": len(sub),
            "contrib_dollar": c,
            "roi_pct_of_headline": c / total_n * 100,
            "self_roi_pct": (c / len(sub) * 100),
        })

# Sort by most-negative contribution (biggest drag)
neg = [s for s in slices if s["contrib_dollar"] < 0]
neg.sort(key=lambda s: s["contrib_dollar"])
print("  TOP 8 NEGATIVE-CONTRIBUTING SLICES (drag headline ROI):")
print(f"    {'slice':40s}  {'n':>5s}  {'self_ROI':>9s}  {'$drag':>9s}  {'% of total':>9s}")
for s in neg[:8]:
    print(f"    {s['label']:40s}  {s['n']:>5d}  {s['self_roi_pct']:>+8.1f}%  "
          f"{s['contrib_dollar']:>+8.2f}  {s['roi_pct_of_headline']:>+8.1f}%")

pos = [s for s in slices if s["contrib_dollar"] > 0]
pos.sort(key=lambda s: -s["contrib_dollar"])
print()
print("  TOP 5 POSITIVE-CONTRIBUTING SLICES (offset some of the drag):")
print(f"    {'slice':40s}  {'n':>5s}  {'self_ROI':>9s}  {'$lift':>9s}  {'% of total':>9s}")
for s in pos[:5]:
    print(f"    {s['label']:40s}  {s['n']:>5d}  {s['self_roi_pct']:>+8.1f}%  "
          f"{s['contrib_dollar']:>+8.2f}  {s['roi_pct_of_headline']:>+8.1f}%")

# === LEAN comparison reference ===
print()
print("=" * 70)
print("REFERENCE (from D-470) — LEAN tier was: -1.6% ROI driven by:")
print("  juice-illusion. 61% of LEAN picks were heavy-juice UNDER at avg -545.")
print("  LEAN-UNDER -501+ : n=321  WR 86.3%  BE 91.9%  EDGE -5.6%  ROI -6.1%")
print("  LEAN-OVER +150+  : n=200  WR 17.5%  BE 25.3%  EDGE -7.8%  ROI -22.5%")
print("D-471 compares GOOD's shape to this baseline.")
