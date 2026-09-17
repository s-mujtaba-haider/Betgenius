"""The filter that decides the board, and the walk-forward machinery under it.

Shape of the thing:

  1. Every candidate carries the market's own de-vigged probability and a set of
     point-in-time features (features.py).
  2. A calibrator is re-fit forward through time and never sees a game that had
     not already finished. It returns a probability for the OVER (or the home
     side on h2h/spreads).
  3. Both sides are then priced against that probability at the posted number.
     The board bets the side whose expected value clears zero -- which is the
     same condition as "the model's probability beats the price the book is
     actually offering", vig included.
  4. The shipped D-164 heavy-juice under veto still applies, unchanged.

Two members are averaged:

  price   the market price recalibrated against itself, nothing else. This is
          what picks up the tail bias every sportsbook carries.
  box     the same price plus the box-score and opportunity features.

They are averaged rather than selected because their disagreement is noise:
measured separately they pass different markets for no reason anyone can defend.

Time, not row index
-------------------
Training cuts are made on the clock. Picks that share a commence time straddle a
row boundary, and that leak alone has turned a FAIL into a PASS before now, so a
fold boundary is a timestamp and a game lands wholly on one side of it.
"""
import numpy as np
import pandas as pd
import statsmodels.api as sm
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

import mlbgate as G

MEMBERS = ("price", "box")
WARMUP = 0.25
N_BLOCKS = 40


# A compact vector for the thin markets. A board with five thousand rows in it
# cannot support twenty-five features, and handing it them is how a market that
# was merely losing becomes badly losing.
COMPACT = {
    "game": ["pLogit", "parPSkel", "crossResid", "eloDiff", "expMargin", "expTotalSP",
             "spRunGap", "bpRunGap", "parkRunRel", "dispOver", "dispUnder",
             "mktTotalLine", "mktHomeWinP", "mktMargin"],
    "prop": ["pLogit", "empP", "parPAdj", "parPOpp", "clrEdge25", "lineZ",
             "dispOver", "dispUnder", "teamObp25", "oppAllowRel", "expOpp",
             "mktTotalLine", "mktHomeTeamTotal"],
}


# R5-03 (round 4's unrun E27). features.py already fits a Poisson and a negative
# binomial count model per prop market and hands their implied P(X > line) to the
# calibrator as two columns among forty-six. These members offer that probability
# DIRECTLY, in the same one-column shape `price` uses, so it is not re-weighted by
# a logistic fitted on everything else. Prop markets only -- a game market has no
# column of this form, and a member is left all-NaN there rather than silently
# falling back to something else and being compared as if it were the same thing.
SINGLE = {"nb": "parPNb", "poi": "parPAdj"}


def _design(d, cols, member):
    if member == "price":
        use = ["pLogit"]
    elif member == "compact":
        kind = "game" if "expMargin" in cols else "prop"
        use = [c for c in COMPACT[kind] if c in cols]
    elif member in SINGLE:
        col = SINGLE[member]
        if col not in cols:
            return None, []
        # to the logit scale, as `price` is: a logistic on a raw probability is
        # linear in p, which is not the shape a probability carries information in
        p = np.clip(d[col].to_numpy(float), 1e-6, 1 - 1e-6)
        return np.log(p / (1 - p)).reshape(-1, 1), [col]
    else:
        use = cols
    return d[use].to_numpy(float), use


def _fit_predict_gbm(Xtr, ytr, Xte):
    """Gradient boosting on the same vector -- the non-linear member.

    Kept deliberately small: shallow trees, few leaves, strong L2. A prop board
    has one weak signal in it, and a boosted model given room will find the
    noise instead.
    """
    base = float(ytr.mean()) if len(ytr) else 0.5
    if len(np.unique(ytr)) < 2 or len(ytr) < 800:
        return np.full(len(Xte), base)
    # a column that is constant or all-missing inside this fold breaks the
    # binner; drop it rather than let one thin fold kill the whole member
    keep = [j for j in range(Xtr.shape[1])
            if np.isfinite(Xtr[:, j]).sum() > 20 and np.nanstd(Xtr[:, j]) > 1e-12]
    if not keep:
        return np.full(len(Xte), base)
    m = HistGradientBoostingClassifier(max_depth=3, max_leaf_nodes=8, l2_regularization=5.0,
                                       learning_rate=0.05, max_iter=200,
                                       min_samples_leaf=200, random_state=20260916)
    try:
        m.fit(Xtr[:, keep], ytr)
        return m.predict_proba(Xte[:, keep])[:, 1]
    except ValueError:
        return np.full(len(Xte), base)


