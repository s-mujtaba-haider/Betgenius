"""Point-in-time features, and the per-market statistical model behind them.

Two families, both built only from box scores that finished on an EARLIER local
calendar date than the game being bet:

  empirical   how often this player/team has already cleared THIS number, over
              the last 25 and last 100 appearances. The oldest prop handicap
              there is, and the one that carries signal the price has not fully
              absorbed.
  parametric  a count/continuous model appropriate to the market -- Poisson for
              hits, total bases, RBIs, home runs, runs and strikeouts; a normal
              approximation for outs and game totals; a run-differential model
              for h2h and spreads -- evaluated at the posted line.

Both are handed to the calibration stage as candidate signals alongside the
market's own de-vigged price. Nothing here decides a bet on its own.
"""
import numpy as np
import pandas as pd
from scipy import stats

import frames

W = (25, 100)

# batter/pitcher markets: the stat, and the opportunity it accrues over
OPP = {
    "batter_hits": "at_bats",
    "batter_total_bases": "at_bats",
    "batter_home_runs": "at_bats",
    "batter_rbis": "plate_appearances",
    "batter_runs_scored": "plate_appearances",
    "batter_strikeouts": "plate_appearances",
    "pitcher_strikeouts": "batters_faced",
    "pitcher_outs": "batters_faced",
}
# league prior used to shrink a thin player history toward something sane
PRIOR_N = 40.0
LEAGUE_RPG = 4.5          # runs per team-game
RUNDIFF_SD = 4.3          # sd of a game's run differential / total residual


def _logit(p):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _poisson_over(lam, line):
    """P(count > line). Exact for a half-integer line and for an integer one."""
    lam = np.clip(np.asarray(lam, float), 1e-6, None)
    k = np.floor(np.asarray(line, float))
    return 1.0 - stats.poisson.cdf(k, lam)


def _normal_over(mu, sd, line):
    sd = np.clip(np.asarray(sd, float), 1e-3, None)
    return 1.0 - stats.norm.cdf(np.asarray(line, float), loc=mu, scale=sd)


def _history(market, box):
    """One row per player appearance, with a clear-indicator per distinct line."""
    role, col, kind = frames.MARKETS[market]
    opp = OPP[market]
    mask = box["at_bats"].notna() if role == "batter" else box["innings_pitched"].notna()
    h = box[mask][["player_id", "game_pk", "game_date", "team_id", col, opp]].copy()
    h["day"] = frames.to_day(h["game_date"])
    return h.rename(columns={col: "stat", opp: "opp"})


def _team_history(market, box):
    """What each team's opponents did to it, per team-game: the allowance rate."""
    role, col, kind = frames.MARKETS[market]
    opp = OPP[market]
    mask = box["at_bats"].notna() if role == "batter" else box["innings_pitched"].notna()
    side = box[mask][["game_pk", "game_date", "team_id", col, opp]].copy()
    per = side.groupby(["game_pk", "game_date", "team_id"], as_index=False)[[col, opp]].sum()
    tot = per.groupby("game_pk")[[col, opp]].transform("sum")
    per["allow"] = tot[col] - per[col]
    per["allow_opp"] = tot[opp] - per[opp]
    per["day"] = frames.to_day(per["game_date"])
    return per[["game_pk", "team_id", "day", "allow", "allow_opp"]]


def starters(box):
    """The starting pitcher of each team-game, with his as-of workload rates.

    Probable starters are published a day or more before first pitch, so which
    arm starts is known at bet time; the RATES attached to him here are as-of
    and never include the game being bet.
    """
    p = box[(box["position_type"] == "Pitcher") & (box["innings_pitched"].notna())].copy()
    p["day"] = frames.to_day(p["game_date"])
    p["ip_outs"] = p["outs_derived"]
    r = frames.asof_rollup(p, "player_id",
                           ["ip_outs", "strikeouts", "batters_faced", "pitcher_runs"],
                           windows=(25,), lag_days=0, prefix="sp_")
    st = r[r["is_starter"] == True]                                   # noqa: E712
    outs = st["sp_ip_outs_s25"].to_numpy(float)
    bf = st["sp_batters_faced_s25"].to_numpy(float)
    n = st["sp_ip_outs_n25"].to_numpy(float)
    st = st.assign(
        spRunPerOut=np.where(outs > 0, st["sp_pitcher_runs_s25"] / np.maximum(outs, 1.0), np.nan),
        spKPerBf=np.where(bf > 0, st["sp_strikeouts_s25"] / np.maximum(bf, 1.0), np.nan),
        spOutsPerGame=np.where(n > 0, outs / np.maximum(n, 1.0), np.nan),
        spN=n,
    )
    return st[["game_pk", "team_id", "player_id", "spRunPerOut", "spKPerBf",
               "spOutsPerGame", "spN"]].drop_duplicates(["game_pk", "team_id"])


