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


def _nb_over(mu, line, disp=1.25):
    """P(count > line) for an OVERDISPERSED count.

    A pitcher's strikeout total is not Poisson: his own workload varies start to
    start, so the variance of the count runs well above its mean and a Poisson
    tail is too thin at both ends. The negative binomial with variance
    `disp * mu` is the standard fix, and it is what the roadmap asks for on the
    strikeout markets.
    """
    mu = np.clip(np.asarray(mu, float), 1e-6, None)
    k = np.floor(np.asarray(line, float))
    if disp <= 1.0001:
        return 1.0 - stats.poisson.cdf(k, mu)
    r = mu / (disp - 1.0)
    pr = r / (r + mu)
    return 1.0 - stats.nbinom.cdf(k, r, pr)


_GAME_HOME = {}


def game_home(box):
    """game_pk -> (home_id, away_id).

    Which team is at home is a schedule fact, published weeks ahead, so using it
    breaks no point-in-time rule. The box-score table carries team ids but not
    which of them is the home side, so home identity is recovered from the team
    NAMES in the odds dumps and mapped back to ids exactly as
    `frames.team_name_map` does everywhere else. Only the small game-market and
    pitcher files are read: between them they name every game that is priced at
    all.
    """
    if "frame" in _GAME_HOME:
        return _GAME_HOME["frame"]
    parts = []
    for m in ("h2h", "spreads", "totals", "pitcher_outs", "pitcher_strikeouts"):
        try:
            c = frames.read_market(m)
        except FileNotFoundError:
            continue
        parts.append(c.drop_duplicates("game_pk")[["game_pk", "home_team", "away_team"]])
    if not parts:
        _GAME_HOME["frame"] = pd.DataFrame(columns=["game_pk", "home_id", "away_id"])
        return _GAME_HOME["frame"]
    ev = pd.concat(parts, ignore_index=True).drop_duplicates("game_pk")
    tmap = frames.team_name_map(box, ev)
    out = pd.DataFrame({"game_pk": ev["game_pk"].to_numpy(),
                        "home_id": ev["home_team"].map(tmap).to_numpy(),
                        "away_id": ev["away_team"].map(tmap).to_numpy()})
    out = out[out["home_id"].notna() & out["away_id"].notna()].reset_index(drop=True)
    _GAME_HOME["frame"] = out
    return out


_PARK = {}


def park_env(box, lag_days=0):
    """The ballpark's own as-of run and home-run environment.

    The roadmap names the park in seven of the eleven markets, and it is the one
    item on that list needing no new data source: a park factor is just how much
    has already been scored there, and every game that produced it finished
    before the one being bet. Shrunk hard toward the league rate, because a park
    with thirty games behind it has not said much yet.
    """
    key = f"lag{lag_days}"
    if key in _PARK:
        return _PARK[key]
    gh = game_home(box)
    ts = frames.team_scores(box)
    runs = ts.groupby("game_pk")["scored"].sum().rename("runs")
    hrs = box.groupby("game_pk")["home_runs"].sum().rename("hr")
    gd = box.drop_duplicates("game_pk").set_index("game_pk")["game_date"]
    g = gh.copy()
    g["runs"] = g["game_pk"].map(runs).to_numpy(float)
    g["hr"] = g["game_pk"].map(hrs).to_numpy(float)
    g["game_date"] = g["game_pk"].map(gd)
    g = g[g["game_date"].notna() & g["runs"].notna()].copy()
    if not len(g):
        _PARK[key] = pd.DataFrame(columns=["parkRunRel", "parkHrRel"])
        return _PARK[key]
    g["day"] = frames.to_day(g["game_date"])
    r = frames.asof_rollup(g, "home_id", ["runs", "hr"], windows=(100,),
                           lag_days=lag_days, prefix="pk_")
    lg_runs = float(np.nanmean(g["runs"].to_numpy(float))) or 2 * LEAGUE_RPG
    lg_hr = float(np.nanmean(g["hr"].to_numpy(float))) or 2.0
    k = 30.0
    out = pd.DataFrame(index=pd.Index(r["game_pk"].to_numpy(), name="game_pk"))
    for stem, lg, name in (("runs", lg_runs, "parkRunRel"), ("hr", lg_hr, "parkHrRel")):
        s = r[f"pk_{stem}_s100"].to_numpy(float)
        n = np.minimum(r[f"pk_{stem}_n100"].to_numpy(float), 100.0)
        out[name] = ((s + lg * k) / (n + k)) / max(lg, 1e-9)
    out = out[~out.index.duplicated()]
    _PARK[key] = out
    return out


