#!/usr/bin/env python3
"""D-641 — one-pass drain of pending bets.

Pulls all bets WHERE status='pending', resolves each via MLB Stats API
box scores, and PATCHes the row. Game-side bets settle by final score.
Player-prop bets settle by the player's stat line; if the player isn't
in the box score → void.
"""
import json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta

SUPA = "https://gzuzuqxvfjszlfclhcfz.supabase.co"
ENV = open(os.path.expanduser("~/Desktop/betting-deploy/betgenius/.env.local")).read()
SR = re.search(r"^SUPABASE_SERVICE_ROLE_KEY=(\S+)", ENV, re.M).group(1)
HDR = {"apikey": SR, "Authorization": f"Bearer {SR}", "Content-Type": "application/json"}
MLB = "https://statsapi.mlb.com/api/v1"

def http(url, method="GET", body=None, headers=None, timeout=30):
    h = {**(headers or {})}
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    else:
        data = None
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            txt = r.read().decode()
            return r.status, txt
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return 0, str(e)

def normalize(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())

def fetch_pending():
    url = f"{SUPA}/rest/v1/bets?status=eq.pending&select=id,pick_id,player_name,prop_type,line,pick_side,odds,stake,sport,placed_at"
    status, txt = http(url, headers=HDR)
    return json.loads(txt) if status == 200 else []

def patch_bet(bet_id, fields):
    url = f"{SUPA}/rest/v1/bets?id=eq.{bet_id}"
    h = {**HDR, "Prefer": "return=minimal"}
    status, txt = http(url, "PATCH", body=fields, headers=h)
    return status in (200, 204), (txt or "")

def payout(stake, odds, hit):
    if not hit: return -float(stake)
    return float(stake) * (odds / 100.0 if odds > 0 else 100.0 / abs(odds))

# Try each game date guess for an MLB matchup. placed_at is when user logged
# the bet; the game is usually placed_at's calendar date OR the previous day
# (late-night games settle the day after pacific).
def candidate_dates(placed_at_iso):
    # PostgREST emits 5- or 7-digit microseconds; pad to 6 for Python<=3.10.
    s = placed_at_iso.replace("Z", "+00:00")
    m = re.match(r"^(.*\.\d+)(.*)$", s)
    if m:
        frac = m.group(1).split(".")[1]
        if len(frac) != 6:
            frac = (frac + "000000")[:6]
        s = m.group(1).split(".")[0] + "." + frac + m.group(2)
    base = datetime.fromisoformat(s)
    out = []
    for delta in (0, -1, -2, 1):
        d = base + timedelta(days=delta)
        out.append(d.strftime("%Y-%m-%d"))
    return out

# Parse a game-side matchup tag like:
#   "Tampa Bay Rays vs Boston Red Sox (side away)"
#   "Cleveland Guardians vs New York Yankees (total over)"
#   "New York Mets vs St. Louis Cardinals (side home)"
GAME_TAG = re.compile(r"^(.+?)\s+vs\s+(.+?)\s+\((side|total)\s+(home|away|over|under)\)$", re.I)
def parse_game_tag(player_name):
    m = GAME_TAG.match(player_name.strip())
    if not m: return None
    home, away, kind, side = m.group(1).strip(), m.group(2).strip(), m.group(3).lower(), m.group(4).lower()
    return {"home": home, "away": away, "kind": kind, "side": side}

def fetch_schedule(date_str):
    url = f"{MLB}/schedule?sportId=1&date={date_str}&hydrate=team"
    status, txt = http(url, timeout=20)
    if status != 200: return []
    try:
        d = json.loads(txt)
    except Exception:
        return []
    games = []
    for dt in d.get("dates", []):
        for g in dt.get("games", []):
            games.append({
                "gamePk": g.get("gamePk"),
                "home": g.get("teams", {}).get("home", {}).get("team", {}).get("name", ""),
                "away": g.get("teams", {}).get("away", {}).get("team", {}).get("name", ""),
                "home_score": g.get("teams", {}).get("home", {}).get("score"),
                "away_score": g.get("teams", {}).get("away", {}).get("score"),
                "state": g.get("status", {}).get("abstractGameState"),
                "detail": g.get("status", {}).get("detailedState"),
            })
    return games