def rest_days(box, key="player_id"):
    """Days since this player's previous appearance, capped at 10."""
    b = box[box["at_bats"].notna() | box["innings_pitched"].notna()][[key, "game_date", "game_pk"]].copy()
    b["day"] = frames.to_day(b["game_date"])
    b = b.sort_values([key, "day"], kind="stable")
    prev = b.groupby(key)["day"].shift(1)
    b["restDays"] = np.clip(b["day"] - prev, 0, 10)
    return b.set_index([key, "game_pk"])["restDays"]


def lineup_slot(box):
    """As-of batting-order slot and starter share over the last 25 games."""
    b = box[box["at_bats"].notna()][["player_id", "game_pk", "game_date",
                                     "batting_order_slot", "is_starter"]].copy()
    b["day"] = frames.to_day(b["game_date"])
    b["slot"] = pd.to_numeric(b["batting_order_slot"], errors="coerce")
    b["startf"] = b["is_starter"].astype(float)
    r = frames.asof_rollup(b, "player_id", ["slot", "startf"], windows=(25,), lag_days=0)
    s, sn = r["slot_s25"].to_numpy(float), r["slot_n25"].to_numpy(float)
    f, fn = r["startf_s25"].to_numpy(float), r["startf_n25"].to_numpy(float)
    r = r.assign(slot25=np.where(sn > 0, s / np.maximum(sn, 1.0), np.nan),
                 startShare25=np.where(fn > 0, f / np.maximum(fn, 1.0), np.nan))
    return r.set_index(["player_id", "game_pk"])[["slot25", "startShare25"]]


_GAME_PRICES = {}


def game_prices():
    """The game's own market numbers, per game: total, moneyline, runline.

    The roadmap asks for the expected game total and the implied team total in
    almost every market, and the sharpest estimate of a game's run environment
    is not a team-form model -- it is the number the market itself is posting on
    that game. All three come from the same entry snapshot as the candidate
    being priced, so nothing here is known any later than the bet is placed.

    It also makes each game market aware of the other two. A runline price is a
    function of the moneyline and the total; a spread model that cannot see them
    is throwing away the two numbers that determine it.
    """
    if _GAME_PRICES:
        return _GAME_PRICES["frame"]
    parts = []
    for m, cols in (("totals", ("mktTotalLine", "mktTotalOverP")),
                    ("h2h", (None, "mktHomeWinP")),
                    ("spreads", ("mktSpreadLine", "mktHomeCoverP"))):
        try:
            c = frames.read_market(m)
        except FileNotFoundError:
            continue
        c = c[c["p_fair_over"].notna()]
        # one row per game: the most-quoted line, which is the main number
        c = (c.sort_values("n_books", ascending=False)
               .drop_duplicates("game_pk")[["game_pk", "line", "p_fair_over"]])
        ren = {"p_fair_over": cols[1]}
        if cols[0]:
            ren["line"] = cols[0]
        else:
            c = c.drop(columns=["line"])
        parts.append(c.rename(columns=ren).set_index("game_pk"))
    out = pd.concat(parts, axis=1) if parts else pd.DataFrame()
    if "mktTotalLine" in out and "mktHomeWinP" in out:
        # implied team totals, the standard decomposition of the two numbers
        edge = (out["mktHomeWinP"] - 0.5) * 2.4      # runs of expected margin
        out["mktHomeTeamTotal"] = out["mktTotalLine"] / 2 + edge / 2
        out["mktAwayTeamTotal"] = out["mktTotalLine"] / 2 - edge / 2
    _GAME_PRICES["frame"] = out
    return out