def _fit_predict_iso(Xtr, ytr, Xte, ttr):
    """Roadmap Level 6: fit the model, then recalibrate its probabilities.

    A logistic is calibrated in-sample and drifts out of it, and the board's
    decision is a comparison between a probability and a price -- so a
    half-point of miscalibration is not a cosmetic problem, it decides bets. The
    training fold is itself split ON THE CLOCK: the model is fit on the earlier
    80%, an isotonic map is fit on the last 20% it has not seen, then the model
    is refit on the whole fold and that map applied. Nothing from the test block
    is used at either stage.
    """
    n = len(ytr)
    if len(np.unique(ytr)) < 2 or n < 1200:
        return _fit_predict(Xtr, ytr, Xte)
    order = np.argsort(ttr, kind="stable")
    cut = order[int(0.8 * n)]
    inner = ttr < ttr[cut]
    if inner.sum() < 400 or (~inner).sum() < 200 or len(np.unique(ytr[inner])) < 2:
        return _fit_predict(Xtr, ytr, Xte)
    held = _fit_predict(Xtr[inner], ytr[inner], Xtr[~inner])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.001, y_max=0.999)
    iso.fit(held, ytr[~inner])
    return iso.predict(_fit_predict(Xtr, ytr, Xte))


def _fit_predict_offset(Xtr, ytr, Xte, otr, ote):
    """The market price as a fixed OFFSET, with the features fitting only what
    is left over.

    A free logistic is allowed to re-weight the price itself, and on a thin
    market it will: it pays for a little in-sample fit by mangling the single
    best estimate in the vector. Pinning the price at coefficient 1 and letting
    the features move the number only as a correction is both the standard way
    to model a market and a much smaller thing to estimate.
    """
    if len(np.unique(ytr)) < 2 or Xtr.shape[1] == 0:
        return 1.0 / (1.0 + np.exp(-ote))
    med = np.nanmedian(Xtr, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    tr = np.where(np.isfinite(Xtr), Xtr, med)
    te = np.where(np.isfinite(Xte), Xte, med)
    mu, sd = tr.mean(axis=0), tr.std(axis=0)
    sd = np.where(sd > 1e-9, sd, 1.0)
    tr, te = (tr - mu) / sd, (te - mu) / sd
    keep = [j for j in range(tr.shape[1]) if tr[:, j].std() > 1e-9]
    if not keep:
        return 1.0 / (1.0 + np.exp(-ote))
    tr, te = sm.add_constant(tr[:, keep], has_constant="add"), sm.add_constant(te[:, keep], has_constant="add")
    try:
        fit = sm.GLM(ytr, tr, family=sm.families.Binomial(), offset=otr).fit_regularized(
            alpha=1.0 / max(len(ytr), 1), L1_wt=0.0)
        return np.asarray(fit.predict(te, offset=ote), dtype=float)
    except Exception:                                              # noqa: BLE001
        return 1.0 / (1.0 + np.exp(-ote))


def _prep(Xtr, Xte):
    """Median-impute on the TRAINING fold only, then standardise. Shared by the
    round-3+ model families so the only thing that differs between them is the
    estimator."""
    med = np.nanmedian(Xtr, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    tr = np.where(np.isfinite(Xtr), Xtr, med)
    te = np.where(np.isfinite(Xte), Xte, med)
    mu, sd = tr.mean(axis=0), tr.std(axis=0)
    sd = np.where(sd > 1e-9, sd, 1.0)
    return (tr - mu) / sd, (te - mu) / sd


def _fit_predict_forest(Xtr, ytr, Xte, kind="rf"):
    """Bagged trees as an alternative to boosting.

    Deliberately shallow and heavily leaf-constrained for the same reason the
    gbm member is: a prop board carries one weak signal and a deep forest given
    room memorises players rather than learning form. ExtraTrees splits at
    random thresholds, which is a stronger regulariser again.
    """
    from sklearn.ensemble import ExtraTreesClassifier, RandomForestClassifier
    base = float(ytr.mean()) if len(ytr) else 0.5
    if len(np.unique(ytr)) < 2 or len(ytr) < 800:
        return np.full(len(Xte), base)
    tr, te = _prep(Xtr, Xte)
    cls = RandomForestClassifier if kind == "rf" else ExtraTreesClassifier
    m = cls(n_estimators=200, max_depth=8, min_samples_leaf=200,
            max_features="sqrt", n_jobs=1, random_state=20260917)
    try:
        m.fit(tr, ytr)
        return m.predict_proba(te)[:, 1]
    except ValueError:
        return np.full(len(te), base)


def _fit_predict_gbm_tuned(Xtr, ytr, Xte, params):
    """The incumbent gbm with an explicit hyperparameter dict (E28)."""
    base = float(ytr.mean()) if len(ytr) else 0.5
    if len(np.unique(ytr)) < 2 or len(ytr) < 800:
        return np.full(len(Xte), base)
    keep = [j for j in range(Xtr.shape[1])
            if np.isfinite(Xtr[:, j]).sum() > 20 and np.nanstd(Xtr[:, j]) > 1e-12]
    if not keep:
        return np.full(len(Xte), base)
    m = HistGradientBoostingClassifier(random_state=20260916, **params)
    try:
        m.fit(Xtr[:, keep], ytr)
        return m.predict_proba(Xte[:, keep])[:, 1]
    except ValueError:
        return np.full(len(Xte), base)


def _fit_predict_xgb(Xtr, ytr, Xte):
    """R5-01. XGBoost, the one model family the branches had and this did not.

    Hyperparameters are FIXED in advance to the same conservative shape the
    incumbent gbm member uses -- shallow, heavily leaf-constrained, strong L2 --
    and nothing is searched. A search over the same split the member is then
    scored on is the multiple-comparisons exposure the branch's own guide flags
    on its best-of-5-thresholds result, and round 5 does not import it.

    Single-threaded and seeded so a re-run is bit-identical: Part 33 asks for
    run-to-run stability to be established rather than assumed.
    """
    import xgboost as xgb
    base = float(ytr.mean()) if len(ytr) else 0.5
    if len(np.unique(ytr)) < 2 or len(ytr) < 800:
        return np.full(len(Xte), base)
    keep = [j for j in range(Xtr.shape[1])
            if np.isfinite(Xtr[:, j]).sum() > 20 and np.nanstd(Xtr[:, j]) > 1e-12]
    if not keep:
        return np.full(len(Xte), base)
    m = xgb.XGBClassifier(
        max_depth=3, n_estimators=200, learning_rate=0.05, min_child_weight=200,
        reg_lambda=5.0, subsample=0.8, colsample_bytree=0.8,
        tree_method="hist", n_jobs=1, random_state=20260917,
        eval_metric="logloss", verbosity=0)
    try:
        m.fit(Xtr[:, keep], ytr)
        return m.predict_proba(Xte[:, keep])[:, 1]
    except (ValueError, xgb.core.XGBoostError):
        return np.full(len(Xte), base)


def _fit_predict_lgbm(Xtr, ytr, Xte):
    """R5-02. LightGBM, leaf-wise rather than depth-wise. Same discipline."""
    import lightgbm as lgb
    base = float(ytr.mean()) if len(ytr) else 0.5
    if len(np.unique(ytr)) < 2 or len(ytr) < 800:
        return np.full(len(Xte), base)
    keep = [j for j in range(Xtr.shape[1])
            if np.isfinite(Xtr[:, j]).sum() > 20 and np.nanstd(Xtr[:, j]) > 1e-12]
    if not keep:
        return np.full(len(Xte), base)
    m = lgb.LGBMClassifier(
        num_leaves=8, max_depth=3, n_estimators=200, learning_rate=0.05,
        min_child_samples=200, reg_lambda=5.0, subsample=0.8, subsample_freq=1,
        colsample_bytree=0.8, deterministic=True, force_row_wise=True,
        num_threads=1, random_state=20260917, verbose=-1)
    try:
        m.fit(Xtr[:, keep], ytr)
        return m.predict_proba(Xte[:, keep])[:, 1]
    except (ValueError, lgb.basic.LightGBMError):
        return np.full(len(Xte), base)


# R5-05 (round 4's unrun E29). Board ROI measured 1.98% / 3.15% / 0.62% across
# 2024 / 2025 / 2026, so the question of whether the later period is a regime
# change or noise is live. Arm B weights the training fold by recency; arm C
# discards everything older than a year. Both are decided on SELECT-B log loss.
RECENCY = {"gbmW": ("weight", 365.0), "gbmR": ("roll", 365.0)}


def _fit_predict_gbm_recency(Xtr, ytr, Xte, ttr, mode, days):
    """The incumbent gbm, trained with a recency weight or a rolling window.

    `ttr` is the training fold's commence times as int64 seconds. Nothing about
    the fold boundary changes -- this only changes how the rows INSIDE an
    already-out-of-sample training fold are weighted, so it cannot leak.
    """
    base = float(ytr.mean()) if len(ytr) else 0.5
    if len(np.unique(ytr)) < 2 or len(ytr) < 800:
        return np.full(len(Xte), base)
    age = (ttr.max() - ttr) / 86400.0
    if mode == "roll":
        m = age <= days
        if m.sum() < 800 or len(np.unique(ytr[m])) < 2:
            return _fit_predict_gbm(Xtr, ytr, Xte)
        return _fit_predict_gbm(Xtr[m], ytr[m], Xte)
    w = np.power(0.5, age / days)
    keep = [j for j in range(Xtr.shape[1])
            if np.isfinite(Xtr[:, j]).sum() > 20 and np.nanstd(Xtr[:, j]) > 1e-12]
    if not keep:
        return np.full(len(Xte), base)
    m = HistGradientBoostingClassifier(max_depth=3, max_leaf_nodes=8,
                                       l2_regularization=5.0, learning_rate=0.05,
                                       max_iter=200, min_samples_leaf=200,
                                       random_state=20260916)
    try:
        m.fit(Xtr[:, keep], ytr, sample_weight=w)
        return m.predict_proba(Xte[:, keep])[:, 1]
    except ValueError:
        return np.full(len(Xte), base)


# E28 grid. Named so a cache can be built per configuration and compared on log
# loss inside SELECT-A, never against the verdict window.
GBM_GRID = {
    "gbmA": dict(max_depth=3, max_leaf_nodes=8, l2_regularization=5.0,
                 learning_rate=0.05, max_iter=200, min_samples_leaf=200),   # incumbent
    "gbmB": dict(max_depth=4, max_leaf_nodes=15, l2_regularization=10.0,
                 learning_rate=0.03, max_iter=400, min_samples_leaf=300),
    "gbmC": dict(max_depth=2, max_leaf_nodes=4, l2_regularization=2.0,
                 learning_rate=0.08, max_iter=150, min_samples_leaf=100),
    "gbmD": dict(max_depth=6, max_leaf_nodes=31, l2_regularization=20.0,
                 learning_rate=0.02, max_iter=600, min_samples_leaf=500),
}


def _fit_predict(Xtr, ytr, Xte):
    med = np.nanmedian(Xtr, axis=0)
    med = np.where(np.isfinite(med), med, 0.0)
    tr = np.where(np.isfinite(Xtr), Xtr, med)
    te = np.where(np.isfinite(Xte), Xte, med)
    mu, sd = tr.mean(axis=0), tr.std(axis=0)
    sd = np.where(sd > 1e-9, sd, 1.0)
    tr, te = (tr - mu) / sd, (te - mu) / sd
    if len(np.unique(ytr)) < 2:
        return np.full(len(te), float(ytr.mean()))
    m = LogisticRegression(max_iter=3000, C=1.0)
    m.fit(tr, ytr)
    return m.predict_proba(te)[:, 1]


def walkforward(d, cols, members=MEMBERS, warmup=WARMUP, n_blocks=N_BLOCKS):
    """Calibrated P(over) per member, out of sample by construction.

    Returns (probs, frame) where probs maps member name -> array. Rows inside the
    warm-up window are never scored: they exist only to train the first fold.
    """
    d = d.sort_values("commenceTime", kind="stable").reset_index(drop=True)
    y = d["overHit"].astype(int).to_numpy()
    t = pd.to_datetime(d["commenceTime"], utc=True).to_numpy("datetime64[ns]")
    n = len(d)
    start = int(warmup * n)
    if start < 50 or n - start < 50:
        return {m: np.full(n, np.nan) for m in members}, d

    # fold boundaries are timestamps, so a game never straddles one
    edges = [t[start]]
    step = max(1, (n - start) // n_blocks)
    for i in range(start + step, n, step):
        if t[i] > edges[-1]:
            edges.append(t[i])
    edges.append(np.datetime64("2999-01-01T00:00:00"))

    _full = (("gbm", "offset", "iso", "rf", "et", "xgb", "lgbm")
             + tuple(GBM_GRID) + tuple(RECENCY))
    des = {m: _design(d, cols, "box" if m in _full else m)[0] for m in members}
    off = d["pLogit"].to_numpy(float)
    off = np.clip(np.where(np.isfinite(off), off, 0.0), -8, 8)
    resid_cols = [c for c in cols if c != "pLogit"]
    p = {m: np.full(n, np.nan) for m in members}
    for lo, hi in zip(edges[:-1], edges[1:]):
        te = (t >= lo) & (t < hi)
        tr = t < lo
        if te.sum() == 0 or tr.sum() < 200:
            continue
        for mem in members:
            # a SINGLE member whose column this market does not have. Left as
            # NaN, which every downstream consumer already treats as "this
            # member does not exist here" rather than silently substituting one
            if des[mem] is None:
                continue
            if mem == "offset":
                R = d[resid_cols].to_numpy(float)
                p[mem][te] = _fit_predict_offset(R[tr], y[tr], R[te], off[tr], off[te])
            elif mem == "gbm":
                p[mem][te] = _fit_predict_gbm(des[mem][tr], y[tr], des[mem][te])
            elif mem == "iso":
                p[mem][te] = _fit_predict_iso(des[mem][tr], y[tr], des[mem][te],
                                              t[tr].astype("datetime64[s]").astype(np.int64))
            elif mem in ("rf", "et"):
                p[mem][te] = _fit_predict_forest(des[mem][tr], y[tr], des[mem][te], mem)
            elif mem == "xgb":
                p[mem][te] = _fit_predict_xgb(des[mem][tr], y[tr], des[mem][te])
            elif mem == "lgbm":
                p[mem][te] = _fit_predict_lgbm(des[mem][tr], y[tr], des[mem][te])
            elif mem in RECENCY:
                mode, days = RECENCY[mem]
                p[mem][te] = _fit_predict_gbm_recency(
                    des[mem][tr], y[tr], des[mem][te],
                    t[tr].astype("datetime64[s]").astype(np.int64), mode, days)
            elif mem in GBM_GRID:
                p[mem][te] = _fit_predict_gbm_tuned(des[mem][tr], y[tr], des[mem][te],
                                                    GBM_GRID[mem])
            else:
                p[mem][te] = _fit_predict(des[mem][tr], y[tr], des[mem][te])
    return p, d


GAME_MARKETS = ("h2h", "spreads", "totals")


def parity_for(market):
    """Which production surface this market's board has to match.

    The distinction is the shipped one, not a choice made here. The batter and
    pitcher write paths carry an evPerUnit and production shows a pick only when
    it is positive -- isEvFilteredPick. The game write path has no evPerUnit at
    all, so production shows a game pick on confidence and the heavy-juice veto
    alone -- isEvPassPick. harness/lib/metrics.ts defines both; PHASE1_SCOPE.md
    s1b records that the game markets are gated on the ev_pass slice for exactly
    this reason. Measuring a game board through an EV filter it does not have in
    production would not be measuring the product.
    """
    return "ev_pass" if market in GAME_MARKETS else "ev_filtered"


def board(d, p, tau=0.0, one_per=None, side=None, parity="ev_filtered",
          min_conf=60, collapse="maxEv"):
    """Turn calibrated probabilities into the picks the board would show.

    tau is an EV floor in units; 0.0 is "bet whenever the number is better than
    the price". one_per collapses an alternate ladder to a single bet on the
    best number available. side restricts the board to one side of the market --
    the same lever the shipped MLB_EV_SIDE_POLICY already pulls on hits, total
    bases, game_total and game_side -- and accepts "over", "under", or, for a
    signed handicap, "plus" / "minus" for the side receiving or laying the
    number.
    """
    d = d.copy()
    d["pOver"] = p
    ok = np.isfinite(p)
    dec_o = G.american_to_decimal(d["overOdds"].to_numpy(float))
    dec_u = G.american_to_decimal(d["underOdds"].to_numpy(float))
    ev_o = p * dec_o - (1 - p)
    ev_u = (1 - p) * dec_u - p
    take_over = ev_o >= ev_u
    d["evPerUnit"] = np.where(take_over, ev_o, ev_u)
    d["pickSide"] = np.where(take_over, d["sideOver"], d["sideUnder"])
    d["entryOdds"] = np.where(take_over, d["overOdds"], d["underOdds"])
    d["confidence"] = np.round(100 * np.where(take_over, p, 1 - p))
    d["hit"] = np.where(take_over, d["overHit"], 1 - d["overHit"].astype(float))
    d["voided"] = False

    # tau=None is a board with no EV filter at all: the side policy and the
    # heavy-juice veto decide it, which is exactly what the shipped
    # MLB_EV_SIDE_POLICY does on the game markets today. On a market whose price
    # is efficient but structurally biased -- the runline underdog is the
    # example -- an EV filter on top selects the games where the model disagrees
    # most with the price, which is where the model is most often wrong, and it
    # throws the structural edge away.
    keep = ok & (d["confidence"].to_numpy(float) >= min_conf)
    if parity == "ev_filtered":
        keep &= (d["evPerUnit"].to_numpy(float) > (0.0 if tau is None else tau))
    if side in ("over", "under"):
        want = d["sideOver"] if side == "over" else d["sideUnder"]
        keep &= (d["pickSide"].to_numpy() == want.to_numpy())
    elif side in ("plus", "minus"):
        # Handicap markets only: "plus" is whichever side RECEIVES the number.
        # On an MLB runline the line is the home number, so the home side is the
        # plus side when it is +1.5 and the away side is when the home line is
        # -1.5. Degenerate (== "over") on markets whose line is never negative.
        gets_points = d["line"].to_numpy(float) > 0
        want = np.where(gets_points if side == "plus" else ~gets_points,
                        d["sideOver"].to_numpy(), d["sideUnder"].to_numpy())
        keep &= (d["pickSide"].to_numpy() == want)
    sel = d[keep].copy()
    # the shipped heavy-juice under veto, unchanged
    sel = sel[~G.is_unbettable_juice(sel["confidence"], sel["entryOdds"], sel["pickSide"])]
    if one_per and len(sel):
        # Which line to keep when a player-game qualifies at several of them.
        #   maxEv      the biggest edge on offer -- and the one most likely to
        #              be the model's largest error, because selecting on an
        #              estimate selects its noise along with its signal
        #   mostBooks  the number the most books are quoting: the main line,
        #              the liquid one, and the one a desk would actually bet
        by = "evPerUnit" if collapse == "maxEv" or "nBooks" not in sel else "nBooks"
        sel = (sel.sort_values([by, "evPerUnit"], ascending=False)
                  .drop_duplicates(one_per)
                  .sort_values("commenceTime"))
    return sel.reset_index(drop=True)


def unit_key(market):
    """What counts as ONE bet: a player-game for props, a game for game markets."""
    return ["game_pk"] if market in ("h2h", "spreads", "totals") else ["game_pk", "playerId"]


def summarise(sel, label=""):
    met = G.grade(sel)
    v, why = G.verdict(met)
    if met["graded"]:
        _, clo, _ = G.cluster_bootstrap_ci(sel)
    else:
        clo = np.nan
    return dict(board=label, n=met["graded"], winPct=round(met["winRatePct"], 2),
                roi=round(met["roiPct"], 2), ciLo=round(met["roiCiLoPct"], 2),
                clusCiLo=round(100 * clo, 2) if np.isfinite(clo) else np.nan,
                units=round(met["units"], 1),
                events=int(sel["game_pk"].nunique()) if len(sel) else 0,
                verdict=v, why=why)