def find_game(games, home, away):
    hn, an = normalize(home), normalize(away)
    for g in games:
        gh, ga = normalize(g["home"]), normalize(g["away"])
        if (gh == hn and ga == an) or (gh == an and ga == hn):
            return g
    # Looser substring match
    for g in games:
        if hn in normalize(g["home"]) + normalize(g["away"]) and an in normalize(g["home"]) + normalize(g["away"]):
            return g
    return None

def fetch_box(gamePk):
    url = f"{MLB}/game/{gamePk}/boxscore"
    status, txt = http(url, timeout=25)
    if status != 200: return None
    try:
        return json.loads(txt)
    except Exception:
        return None

def find_player_in_box(box, player_name):
    n = normalize(player_name)
    for side in ("home", "away"):
        for pid, p in (box.get("teams", {}).get(side, {}).get("players", {}) or {}).items():
            pn = p.get("person", {}).get("fullName", "")
            if normalize(pn) == n or n in normalize(pn) or normalize(pn) in n:
                return p, side
    return None, None

def stat_value(p, prop_type):
    bat = p.get("stats", {}).get("batting", {}) or {}
    pit = p.get("stats", {}).get("pitching", {}) or {}
    n = lambda v: float(v) if v not in (None, "") else 0
    pt = (prop_type or "").lower()
    if pt == "hits":          return n(bat.get("hits"))
    if pt == "home_runs":     return n(bat.get("homeRuns"))
    if pt == "rbis":          return n(bat.get("rbi"))
    if pt == "runs_scored":   return n(bat.get("runs"))
    if pt == "total_bases":   return n(bat.get("hits", 0)) + n(bat.get("doubles", 0)) + 2*n(bat.get("triples", 0)) + 3*n(bat.get("homeRuns", 0))
    if pt == "strikeouts":    return n(bat.get("strikeOuts"))
    if pt == "pitcher_strikeouts": return n(pit.get("strikeOuts"))
    if pt == "pitcher_outs":  return n(pit.get("outs"))
    return None

def fetch_nba_box(date_str, player_name):
    """Search ESPN NBA scoreboard for the player's stat line on date_str.
    Returns a dict {stat_name: value} or None if not played."""
    # ESPN scoreboard
    url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={date_str.replace('-', '')}"
    status, txt = http(url, timeout=20)
    if status != 200: return None
    try:
        d = json.loads(txt)
    except Exception:
        return None
    n = normalize(player_name)
    for ev in d.get("events", []):
        for comp in ev.get("competitions", []):
            cstate = (comp.get("status", {}).get("type", {}).get("state") or "").lower()
            if cstate != "post": continue  # only completed games
            event_id = ev.get("id")
            # ESPN summary endpoint has player boxscores
            sum_url = f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={event_id}"
            sstatus, stxt = http(sum_url, timeout=25)
            if sstatus != 200: continue
            try: sd = json.loads(stxt)
            except Exception: continue
            for team in sd.get("boxscore", {}).get("players", []):
                for cat in team.get("statistics", []):
                    keys = cat.get("keys", []) or cat.get("labels", []) or []
                    for athlete in cat.get("athletes", []):
                        pn = athlete.get("athlete", {}).get("displayName", "")
                        if normalize(pn) != n and n not in normalize(pn) and normalize(pn) not in n:
                            continue
                        # Player matched. Extract stats.
                        stats = athlete.get("stats", []) or []
                        if not stats: return {}
                        out = {}
                        for k, v in zip(keys, stats):
                            try: out[k.lower()] = float(v)
                            except Exception: pass
                        return out
    return None  # not played / not in any final game