def team_offense(box):
    """A team's own as-of on-base rate and run rate, per team-game.

    RBIs and runs scored are opportunity markets before they are skill markets:
    what matters most is how often someone is on base ahead of this batter and
    how many runs his side scores. Both are team properties and both are
    knowable before first pitch.
    """
    b = box[box["at_bats"].notna()].copy()
    b["onbase"] = b["hits"].fillna(0) + b["batter_walks"].fillna(0)
    per = b.groupby(["game_pk", "game_date", "team_id"], as_index=False).agg(
        onbase=("onbase", "sum"), pa=("plate_appearances", "sum"))
    ts = frames.team_scores(box).set_index(["game_pk", "team_id"])
    idx = pd.MultiIndex.from_arrays([per["game_pk"], per["team_id"]])
    per["scored"] = ts["scored"].reindex(idx).to_numpy(float)
    per["allowed"] = ts["allowed"].reindex(idx).to_numpy(float)
    per["day"] = frames.to_day(per["game_date"])
    r = frames.asof_rollup(per, "team_id", ["onbase", "pa", "scored", "allowed"],
                           windows=(25,), lag_days=0, prefix="to_")
    pa = r["to_pa_s25"].to_numpy(float)
    n = r["to_scored_n25"].to_numpy(float)
    r = r.assign(
        teamObp25=np.where(pa > 0, r["to_onbase_s25"] / np.maximum(pa, 1.0), np.nan),
        teamRpg25=np.where(n > 0, r["to_scored_s25"] / np.maximum(n, 1.0), np.nan),
        teamRapg25=np.where(n > 0, r["to_allowed_s25"] / np.maximum(n, 1.0), np.nan))
    return r.set_index(["game_pk", "team_id"])[["teamObp25", "teamRpg25", "teamRapg25"]]


def _game_history(box):
    """Per team-game runs scored and allowed, for the three game markets."""
    ts = frames.team_scores(box)
    gd = box.drop_duplicates("game_pk").set_index("game_pk")["game_date"]
    ts["game_date"] = ts["game_pk"].map(gd)
    ts = ts[ts["game_date"].notna()].copy()
    ts["day"] = frames.to_day(ts["game_date"])
    return ts


def _mean_of(key, idx, stem, w):
    s = key[f"{stem}_s{w}"].reindex(idx).to_numpy(float)
    n = key[f"{stem}_n{w}"].reindex(idx).to_numpy(float)
    return np.where(n > 0, s / np.maximum(n, 1.0), np.nan), n


def _build_game(market, d, box, lag_days):
    gh = _game_history(box)
    gh = frames.asof_rollup(gh, "team_id", ["scored", "allowed"], windows=W,
                            lag_days=lag_days)
    key = gh.set_index(["game_pk", "team_id"])
    k = 10.0
    for tag, tid in (("h", "home_id"), ("a", "away_id")):
        idx = pd.MultiIndex.from_arrays([d["game_pk"], d[tid]])
        for w in W:
            for stem, short in (("scored", "sco"), ("allowed", "all")):
                m, n = _mean_of(key, idx, stem, w)
                eff = np.minimum(np.nan_to_num(n), w)
                # shrink a short team history toward the league rate
                d[f"{tag}{short}{w}"] = (np.nan_to_num(m) * eff + LEAGUE_RPG * k) / (eff + k)
        d[f"{tag}n"] = _mean_of(key, idx, "scored", W[0])[1]

    d["expHome"] = d["hsco25"] * d["aall25"] / LEAGUE_RPG
    d["expAway"] = d["asco25"] * d["hall25"] / LEAGUE_RPG
    d["expTotal"] = d["expHome"] + d["expAway"]
    d["expMargin"] = d["expHome"] - d["expAway"] + 0.20       # home-field, in runs

    if market == "totals":
        d["parP"] = _poisson_over(d["expTotal"], d["line"])
        d["empP"] = _normal_over(d["expTotal"], RUNDIFF_SD, d["line"])
    elif market == "h2h":
        d["parP"] = 1.0 / (1.0 + np.exp(-d["expMargin"] / 1.55))
        d["empP"] = _normal_over(d["expMargin"], RUNDIFF_SD, 0.0)
    else:   # spreads: the home side covers when margin + line > 0
        d["parP"] = _normal_over(d["expMargin"], RUNDIFF_SD, -d["line"].to_numpy(float))
        d["empP"] = d["parP"]

    st = starters(box).set_index(["game_pk", "team_id"])
    for tag, tid in (("h", "home_id"), ("a", "away_id")):
        idx = pd.MultiIndex.from_arrays([d["game_pk"], d[tid]])
        for c in ("spRunPerOut", "spKPerBf", "spOutsPerGame"):
            d[f"{tag}{c}"] = st[c].reindex(idx).to_numpy(float)
    d["spRunGap"] = d["aspRunPerOut"] - d["hspRunPerOut"]   # + favours the home side

    gp = game_prices()
    for c in gp.columns:
        d[c] = gp[c].reindex(d["game_pk"]).to_numpy(float)
    d["mktMargin"] = d["mktHomeTeamTotal"] - d["mktAwayTeamTotal"]

    d["nHist"] = d[["hn", "an"]].min(axis=1)
    cols = ["pLogit", "parP", "empP", "expTotal", "expMargin",
            "mktTotalLine", "mktTotalOverP", "mktHomeWinP", "mktHomeCoverP",
            "mktSpreadLine", "mktHomeTeamTotal", "mktAwayTeamTotal", "mktMargin",
            "hsco25", "hall25", "asco25", "aall25", "overround", "line", "nHist",
            "hspRunPerOut", "aspRunPerOut", "hspOutsPerGame", "aspOutsPerGame",
            "spRunGap", "dispOver", "dispUnder", "nBooks"]
    return d, cols


