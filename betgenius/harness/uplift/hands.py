"""Handedness: the platoon matchup, and each player's own split against it.

`features.py` has no handedness of any kind. That is the single largest gap in
the feature set, because the platoon split is the best-established effect in
baseball: a left-handed batter facing a right-handed starter is a materially
different proposition from the same batter facing a lefty, and the book prices
that difference into the number every night.

Three things are built here, and the point-in-time status of each is different:

  STATIC          `bats` and `throws` from cache_mlb_player_metadata. A player's
                  handedness does not change, so there is no as-of question to
                  get wrong and no window to leak across. Covers 91.5% of batter
                  appearances and 85.6% of pitcher appearances; the uncovered
                  tail is players with a handful of games.

  SCHEDULE        which arm starts, from cache_mlb_historical_opposing_pitcher,
                  for 100% of the priced games. Probable starters are published a
                  day or more before first pitch, which is the SAME assumption
                  `features.starters()` already makes when it attaches a starter
                  to a game. Nothing about his performance in this game is read.

  AS-OF           the player's own record against that hand, rolled up over his
                  EARLIER appearances only. This uses frames.asof_rollup with a
                  composite key, so the cut is the same strictly-earlier local
                  calendar date the rest of the pipeline uses, and check_asof.py
                  can be pointed at it.

The one thing deliberately NOT built here is anything from
cache_mlb_historical_lineups. Every row of that table was written after first
pitch, so the "confirmed lineup" it holds is the lineup that actually batted --
the game's own outcome-adjacent fact, late scratches included. The as-of
batting-order slot `features.lineup_slot()` already derives from earlier box
scores is the honest version of the same signal.
"""
import os

import numpy as np
import pandas as pd

import frames

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

_CACHE = {}


def _read(name):
    p = os.path.join(DATA, f"aux_{name}.csv")
    return pd.read_csv(p) if os.path.exists(p) else None


def available():
    return all(os.path.exists(os.path.join(DATA, f"aux_{n}.csv"))
               for n in ("player_metadata", "opposing_pitcher"))


def hand_maps():
    """player_id -> bats, player_id -> throws. Static, so cached module-wide."""
    if "bats" in _CACHE:
        return _CACHE["bats"], _CACHE["throws"]
    m = _read("player_metadata")
    if m is None:
        _CACHE["bats"], _CACHE["throws"] = {}, {}
        return {}, {}
    m = m.dropna(subset=["player_id"])
    _CACHE["bats"] = dict(zip(m["player_id"].astype(int), m["bats"].astype(str)))
    _CACHE["throws"] = dict(zip(m["player_id"].astype(int), m["throws"].astype(str)))
    return _CACHE["bats"], _CACHE["throws"]


def starter_hands(box):
    """(game_pk, team_id) -> the hand of the starter that team FACES, and his id.

    The table names the home and away starter. A team that is the away side bats
    against the HOME starter, and vice versa, so the join has to go through which
    side of the game the team is on -- `features.game_home` resolves that from
    the odds dumps' team names, which is the same route the rest of the pipeline
    takes.
    """
    if "sh" in _CACHE:
        return _CACHE["sh"]
    import features                                    # circular at module load
    o = _read("opposing_pitcher")
    gh = features.game_home(box)
    if o is None or not len(gh):
        _CACHE["sh"] = pd.DataFrame(columns=["game_pk", "team_id", "oppHand",
                                             "oppStarterId", "ownHand"])
        return _CACHE["sh"]
    o = o.dropna(subset=["game_pk"]).drop_duplicates("game_pk")
    g = gh.merge(o, on="game_pk", how="inner")
    # the away team faces the home starter; the home team faces the away starter
    away = pd.DataFrame({
        "game_pk": g["game_pk"], "team_id": g["away_id"],
        "oppHand": g["home_starter_hand"], "oppStarterId": g["home_starter_id"],
        "ownHand": g["away_starter_hand"]})
    home = pd.DataFrame({
        "game_pk": g["game_pk"], "team_id": g["home_id"],
        "oppHand": g["away_starter_hand"], "oppStarterId": g["away_starter_id"],
        "ownHand": g["home_starter_hand"]})
    out = pd.concat([away, home], ignore_index=True)
    out["oppHand"] = out["oppHand"].astype(str).str[:1].where(
        out["oppHand"].notna(), None)
    out["ownHand"] = out["ownHand"].astype(str).str[:1].where(
        out["ownHand"].notna(), None)
    _CACHE["sh"] = out
    return out


def _hand_code(s):
    """L -> 0, R -> 1, anything else -> -1 (unknown; never matched against)."""
    a = pd.Series(s).astype(str).str[:1]
    return np.where(a == "L", 0, np.where(a == "R", 1, -1)).astype(int)


def platoon_adv(bat_hand, pit_hand):
    """1 when the batter has the platoon edge, 0 when he does not, nan unknown.

    A switch hitter takes the favourable side by definition, so he always has it.
    """
    b = pd.Series(bat_hand).astype(str).str[:1].to_numpy()
    p = pd.Series(pit_hand).astype(str).str[:1].to_numpy()
    known = np.isin(b, ["L", "R", "S"]) & np.isin(p, ["L", "R"])
    adv = (b == "S") | ((b == "L") & (p == "R")) | ((b == "R") & (p == "L"))
    return np.where(known, adv.astype(float), np.nan)