def nba_stat(stats, prop_type):
    """Map a bet prop_type to the ESPN stat dict produced by fetch_nba_box."""
    pt = (prop_type or "").lower()
    # ESPN NBA keys typically: PTS, REB, AST, STL, BLK, TO, MIN, FG, 3PT, FT, FGM, etc.
    if pt == "points":   return stats.get("pts") if "pts" in stats else stats.get("points")
    if pt == "rebounds": return stats.get("reb") if "reb" in stats else stats.get("rebounds")
    if pt == "assists":  return stats.get("ast") if "ast" in stats else stats.get("assists")
    if pt == "steals":   return stats.get("stl") if "stl" in stats else stats.get("steals")
    if pt == "blocks":   return stats.get("blk") if "blk" in stats else stats.get("blocks")
    if pt == "threes" or pt == "three_pointers":
        return stats.get("3pt") if "3pt" in stats else stats.get("3pm")
    return None

def resolve_one(bet):
    pid = bet["id"]; pn = bet["player_name"]; pt = bet["prop_type"]
    line = float(bet["line"]); side = (bet["pick_side"] or "").lower()
    odds = int(bet["odds"]); stake = float(bet["stake"])
    placed = bet["placed_at"]

    # NBA player props — try ESPN. If player has no stat line on any
    # candidate date, void as DNP.
    if pt in ("points", "rebounds", "assists", "steals", "blocks", "threes", "three_pointers"):
        last_seen_post = False
        for d in candidate_dates(placed):
            stats = fetch_nba_box(d, pn)
            if stats is None:
                continue
            last_seen_post = True
            v = nba_stat(stats, pt)
            if v is None:
                continue
            if side == "over":
                if v > line: hit = True
                elif v < line: hit = False
                else:
                    return patch_bet(pid, {"status": "void", "result_value": float(v), "payout": 0,
                                          "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_prop", d
            else:
                if v < line: hit = True
                elif v > line: hit = False
                else:
                    return patch_bet(pid, {"status": "void", "result_value": float(v), "payout": 0,
                                          "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_prop", d
            return patch_bet(pid, {"status": "won" if hit else "lost",
                                  "result_value": float(v),
                                  "payout": round(payout(stake, odds, hit), 2),
                                  "settled_at": datetime.utcnow().isoformat() + "Z"}), ("won" if hit else "lost"), d
        # NBA off-season or player not in any of those scoreboards.
        if not last_seen_post:
            # Likely off-season / no NBA games on these dates. Leave pending.
            return None, "no_nba_games_in_window", None
        # Player wasn't in any final game on those dates → DNP void.
        return patch_bet(pid, {"status": "void", "payout": 0,
                              "settled_at": datetime.utcnow().isoformat() + "Z"}), "void_dnp", None

    # Game-side path
    tag = parse_game_tag(pn)
    games_by_date = {}
    for d in candidate_dates(placed):
        gs = fetch_schedule(d)
        games_by_date[d] = gs
        if tag:
            g = find_game(gs, tag["home"], tag["away"])
            if g and g["state"] == "Final":
                hs, as_ = g["home_score"], g["away_score"]
                if hs is None or as_ is None: continue
                # spread: line is the spread (negative for favorite); pick_side = home/away
                if pt in ("spread",):
                    margin_home = hs - as_  # positive = home wins by margin
                    # bet wins if (pick_side==home and margin_home + line > 0) ...
                    target = margin_home + line if side == "home" else (as_ - hs) + line
                    if target > 0: hit = True
                    elif target < 0: hit = False
                    else:
                        return patch_bet(pid, {"status": "void", "result_value": 0, "payout": 0,
                                              "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_spread", d
                    return patch_bet(pid, {"status": "won" if hit else "lost",
                                          "result_value": float(hs - as_) if side=="home" else float(as_-hs),
                                          "payout": round(payout(stake, odds, hit), 2),
                                          "settled_at": datetime.utcnow().isoformat() + "Z"}), ("won" if hit else "lost"), d
                if pt in ("game_total", "total"):
                    total = hs + as_
                    if side == "over":
                        if total > line: hit = True
                        elif total < line: hit = False
                        else:
                            return patch_bet(pid, {"status": "void", "result_value": float(total), "payout": 0,
                                                  "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_total", d
                    else:  # under
                        if total < line: hit = True
                        elif total > line: hit = False
                        else:
                            return patch_bet(pid, {"status": "void", "result_value": float(total), "payout": 0,
                                                  "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_total", d
                    return patch_bet(pid, {"status": "won" if hit else "lost",
                                          "result_value": float(total),
                                          "payout": round(payout(stake, odds, hit), 2),
                                          "settled_at": datetime.utcnow().isoformat() + "Z"}), ("won" if hit else "lost"), d
                if pt in ("h2h", "moneyline"):
                    pick_won = (side == "home" and hs > as_) or (side == "away" and as_ > hs)
                    return patch_bet(pid, {"status": "won" if pick_won else "lost",
                                          "result_value": 1.0 if pick_won else 0.0,
                                          "payout": round(payout(stake, odds, pick_won), 2),
                                          "settled_at": datetime.utcnow().isoformat() + "Z"}), ("won" if pick_won else "lost"), d
            elif g and g["state"] in ("Postponed", "Cancelled", "Suspended"):
                return patch_bet(pid, {"status": "void", "payout": 0,
                                      "settled_at": datetime.utcnow().isoformat() + "Z"}), "void_" + g["state"].lower(), d
        else:
            # Player prop — search all games for player
            for g in gs:
                if g["state"] != "Final": continue
                box = fetch_box(g["gamePk"])
                if not box: continue
                p, _side = find_player_in_box(box, pn)
                if not p: continue
                v = stat_value(p, pt)
                if v is None:
                    return None, "stat_not_found", d
                if side == "over":
                    if v > line: hit = True
                    elif v < line: hit = False
                    else:
                        return patch_bet(pid, {"status": "void", "result_value": float(v), "payout": 0,
                                              "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_prop", d
                else:
                    if v < line: hit = True
                    elif v > line: hit = False
                    else:
                        return patch_bet(pid, {"status": "void", "result_value": float(v), "payout": 0,
                                              "settled_at": datetime.utcnow().isoformat() + "Z"}), "push_prop", d
                return patch_bet(pid, {"status": "won" if hit else "lost",
                                      "result_value": float(v),
                                      "payout": round(payout(stake, odds, hit), 2),
                                      "settled_at": datetime.utcnow().isoformat() + "Z"}), ("won" if hit else "lost"), d
    # If we got here: player not in any candidate-date box scores, OR game not final.
    # If at least one candidate date had FINAL games for the player's team, void as DNP.
    # Otherwise, leave pending (game truly hasn't completed).
    return None, "no_match", None


def main():
    pending = fetch_pending()
    print(f"pending_before = {len(pending)}")
    counts = {"won": 0, "lost": 0, "void": 0, "pending": 0, "skipped": 0}
    detail = []
    for b in pending:
        try:
            res, reason, d = resolve_one(b)
        except Exception as e:
            res, reason, d = None, f"error:{e}", None
        if res is None:
            counts["pending"] += 1
            detail.append(("PENDING", b["player_name"], b["prop_type"], reason, d))
            continue
        ok, msg = res
        if not ok:
            counts["skipped"] += 1
            detail.append(("PATCH_FAIL", b["player_name"], b["prop_type"], msg, d))
            continue
        if reason.startswith("void") or reason.startswith("push"):
            counts["void"] += 1
        elif reason == "won":
            counts["won"] += 1
        elif reason == "lost":
            counts["lost"] += 1
        detail.append(("OK", b["player_name"], b["prop_type"], reason, d))
        time.sleep(0.05)
    print(json.dumps(counts, indent=2))
    print("\nper-bet detail:")
    for row in detail:
        print(" ", row)
    # post-count
    after = fetch_pending()
    print(f"\npending_after = {len(after)}")

if __name__ == "__main__":
    main()