_BULLPEN = {}


def bullpen(box, lag_days=0):
    """Per (game_pk, team_id): the relief corps' as-of rates.

    `cache_mlb_historical_bullpen` is the table `harness_readonly` is denied,
    and it was recorded as the blocker on `pitcher_outs`. It is not the only
    place the information lives: every relief appearance is a row of the box
    score, so the pen's runs per out, strikeouts and walks per batter faced and
    innings per game rebuild from the table we can read. Whoever starts, roughly
    two innings in five belong to these arms, and on the game markets they were
    the half of the pitching staff nobody was modelling.
    """
    key = f"lag{lag_days}"
    if key in _BULLPEN:
        return _BULLPEN[key]
    p = box[box["innings_pitched"].notna() & (box["is_starter"] != True)]     # noqa: E712
    per = p.groupby(["game_pk", "game_date", "team_id"], as_index=False).agg(
        bpOuts=("outs_derived", "sum"), bpRuns=("pitcher_runs", "sum"),
        bpK=("strikeouts", "sum"), bpBf=("batters_faced", "sum"),
        bpBb=("walks", "sum"))
    per["day"] = frames.to_day(per["game_date"])
    r = frames.asof_rollup(per, "team_id", ["bpOuts", "bpRuns", "bpK", "bpBf", "bpBb"],
                           windows=(25,), lag_days=lag_days)
    outs = r["bpOuts_s25"].to_numpy(float)
    bf = r["bpBf_s25"].to_numpy(float)
    n = r["bpOuts_n25"].to_numpy(float)
    out = pd.DataFrame({
        "game_pk": r["game_pk"].to_numpy(), "team_id": r["team_id"].to_numpy(),
        "bpRunPerOut": np.where(outs > 0, r["bpRuns_s25"] / np.maximum(outs, 1.0), np.nan),
        "bpKPerBf": np.where(bf > 0, r["bpK_s25"] / np.maximum(bf, 1.0), np.nan),
        "bpBbPerBf": np.where(bf > 0, r["bpBb_s25"] / np.maximum(bf, 1.0), np.nan),
        "bpOutsPerGame": np.where(n > 0, outs / np.maximum(n, 1.0), np.nan),
    }).set_index(["game_pk", "team_id"])
    out = out[~out.index.duplicated()]
    _BULLPEN[key] = out
    return out


_PFORM = {}


def pitcher_form(box, lag_days=0):
    """Per (player_id, game_pk): the starter's own as-of workload and efficiency.

    `pitcher_outs` is a workload market before it is a skill market, and the
    workload column -- `pitches_thrown` -- sat in the box-score dump the whole
    time, unread. What decides how long a starter lasts is his pitch budget and
    how many pitches he spends per out, so both are built here, with the walk
    rate that drives the second of them, a five-start form window against the
    twenty-five-start baseline, and the start-to-start spread of his own outs,
    which replaces the flat 4.5-out standard deviation the normal approximation
    used to assume for every pitcher alike.
    """
    key = f"lag{lag_days}"
    if key in _PFORM:
        return _PFORM[key]
    p = box[box["innings_pitched"].notna() & (box["is_starter"] == True)].copy()   # noqa: E712
    p["day"] = frames.to_day(p["game_date"])
    p["outs2"] = p["outs_derived"] ** 2
    vals = ["pitches_thrown", "outs_derived", "outs2", "batters_faced",
            "strikeouts", "walks", "pitcher_runs"]
    r = frames.asof_rollup(p, "player_id", vals, windows=(5, 25, 100),
                           lag_days=lag_days, prefix="pf_")

    def mean(stem, w):
        s = r[f"pf_{stem}_s{w}"].to_numpy(float)
        n = r[f"pf_{stem}_n{w}"].to_numpy(float)
        return np.where(n > 0, s / np.maximum(n, 1.0), np.nan), n

    pit5, _ = mean("pitches_thrown", 5)
    pit25, n25 = mean("pitches_thrown", 25)
    o5, _ = mean("outs_derived", 5)
    o25, _ = mean("outs_derived", 25)
    o2_25, _ = mean("outs2", 25)
    bf25, _ = mean("batters_faced", 25)
    k5s = r["pf_strikeouts_s5"].to_numpy(float)
    k25s = r["pf_strikeouts_s25"].to_numpy(float)
    bf5s = r["pf_batters_faced_s5"].to_numpy(float)
    bf25s = r["pf_batters_faced_s25"].to_numpy(float)
    bb25s = r["pf_walks_s25"].to_numpy(float)
    var = np.maximum(o2_25 - o25 ** 2, 1.0)
    out = pd.DataFrame({
        "player_id": r["player_id"].to_numpy(), "game_pk": r["game_pk"].to_numpy(),
        "spPitch5": pit5, "spPitch25": pit25,
        "spOuts5": o5, "spOuts25": o25,
        "spOutsSd25": np.where(np.isfinite(var), np.sqrt(var), np.nan),
        "spPitchPerOut": np.where(o25 > 0, pit25 / np.maximum(o25, 1.0), np.nan),
        "spBfPerStart": bf25,
        "spKPerBf5": np.where(bf5s > 0, k5s / np.maximum(bf5s, 1.0), np.nan),
        "spKPerBf25": np.where(bf25s > 0, k25s / np.maximum(bf25s, 1.0), np.nan),
        "spBbPerBf25": np.where(bf25s > 0, bb25s / np.maximum(bf25s, 1.0), np.nan),
        "spStarts25": n25,
        "spSeasonOuts": r["pf_outs_derived_s100"].to_numpy(float),
    }).set_index(["player_id", "game_pk"])
    out["spKForm"] = out["spKPerBf5"] - out["spKPerBf25"]
    out["spOutsForm"] = out["spOuts5"] - out["spOuts25"]
    out = out[~out.index.duplicated()]
    _PFORM[key] = out
    return out