def attach_history_hand(h, box, role):
    """Add `oppHand` / `ownHand` / `platoon` to a per-(player, game) history.

    `h` is what features._history builds: one row per player-appearance carrying
    player_id, game_pk, game_date and day. Nothing about the game's own result is
    read -- only which arm was announced to start it.
    """
    sh = starter_hands(box)
    if not len(sh):
        h["oppHand"], h["ownHand"], h["platoon"] = None, None, np.nan
        return h
    tm = box.drop_duplicates(["player_id", "game_pk"]).set_index(
        ["player_id", "game_pk"])["team_id"]
    idx = pd.MultiIndex.from_arrays([h["player_id"], h["game_pk"]])
    h = h.copy()
    h["team_id"] = tm.reindex(idx).to_numpy()
    k = sh.set_index(["game_pk", "team_id"])
    j = pd.MultiIndex.from_arrays([h["game_pk"], h["team_id"]])
    h["oppHand"] = k["oppHand"].reindex(j).to_numpy()
    h["ownHand"] = k["ownHand"].reindex(j).to_numpy()
    bats, throws = hand_maps()
    if role == "batter":
        own = h["player_id"].map(bats)
        h["platoon"] = platoon_adv(own, h["oppHand"])
        h["selfHand"] = own.to_numpy()
    else:
        own = h["player_id"].map(throws)
        h["platoon"] = np.nan
        h["selfHand"] = own.to_numpy()
    return h


def split_rollup(h, value_cols, windows, lag_days=0, prefix="vh_"):
    """As-of roll-up of `value_cols` keyed on (player, hand of starter faced).

    The composite key is what makes this a platoon SPLIT rather than a form
    number: a row on day D sees only that player's earlier appearances against
    the same hand. The cut is frames.asof_rollup's, unchanged -- strictly
    earlier local calendar dates -- so a placebo lag moves it exactly as it
    moves every other roll-up.
    """
    hh = h.copy()
    code = _hand_code(hh["oppHand"])
    hh["_hkey"] = hh["player_id"].astype("int64") * 4 + code
    hh.loc[code < 0, "_hkey"] = -1                      # unknown hand: own bucket
    r = frames.asof_rollup(hh, "_hkey", value_cols, windows=windows,
                           lag_days=lag_days, prefix=prefix)
    return r


# ---------------------------------------------------------------------------
# the feature hook (experiment E19 -- REJECTED, off unless UPLIFT_HANDS=1)
# ---------------------------------------------------------------------------
def split_key(h, box, market, vcols, lag_days):
    """Per-(player, game) as-of roll-up SPLIT by the hand of the starter faced.

    Called before the un-split roll-up so both share the same source frame and
    therefore the same strictly-earlier calendar-date cut.
    """
    import frames as _f
    role = _f.MARKETS[market][0]
    hh = attach_history_hand(h, box, role)
    return split_rollup(hh, vcols, windows=(25,), lag_days=lag_days,
                        prefix="vh_").set_index(["player_id", "game_pk"])


def emit_prop(d, hv_key, box, market, lines, linev, pid, gpk, prior_n):
    """Write the handedness columns onto `d`; return their names.

    Everything here is either static (bats/throws), schedule (which arm starts)
    or an as-of roll-up. Local variable names are deliberately distinct: inside
    features._build_prop the name `pf` is the fair probability at the top of the
    function but is rebound to the pitcher_form frame in the pitcher branch.
    """
    import frames as _f
    role = _f.MARKETS[market][0]
    pfair = d["pFairOver"].to_numpy(float)
    idx = pd.MultiIndex.from_arrays([d["playerId"], d["game_pk"]])
    lgrate = float(np.nan_to_num(d["statS100"].to_numpy(float)).sum()
                   / max(np.nan_to_num(d["oppS100"].to_numpy(float)).sum(), 1e-9))

    sh = starter_hands(box).set_index(["game_pk", "team_id"])
    jj = pd.MultiIndex.from_arrays([d["game_pk"], d["teamId"]])
    opp_hand = sh["oppHand"].reindex(jj).to_numpy()
    bats_m, throws_m = hand_maps()
    own_hand = (d["playerId"].map(bats_m) if role == "batter"
                else d["playerId"].map(throws_m))

    d["oppSpLhp"] = np.where(pd.isna(opp_hand), np.nan,
                             (pd.Series(opp_hand).astype(str).str[:1] == "L").astype(float))
    d["selfLh"] = np.where(own_hand.isna(), np.nan,
                           (own_hand.astype(str).str[:1] == "L").astype(float))
    d["platoon"] = (platoon_adv(own_hand, opp_hand) if role == "batter"
                    else np.full(len(d), np.nan))

    vs = np.full(len(d), np.nan)
    vn = np.full(len(d), np.nan)
    for L in lines:
        m = linev == L
        if not m.any():
            continue
        sub = pd.MultiIndex.from_arrays([pid[m], gpk[m]])
        vs[m] = hv_key[f"vh_c{L}_s25"].reindex(sub).to_numpy(float)
        vn[m] = hv_key[f"vh_c{L}_n25"].reindex(sub).to_numpy(float)
    d["vhN"] = np.nan_to_num(vn)
    d["vhClr"] = (np.nan_to_num(vs) + pfair * prior_n) / (np.nan_to_num(vn) + prior_n)
    d["vhClrEdge"] = d["vhClr"].to_numpy(float) - pfair

    vstat = hv_key["vh_stat_s25"].reindex(idx).to_numpy(float)
    vopp = hv_key["vh_opp_s25"].reindex(idx).to_numpy(float)
    vrate = (np.nan_to_num(vstat) + lgrate * prior_n) / (np.nan_to_num(vopp) + prior_n)
    d["vhRate"] = vrate
    d["vhRateRel"] = vrate / np.maximum(d["rate"].to_numpy(float), 1e-6)
    return ["oppSpLhp", "selfLh", "platoon", "vhClr", "vhClrEdge", "vhN",
            "vhRate", "vhRateRel"]