def _build_prop(market, d, box, lag_days):
    lines = np.sort(d["line"].unique())
    h = _history(market, box)
    for L in lines:
        h[f"c{L}"] = (h["stat"] > L).astype(float).where(h["stat"].notna())
    vcols = ["stat", "opp"] + [f"c{L}" for L in lines]
    h = frames.asof_rollup(h, "player_id", vcols, windows=W, lag_days=lag_days)
    key = h.set_index(["player_id", "game_pk"])
    idx = pd.MultiIndex.from_arrays([d["playerId"], d["game_pk"]])
    pid = d["playerId"].to_numpy()
    gpk = d["game_pk"].to_numpy()
    linev = d["line"].to_numpy(float)

    for w in W:
        d[f"statS{w}"] = key[f"stat_s{w}"].reindex(idx).to_numpy(float)
        d[f"statN{w}"] = key[f"stat_n{w}"].reindex(idx).to_numpy(float)
        d[f"oppS{w}"] = key[f"opp_s{w}"].reindex(idx).to_numpy(float)
        d[f"oppN{w}"] = key[f"opp_n{w}"].reindex(idx).to_numpy(float)
        # the clear rate at THIS line, taken from the matching indicator column
        s = np.full(len(d), np.nan)
        n = np.full(len(d), np.nan)
        for L in lines:
            m = linev == L
            if not m.any():
                continue
            sub = pd.MultiIndex.from_arrays([pid[m], gpk[m]])
            s[m] = key[f"c{L}_s{w}"].reindex(sub).to_numpy(float)
            n[m] = key[f"c{L}_n{w}"].reindex(sub).to_numpy(float)
        d[f"clrS{w}"], d[f"clrN{w}"] = s, n

    pf = d["pFairOver"].to_numpy(float)
    for w in W:
        nn = np.nan_to_num(d[f"clrN{w}"].to_numpy(float))
        ss = np.nan_to_num(d[f"clrS{w}"].to_numpy(float))
        # shrink the empirical clear rate toward the market's own price, by sample
        d[f"clr{w}"] = (ss + pf * PRIOR_N) / (nn + PRIOR_N)
        d[f"clrEdge{w}"] = d[f"clr{w}"] - pf
    d["empP"] = d["clr25"]

    stat100 = np.nan_to_num(d["statS100"].to_numpy(float))
    opp100 = np.nan_to_num(d["oppS100"].to_numpy(float))
    lgrate = float(stat100.sum() / max(opp100.sum(), 1e-9))
    rate = (stat100 + lgrate * PRIOR_N) / (opp100 + PRIOR_N)

    oppn = np.nan_to_num(d["oppN25"].to_numpy(float))
    opps = np.nan_to_num(d["oppS25"].to_numpy(float))
    oppg = np.where(oppn > 0, opps / np.maximum(oppn, 1.0), np.nan)
    lgoppg = float(np.nanmedian(oppg)) if np.isfinite(np.nanmedian(oppg)) else 4.0
    oppg = np.where(np.isfinite(oppg), oppg, lgoppg)

    d["rate"], d["oppPerGame"] = rate, oppg
    if market == "pitcher_outs":
        mean25 = np.where(np.nan_to_num(d["statN25"].to_numpy(float)) > 0,
                          np.nan_to_num(d["statS25"].to_numpy(float))
                          / np.maximum(np.nan_to_num(d["statN25"].to_numpy(float)), 1.0),
                          15.0)
        d["lam"] = mean25
        d["parP"] = _normal_over(mean25, 4.5, linev)
    else:
        d["lam"] = rate * oppg
        d["parP"] = _poisson_over(d["lam"], linev)

    th = _team_history(market, box)
    th = frames.asof_rollup(th, "team_id", ["allow", "allow_opp"], windows=(25,),
                            lag_days=lag_days)
    tk = th.set_index(["game_pk", "team_id"])
    pt = box.drop_duplicates(["player_id", "game_pk"]).set_index(["player_id", "game_pk"])["team_id"]
    d["teamId"] = pt.reindex(idx).to_numpy()
    pair = box.groupby("game_pk")["team_id"].unique()
    opp_id = np.full(len(d), np.nan)
    for i, (gp, t) in enumerate(zip(gpk, d["teamId"].to_numpy())):
        v = pair.get(gp)
        if v is not None and len(v) == 2 and not pd.isna(t):
            opp_id[i] = v[0] if v[1] == t else v[1]
    d["oppId"] = opp_id
    oidx = pd.MultiIndex.from_arrays([d["game_pk"], d["oppId"]])
    aS = tk["allow_s25"].reindex(oidx).to_numpy(float)
    aO = tk["allow_opp_s25"].reindex(oidx).to_numpy(float)
    d["oppAllowRate"] = np.where(np.nan_to_num(aO) > 0, aS / np.maximum(aO, 1e-9), lgrate)
    d["oppAllowRel"] = np.clip(d["oppAllowRate"] / max(lgrate, 1e-9), 0.6, 1.6)
    d["lamAdj"] = d["lam"] * d["oppAllowRel"]
    d["parPAdj"] = (_normal_over(d["lamAdj"], 4.5, linev) if market == "pitcher_outs"
                    else _poisson_over(d["lamAdj"], linev))

    st = starters(box).set_index(["game_pk", "team_id"])
    sidx = pd.MultiIndex.from_arrays([d["game_pk"], d["oppId"]])
    for c in ("spRunPerOut", "spKPerBf", "spOutsPerGame"):
        d[f"opp{c[2:]}"] = st[c].reindex(sidx).to_numpy(float)
    to = team_offense(box)
    own = pd.MultiIndex.from_arrays([d["game_pk"], d["teamId"]])
    d["teamObp25"] = to["teamObp25"].reindex(own).to_numpy(float)
    d["teamRpg25"] = to["teamRpg25"].reindex(own).to_numpy(float)
    d["oppRapg25"] = to["teamRapg25"].reindex(sidx).to_numpy(float)

    ls = lineup_slot(box)
    d["slot25"] = ls["slot25"].reindex(idx).to_numpy(float)
    d["startShare25"] = ls["startShare25"].reindex(idx).to_numpy(float)
    d["restDays"] = rest_days(box).reindex(idx).to_numpy(float)
    # how far the posted number sits from the projection, in its own sd
    lam = d["lam"].to_numpy(float)
    sd = np.sqrt(np.maximum(lam, 1e-6)) if market != "pitcher_outs" else np.full(len(d), 4.5)
    d["lineZ"] = (linev + 0.5 - lam) / np.maximum(sd, 1e-6)

    gp = game_prices()
    for c in gp.columns:
        d[c] = gp[c].reindex(d["game_pk"]).to_numpy(float)

    d["nHist"] = np.nan_to_num(d["statN25"].to_numpy(float))
    tmap = frames.team_name_map(box, d.drop_duplicates("game_pk")[["game_pk", "home_team", "away_team"]])
    d["isHome"] = (d["teamId"] == d["home_team"].map(tmap)).astype(float)

    cols = ["pLogit", "empP", "parP", "parPAdj", "clr25", "clr100",
            "clrEdge25", "clrEdge100", "rate", "oppPerGame", "oppAllowRel",
            "overround", "line", "nHist", "isHome", "lineZ",
            "oppRunPerOut", "oppKPerBf", "oppOutsPerGame",
            "teamObp25", "teamRpg25", "oppRapg25",
            "mktTotalLine", "mktHomeWinP", "mktHomeTeamTotal", "mktAwayTeamTotal",
            "slot25", "startShare25", "restDays", "dispOver", "dispUnder", "nBooks"]
    return d, cols


def build(market, cand, box, lag_days=0):
    """Attach every feature to the candidate frame. Returns (frame, columns)."""
    _, _, kind = frames.MARKETS[market]
    d = cand.copy()
    d["pLogit"] = _logit(d["pFairOver"])
    # how much better the best number on the street is than the median book.
    # The board bets the best number (best_price.ts selectBestSameLineBook), so
    # the spread between the two is part of what it is actually harvesting.
    d["dispOver"] = d["imp_over_med"] - d["imp_over_best"]
    d["dispUnder"] = d["imp_under_med"] - d["imp_under_best"]
    d["nBooks"] = d["n_books"]
    d, cols = (_build_game(market, d, box, lag_days) if kind == "game"
               else _build_prop(market, d, box, lag_days))
    for c in cols:
        d[c] = pd.to_numeric(d[c], errors="coerce").replace([np.inf, -np.inf], np.nan)
    return d, cols


def graded(d):
    return d[d["overHit"].notna()].copy()