# ---------------------------------------------------------------------------
# the run-difference distribution, done exactly
# ---------------------------------------------------------------------------
def _skellam_gt(lh, la, x):
    """P(home runs - away runs > x). Exact for a half-integer x."""
    lh = np.clip(np.asarray(lh, float), 1e-3, None)
    la = np.clip(np.asarray(la, float), 1e-3, None)
    return 1.0 - stats.skellam.cdf(np.floor(np.asarray(x, float)), lh, la)


def _skellam_home_win(lh, la):
    """P(home wins). Baseball has no ties, so the zero-margin mass the Skellam
    puts there is not a real outcome and the probability is renormalised over
    the decided games rather than left to leak into the favourite."""
    lh = np.clip(np.asarray(lh, float), 1e-3, None)
    la = np.clip(np.asarray(la, float), 1e-3, None)
    p_gt = 1.0 - stats.skellam.cdf(0, lh, la)
    p_eq = stats.skellam.pmf(0, lh, la)
    return np.clip(p_gt / np.maximum(1.0 - p_eq, 1e-9), 1e-6, 1 - 1e-6)


def _skellam_cover(lh, la, line):
    """P(the home side covers its own number). line is the HOME handicap, so
    the home side covers when margin + line > 0."""
    return _skellam_gt(lh, la, -np.asarray(line, float))


def _solve_home_lambda(total, target_p, line=None):
    """Split a market total into the two team lambdas that reproduce a posted
    price.

    Given the total the book is posting and one of its other two numbers, there
    is exactly one pair of Poisson means that agrees with both: the total fixes
    their sum and the moneyline (or the runline) fixes their difference. The
    probability is monotone in the home lambda, so a bisection finds it.

    This is what makes the three game markets one market rather than three. A
    runline price is a function of the moneyline and the total; a moneyline is a
    function of the runline and the total. Where the book's own three numbers
    disagree, the disagreement is visible at bet time and needs no model at all.
    """
    T = np.clip(np.asarray(total, float), 4.0, 18.0)
    tgt = np.clip(np.asarray(target_p, float), 0.02, 0.98)
    lo = np.full(T.shape, 0.4)
    hi = T - 0.4
    for _ in range(36):
        mid = 0.5 * (lo + hi)
        p = (_skellam_home_win(mid, T - mid) if line is None
             else _skellam_cover(mid, T - mid, line))
        below = p < tgt
        lo = np.where(below, mid, lo)
        hi = np.where(below, hi, mid)
    return 0.5 * (lo + hi)


def _solve_implied_total(p_ml, p_cover, line):
    """The total the book's OTHER two numbers imply.

    The moneyline fixes the difference of the two Poisson means and the runline
    price fixes how much spread there is around it, so between them they pin
    the sum as well. Bisecting on the total, with the home lambda re-solved from
    the moneyline at each step, finds the total those two prices are really
    quoting -- which can be some way from the one posted on the board.
    """
    pml = np.clip(np.asarray(p_ml, float), 0.03, 0.97)
    pcov = np.clip(np.asarray(p_cover, float), 0.03, 0.97)
    L = np.asarray(line, float)
    lo = np.full(pml.shape, 5.0)
    hi = np.full(pml.shape, 14.0)
    for _ in range(22):
        mid = 0.5 * (lo + hi)
        lam_h = _solve_home_lambda(mid, pml, None)
        p = _skellam_cover(lam_h, mid - lam_h, L)
        below = p < pcov
        lo = np.where(below, mid, lo)
        hi = np.where(below, hi, mid)
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------------------
# Elo
# ---------------------------------------------------------------------------
ELO_K = 4.0
ELO_HFA = 24.0          # home-field, in Elo points
ELO_REVERT = 0.30       # pulled back toward the mean at a season boundary
_ELO = {}


def elo(box, lag_days=0):
    """Each team's Elo rating as it stood BEFORE the game, per (game_pk, team_id).

    The roadmap asks for an Elo-style model on `h2h`, and Elo is the one team
    rating that is causal by construction: it is a running total that only ever
    moves forward, so the rating attached to a game is built from games that had
    already finished. Margin of victory damps the update the standard way, so a
    12-2 blowout is not worth three times a 3-2 win, and ratings revert toward
    1500 at the turn of a season.

    lag_days > 0 stops the rating at that many days before the game, which is
    what the placebo run needs.
    """
    key = f"lag{lag_days}"
    if key in _ELO:
        return _ELO[key]
    gh = game_home(box)
    ts = frames.team_scores(box).set_index(["game_pk", "team_id"])["scored"]
    gd = box.drop_duplicates("game_pk").set_index("game_pk")["game_date"]
    g = gh.copy()
    g["game_date"] = g["game_pk"].map(gd)
    g = g[g["game_date"].notna()].copy()
    idx_h = pd.MultiIndex.from_arrays([g["game_pk"], g["home_id"]])
    idx_a = pd.MultiIndex.from_arrays([g["game_pk"], g["away_id"]])
    g["hr_"] = ts.reindex(idx_h).to_numpy(float)
    g["ar_"] = ts.reindex(idx_a).to_numpy(float)
    g = g[g["hr_"].notna() & g["ar_"].notna()].copy()
    g["day"] = frames.to_day(g["game_date"])
    g["season"] = g["game_date"].str[:4]
    g = g.sort_values(["day", "game_pk"], kind="stable").reset_index(drop=True)

    rating = {}
    last_season = None
    rows = []
    pend = []          # (apply_day, home, away, dh, da) updates held back by the lag
    for r in g.itertuples(index=False):
        if last_season is not None and r.season != last_season:
            for t in rating:
                rating[t] = 1500.0 + (1.0 - ELO_REVERT) * (rating[t] - 1500.0)
        last_season = r.season
        # apply every update whose game is now old enough to be visible
        if lag_days:
            keep = []
            for apply_day, h, a, dh, da in pend:
                if apply_day <= r.day:
                    rating[h] = rating.get(h, 1500.0) + dh
                    rating[a] = rating.get(a, 1500.0) + da
                else:
                    keep.append((apply_day, h, a, dh, da))
            pend = keep
        rh = rating.get(r.home_id, 1500.0)
        ra = rating.get(r.away_id, 1500.0)
        diff = rh + ELO_HFA - ra
        exp_h = 1.0 / (1.0 + 10.0 ** (-diff / 400.0))
        rows.append((r.game_pk, r.home_id, rh, diff, exp_h))
        rows.append((r.game_pk, r.away_id, ra, -diff, 1.0 - exp_h))
        margin = r.hr_ - r.ar_
        won = 1.0 if margin > 0 else 0.0
        mov = np.log(abs(margin) + 1.0) * (2.2 / (0.001 * (diff if won else -diff) + 2.2))
        delta = ELO_K * mov * (won - exp_h)
        if lag_days:
            pend.append((r.day + lag_days, r.home_id, r.away_id, delta, -delta))
        else:
            rating[r.home_id] = rh + delta
            rating[r.away_id] = ra - delta
    out = pd.DataFrame(rows, columns=["game_pk", "team_id", "elo", "eloDiff", "eloP"])
    out = out.set_index(["game_pk", "team_id"])
    out = out[~out.index.duplicated()]
    _ELO[key] = out
    return out


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
        teamRapg25=np.where(n > 0, r["to_allowed_s25"] / np.maximum(n, 1.0), np.nan),
        teamPaPg25=np.where(n > 0, pa / np.maximum(n, 1.0), np.nan))
    return r.set_index(["game_pk", "team_id"])[["teamObp25", "teamRpg25", "teamRapg25",
                                                "teamPaPg25"]]


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
    bp = bullpen(box, lag_days)
    for tag, tid in (("h", "home_id"), ("a", "away_id")):
        idx = pd.MultiIndex.from_arrays([d["game_pk"], d[tid]])
        for c in ("spRunPerOut", "spKPerBf", "spOutsPerGame"):
            d[f"{tag}{c}"] = st[c].reindex(idx).to_numpy(float)
        for c in ("bpRunPerOut", "bpKPerBf", "bpOutsPerGame"):
            d[f"{tag}{c}"] = bp[c].reindex(idx).to_numpy(float)
    d["spRunGap"] = d["aspRunPerOut"] - d["hspRunPerOut"]   # + favours the home side
    d["bpRunGap"] = d["abpRunPerOut"] - d["hbpRunPerOut"]

    pe = park_env(box, lag_days)
    for c in ("parkRunRel", "parkHrRel"):
        d[c] = (pe[c].reindex(d["game_pk"]).to_numpy(float) if len(pe)
                else np.full(len(d), np.nan))
    park = np.where(np.isfinite(d["parkRunRel"].to_numpy(float)),
                    d["parkRunRel"].to_numpy(float), 1.0)

    # The staff model the roadmap asks for, and the one thing the form-only
    # expectation above cannot see: a game is pitched by a starter for as long
    # as he lasts and by a bullpen for the rest of it, in a park with a run
    # environment of its own. Added alongside the form model rather than in
    # place of it -- the calibrator is left to decide which it believes.
    lg_rate = LEAGUE_RPG / 27.0
    for tag in ("h", "a"):
        outs = np.clip(np.nan_to_num(d[f"{tag}spOutsPerGame"].to_numpy(float), nan=16.0),
                       6.0, 24.0)
        spr = np.nan_to_num(d[f"{tag}spRunPerOut"].to_numpy(float), nan=lg_rate)
        bpr = np.nan_to_num(d[f"{tag}bpRunPerOut"].to_numpy(float), nan=lg_rate)
        d[f"{tag}Allow"] = spr * outs + bpr * np.maximum(27.0 - outs, 0.0)
    d["expHomeSP"] = d["hsco25"] * d["aAllow"] / LEAGUE_RPG * park
    d["expAwaySP"] = d["asco25"] * d["hAllow"] / LEAGUE_RPG * park
    d["expTotalSP"] = d["expHomeSP"] + d["expAwaySP"]
    d["expMarginSP"] = d["expHomeSP"] - d["expAwaySP"] + 0.20
    if market == "totals":
        d["parPSP"] = _poisson_over(d["expTotalSP"], d["line"])
    elif market == "h2h":
        d["parPSP"] = 1.0 / (1.0 + np.exp(-d["expMarginSP"] / 1.55))
    else:
        d["parPSP"] = _normal_over(d["expMarginSP"], RUNDIFF_SD,
                                   -d["line"].to_numpy(float))

    gp = game_prices()
    for c in gp.columns:
        d[c] = gp[c].reindex(d["game_pk"]).to_numpy(float)
    d["mktMargin"] = d["mktHomeTeamTotal"] - d["mktAwayTeamTotal"]

    # Elo, and the Pythagorean record the roadmap asks for on h2h
    el = elo(box, lag_days)
    for tag, tid in (("h", "home_id"), ("a", "away_id")):
        idx = pd.MultiIndex.from_arrays([d["game_pk"], d[tid]])
        d[f"{tag}Elo"] = el["elo"].reindex(idx).to_numpy(float)
    d["eloDiff"] = d["hElo"].fillna(1500.0) - d["aElo"].fillna(1500.0) + ELO_HFA
    d["eloP"] = 1.0 / (1.0 + 10.0 ** (-d["eloDiff"] / 400.0))
    for tag in ("h", "a"):
        rs = np.clip(d[f"{tag}sco25"].to_numpy(float), 0.5, None)
        ra = np.clip(d[f"{tag}all25"].to_numpy(float), 0.5, None)
        d[f"{tag}Pythag"] = rs ** 1.83 / (rs ** 1.83 + ra ** 1.83)
    d["pythagGap"] = d["hPythag"] - d["aPythag"]

    # the run-difference distribution, exactly rather than as a normal
    lam_h = np.clip(d["expHomeSP"].to_numpy(float), 1.0, 12.0)
    lam_a = np.clip(d["expAwaySP"].to_numpy(float), 1.0, 12.0)
    lam_h = np.where(np.isfinite(lam_h), lam_h, LEAGUE_RPG)
    lam_a = np.where(np.isfinite(lam_a), lam_a, LEAGUE_RPG)
    d["lamHome"], d["lamAway"] = lam_h, lam_a
    if market == "totals":
        d["parPSkel"] = _poisson_over(lam_h + lam_a, d["line"])
    elif market == "h2h":
        d["parPSkel"] = _skellam_home_win(lam_h, lam_a)
    else:
        d["parPSkel"] = _skellam_cover(lam_h, lam_a, d["line"].to_numpy(float))

    # the book's own three numbers, made to agree with each other
    T = d["mktTotalLine"].to_numpy(float)
    T = np.where(np.isfinite(T), T, 2 * LEAGUE_RPG)
    pml = d["mktHomeWinP"].to_numpy(float)
    pcov = d["mktHomeCoverP"].to_numpy(float)
    sl = d["mktSpreadLine"].to_numpy(float)
    sl = np.where(np.isfinite(sl), sl, -1.5)
    ok_ml = np.isfinite(pml)
    ok_rl = np.isfinite(pcov)
    pml_f = np.where(ok_ml, pml, 0.5)
    pcov_f = np.where(ok_rl, pcov, 0.5)
    ml_lam = _solve_home_lambda(T, pml_f, None)             # from moneyline + total
    rl_lam = _solve_home_lambda(T, pcov_f, sl)              # from runline  + total
    d["mktLamHome"] = np.where(ok_ml, ml_lam, np.nan)
    d["mktLamAway"] = np.where(ok_ml, T - ml_lam, np.nan)
    d["mktLamGap"] = np.where(ok_ml & ok_rl, ml_lam - rl_lam, np.nan)
    # NOTE: inverting the runline price for the total as well (_solve_implied_total)
    # was tried and dropped: the bisection rails against its own bounds on most
    # games, because P(cover) is too flat in the total to invert. The two
    # single-solve lambdas below are well behaved and are what is used.

    # what the OTHER two numbers say this market's own price should be, and how
    # far the posted price is from it
    if market == "spreads":
        impl = _skellam_cover(ml_lam, T - ml_lam, d["line"].to_numpy(float))
        d["crossP"] = np.where(ok_ml, impl, np.nan)
    elif market == "h2h":
        impl = _skellam_home_win(rl_lam, T - rl_lam)
        d["crossP"] = np.where(ok_rl, impl, np.nan)
    else:
        # for the total there is no third number to cross against, so this is
        # the Poisson probability at the book's OWN posted total: the residual
        # then says how far its over price sits from a plain Poisson at the
        # number it is itself quoting.
        d["crossP"] = _poisson_over(T, d["line"].to_numpy(float))
    d["crossResid"] = d["pFairOver"].to_numpy(float) - d["crossP"].to_numpy(float)

    d["nHist"] = d[["hn", "an"]].min(axis=1)
    cols = ["pLogit", "parP", "empP", "parPSP", "expTotal", "expMargin",
            "expTotalSP", "expMarginSP",
            "mktTotalLine", "mktTotalOverP", "mktHomeWinP", "mktHomeCoverP",
            "mktSpreadLine", "mktHomeTeamTotal", "mktAwayTeamTotal", "mktMargin",
            "hsco25", "hall25", "asco25", "aall25", "overround", "line", "nHist",
            "hspRunPerOut", "aspRunPerOut", "hspOutsPerGame", "aspOutsPerGame",
            "hbpRunPerOut", "abpRunPerOut", "hbpKPerBf", "abpKPerBf",
            "hbpOutsPerGame", "abpOutsPerGame", "bpRunGap",
            "parkRunRel", "parkHrRel",
            "eloDiff", "eloP", "hPythag", "aPythag", "pythagGap",
            "parPSkel", "lamHome", "lamAway",
            "mktLamHome", "mktLamAway", "mktLamGap", "crossP", "crossResid",
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

    d["oppObp25"] = to["teamObp25"].reindex(sidx).to_numpy(float)

    # the park, the opposing bullpen, and -- for a pitcher -- his own pen's
    # recent workload, which is what decides how long a manager leaves him in
    pe = park_env(box, lag_days)
    for c in ("parkRunRel", "parkHrRel"):
        d[c] = (pe[c].reindex(d["game_pk"]).to_numpy(float) if len(pe)
                else np.full(len(d), np.nan))
    bp = bullpen(box, lag_days)
    d["oppBpKPerBf"] = bp["bpKPerBf"].reindex(sidx).to_numpy(float)
    d["oppBpRunPerOut"] = bp["bpRunPerOut"].reindex(sidx).to_numpy(float)
    d["teamBpOutsPerGame"] = bp["bpOutsPerGame"].reindex(own).to_numpy(float)

    role = frames.MARKETS[market][0]
    park = np.where(np.isfinite(d["parkHrRel"].to_numpy(float)) & (market == "batter_home_runs"),
                    d["parkHrRel"].to_numpy(float),
                    np.where(np.isfinite(d["parkRunRel"].to_numpy(float)),
                             d["parkRunRel"].to_numpy(float), 1.0))
    park = np.clip(park, 0.85, 1.20)
    # A hitters' park lifts a batter's count and shortens a pitcher's outing, so
    # the term enters the two roles with opposite signs. It is handed to the
    # calibrator as one column either way and the sign is fitted, not asserted.
    d["parkUsed"] = park
    d["lamPark"] = d["lamAdj"] * park
    d["parPPark"] = (_normal_over(d["lamPark"], 4.5, linev) if market == "pitcher_outs"
                     else _poisson_over(d["lamPark"], linev))
    # the same count, allowed to be overdispersed
    d["parPNb"] = (d["parPPark"] if market == "pitcher_outs"
                   else _nb_over(d["lamPark"], linev, 1.15))

    if role == "pitcher":
        pf = pitcher_form(box, lag_days)
        for c in ("spPitch5", "spPitch25", "spOuts5", "spOuts25", "spOutsSd25",
                  "spPitchPerOut", "spBfPerStart", "spKPerBf5", "spKPerBf25",
                  "spBbPerBf25", "spStarts25", "spSeasonOuts", "spKForm", "spOutsForm"):
            d[c] = pf[c].reindex(idx).to_numpy(float)
        # A start ends when the pitch budget runs out, and it runs out faster
        # against a lineup that gets on base. Roadmap's decomposition, in order:
        #   pitch budget / pitches per out -> outs
        #   outs / (1 - opponent OBP)      -> batters faced
        #   batters faced x K rate         -> strikeouts
        lg_obp = float(np.nanmedian(d["oppObp25"].to_numpy(float)))
        lg_obp = lg_obp if np.isfinite(lg_obp) and lg_obp > 0 else 0.315
        obp = np.nan_to_num(d["oppObp25"].to_numpy(float), nan=lg_obp)
        d["oppObpRel"] = np.clip(obp / lg_obp, 0.85, 1.18)
        p25 = np.nan_to_num(d["spPitch25"].to_numpy(float), nan=85.0)
        p5 = np.where(np.isfinite(d["spPitch5"].to_numpy(float)),
                      d["spPitch5"].to_numpy(float), p25)
        budget = np.clip(0.65 * p25 + 0.35 * p5, 45.0, 110.0)
        ppo = np.clip(np.nan_to_num(d["spPitchPerOut"].to_numpy(float), nan=5.4),
                      3.5, 8.0) * d["oppObpRel"].to_numpy(float)
        d["expOutsBudget"] = np.clip(budget / ppo, 3.0, 24.0)
        o25 = np.where(np.isfinite(d["spOuts25"].to_numpy(float)),
                       d["spOuts25"].to_numpy(float), d["expOutsBudget"].to_numpy(float))
        d["expOuts"] = 0.5 * d["expOutsBudget"] + 0.5 * o25
        d["expBf"] = d["expOuts"] / np.clip(1.0 - np.clip(obp, 0.20, 0.42), 0.55, 0.85)
        if market == "pitcher_outs":
            sd = np.clip(np.nan_to_num(d["spOutsSd25"].to_numpy(float), nan=4.5), 2.5, 9.0)
            d["parPW"] = _normal_over(d["expOuts"], sd, linev)
        else:
            krate = np.where(np.isfinite(d["spKPerBf25"].to_numpy(float)),
                             d["spKPerBf25"].to_numpy(float), rate)
            lam_k = krate * d["expBf"].to_numpy(float) * d["oppAllowRel"].to_numpy(float)
            d["lamW"] = lam_k
            d["parPW"] = _nb_over(lam_k, linev, 1.25)
    else:
        d["parPW"] = d["parPPark"]

    ls = lineup_slot(box)
    d["slot25"] = ls["slot25"].reindex(idx).to_numpy(float)
    d["startShare25"] = ls["startShare25"].reindex(idx).to_numpy(float)
    d["restDays"] = rest_days(box).reindex(idx).to_numpy(float)

    # Opportunity, modelled rather than read off the player's own recent games.
    # Every batter market in the roadmap decomposes the same way -- expected
    # plate appearances times a rate -- and a batter's own appearances per game
    # is a poor estimate of the first half of that: it is dragged down by games
    # he left early and by the weeks he was not starting. The lineup gives it
    # directly. A team bats about nine times through its order, each slot up the
    # card is worth roughly a tenth of a plate appearance, and a player who
    # starts four days in five gets four fifths of it.
    d["teamPaPg25"] = to["teamPaPg25"].reindex(own).to_numpy(float)
    tpa = np.nan_to_num(d["teamPaPg25"].to_numpy(float), nan=38.0)
    slot = np.clip(np.nan_to_num(d["slot25"].to_numpy(float), nan=5.0), 1.0, 9.0)
    share = np.clip(np.nan_to_num(d["startShare25"].to_numpy(float), nan=0.8), 0.0, 1.0)
    slot_pa = np.clip(tpa / 9.0 + (5.0 - slot) * 0.11, 2.0, 5.5) * np.clip(share, 0.3, 1.0)
    d["slotPa"] = slot_pa
    own_opp = np.nan_to_num(d["oppPerGame"].to_numpy(float), nan=np.nan)
    if frames.MARKETS[market][0] == "batter":
        # markets settled per at-bat need the AB share of a plate appearance,
        # which is the player's own and is stable
        if OPP[market] == "at_bats":
            ratio = np.where(np.isfinite(own_opp) & (tpa > 0),
                             own_opp / np.maximum(slot_pa, 1e-6), 0.88)
            ratio = np.clip(np.where(np.isfinite(ratio), ratio, 0.88), 0.6, 1.1)
            slot_opp = slot_pa * ratio
        else:
            slot_opp = slot_pa
        d["expOpp"] = np.where(np.isfinite(own_opp), 0.5 * own_opp + 0.5 * slot_opp,
                               slot_opp)
    else:
        d["expOpp"] = np.where(np.isfinite(own_opp), own_opp, 4.0)
    d["oppGap"] = d["expOpp"] - np.where(np.isfinite(own_opp), own_opp, d["expOpp"])
    lam_opp = d["rate"].to_numpy(float) * d["expOpp"].to_numpy(float) \
        * d["oppAllowRel"].to_numpy(float) * park
    d["lamOpp"] = lam_opp
    d["parPOpp"] = (_normal_over(lam_opp, 4.5, linev) if market == "pitcher_outs"
                    else _poisson_over(lam_opp, linev))
    # A rare event over a countable number of tries is binomial, not Poisson:
    # a batter cannot hit two home runs in one at-bat, and the Poisson tail
    # quietly says he can. It matters most exactly where the roadmap says it
    # does -- home runs at 0.5.
    if frames.MARKETS[market][0] == "batter":
        tries = np.clip(d["expOpp"].to_numpy(float), 0.5, 7.0)
        per_try = np.clip(d["rate"].to_numpy(float) * d["oppAllowRel"].to_numpy(float)
                          * park, 1e-6, 0.95)
        k = np.floor(linev)
        d["parPBin"] = 1.0 - stats.binom.cdf(k, np.round(tries), per_try)
    else:
        d["parPBin"] = d["parPOpp"]
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

    cols = ["pLogit", "empP", "parP", "parPAdj", "parPPark", "parPNb", "parPW",
            "parPOpp", "parPBin", "expOpp", "slotPa", "oppGap", "teamPaPg25",
            "clr25", "clr100",
            "clrEdge25", "clrEdge100", "rate", "oppPerGame", "oppAllowRel",
            "overround", "line", "nHist", "isHome", "lineZ",
            "oppRunPerOut", "oppKPerBf", "oppOutsPerGame",
            "teamObp25", "teamRpg25", "oppRapg25", "oppObp25",
            "parkRunRel", "parkHrRel", "oppBpKPerBf", "oppBpRunPerOut",
            "teamBpOutsPerGame",
            "mktTotalLine", "mktHomeWinP", "mktHomeTeamTotal", "mktAwayTeamTotal",
            "slot25", "startShare25", "restDays", "dispOver", "dispUnder", "nBooks"]
    if frames.MARKETS[market][0] == "pitcher":
        cols += ["spPitch5", "spPitch25", "spOuts5", "spOuts25", "spOutsSd25",
                 "spPitchPerOut", "spBfPerStart", "spKPerBf5", "spKPerBf25",
                 "spBbPerBf25", "spStarts25", "spSeasonOuts", "spKForm", "spOutsForm",
                 "oppObpRel", "expOuts", "expOutsBudget", "expBf"]
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
