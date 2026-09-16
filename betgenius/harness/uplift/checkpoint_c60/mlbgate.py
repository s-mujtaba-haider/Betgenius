"""Faithful Python port of the shipped MLB gate maths.

Sources ported, line for line:
  src/lib/odds.ts            impliedProb
  src/lib/kelly.ts           americanToDecimal
  harness/lib/oddsmath.ts    unitProfit, noVigProb, isUnbettableJuice,
                             passesOverBreakeven
  harness/lib/metrics.ts     mulberry32, bootstrapMeanCI, isEvPassPick,
                             isEvFilteredPick, computeTierMetrics (graded slice),
                             evaluateEvGate  (EV_GATE_MIN_GRADED = 500)

The gate itself is NOT modified anywhere in this work. verify_gate.py replays
the shipped harness report JSONs through this module and reproduces their
published evGate block, which is what makes that claim checkable.
"""
import numpy as np

EV_GATE_MIN_GRADED = 500


def implied_prob(odds):
    o = np.asarray(odds, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(o < 0, -o / (-o + 100.0), 100.0 / (o + 100.0))


def american_to_decimal(odds):
    """Net profit on a 1u win. -110 -> 0.909, +150 -> 1.5."""
    o = np.asarray(odds, dtype=float)
    return np.where(o == 0, 1.0, np.where(o < 0, 100.0 / np.abs(o), o / 100.0))


def prob_to_american(p):
    """Inverse of impliedProb, keeping the -100/+100 branch convention."""
    p = np.clip(np.asarray(p, dtype=float), 1e-9, 1 - 1e-9)
    return np.where(p > 0.5, -100.0 * p / (1.0 - p), 100.0 * (1.0 - p) / p)


def unit_profit(odds, won):
    return np.where(np.asarray(won, dtype=bool), american_to_decimal(odds), -1.0)


def no_vig_prob(side_odds, other_odds):
    ps, po = implied_prob(side_odds), implied_prob(other_odds)
    s = ps + po
    return np.where(np.isfinite(s) & (s > 0), ps / s, 0.5)


def mulberry32(seed):
    """Exact port of harness/lib/metrics.ts mulberry32 (32-bit, unsigned)."""
    a = seed & 0xFFFFFFFF

    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((a ^ (a >> 15)) * (1 | a)) & 0xFFFFFFFF
        t = (t ^ (t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return rng


def bootstrap_mean_ci(values, iterations=2000, seed=20260701, exact=False):
    """Percentile bootstrap on the unit-profit series.

    exact=True walks the harness's own mulberry32 stream and reproduces the
    shipped CI bit for bit; it is O(iterations * n) in pure Python, so it is
    used by verify_gate.py and not in the sweeps. exact=False draws the same
    percentile bootstrap from numpy's PCG64 at a fixed seed.
    """
    v = np.asarray(values, dtype=float)
    n = v.size
    if n == 0:
        return 0.0, 0.0, 0.0
    mean = float(v.mean())
    if n < 2:
        return mean, mean, mean
    if exact:
        rng = mulberry32(seed)
        means = np.empty(iterations)
        for it in range(iterations):
            s = 0.0
            for _ in range(n):
                s += v[int(rng() * n)]
            means[it] = s / n
        means.sort()
    else:
        r = np.random.default_rng(seed)
        idx = r.integers(0, n, size=(iterations, n))
        means = np.sort(v[idx].mean(axis=1))
    lo = float(means[int(0.025 * iterations)])
    hi = float(means[min(iterations - 1, int(0.975 * iterations))])
    return mean, lo, hi


def is_unbettable_juice(confidence, odds, side):
    """D-164 under-side heavy-juice veto. Over/home/away are never flagged."""
    c, o = np.asarray(confidence, float), np.asarray(odds, float)
    under = np.asarray(side) == "under"
    flag = (((c >= 90) & (o <= -350)) | ((c >= 80) & (o <= -300)) |
            ((c >= 70) & (o <= -250)) | ((c >= 60) & (o <= -200)))
    return under & flag


def passes_over_breakeven(confidence, odds):
    return np.asarray(confidence, float) / 100.0 >= implied_prob(odds)


def ev_pass_mask(df):
    m = df["confidence"].to_numpy(float) >= 60
    m &= ~is_unbettable_juice(df["confidence"], df["entryOdds"], df["pickSide"])
    over = df["pickSide"].to_numpy() == "over"
    m &= ~(over & ~passes_over_breakeven(df["confidence"], df["entryOdds"]))
    return m


def ev_filtered_mask(df):
    ev = df["evPerUnit"].to_numpy(float) if "evPerUnit" in df else np.full(len(df), np.nan)
    return ev_pass_mask(df) & (np.nan_to_num(ev, nan=-np.inf) > 0)


def grade(df, seed=20260701, exact=False):
    """computeTierMetrics' graded slice: drop voids and pushes, then ROI."""
    voided = df["voided"].fillna(False).astype(bool) if "voided" in df else False
    g = df[(~voided) & df["hit"].notna()] if "voided" in df else df[df["hit"].notna()]
    wins = g["hit"].astype(bool).to_numpy()
    n = int(wins.size)
    if n == 0:
        return dict(graded=0, wins=0, winRatePct=0.0, roiPct=0.0,
                    roiCiLoPct=0.0, roiCiHiPct=0.0, units=0.0)
    up = unit_profit(g["entryOdds"].to_numpy(float), wins)
    mean, lo, hi = bootstrap_mean_ci(up, seed=seed, exact=exact)
    return dict(graded=n, wins=int(wins.sum()), winRatePct=100.0 * wins.mean(),
                roiPct=100.0 * mean, roiCiLoPct=100.0 * lo, roiCiHiPct=100.0 * hi,
                units=float(up.sum()))


def verdict(m):
    """evaluateEvGate, unchanged: n>=500 -> ROI decides; below the floor the
    95% CI lower bound must clear zero."""
    if m["graded"] == 0:
        return "NO_DATA", "no graded picks in ev_filtered slice"
    if m["graded"] >= EV_GATE_MIN_GRADED:
        if m["roiPct"] > 0:
            return "PASS", (f"graded n={m['graded']} >= {EV_GATE_MIN_GRADED} "
                            f"and ROI {m['roiPct']:.2f}% > 0%")
        return "FAIL", (f"graded n={m['graded']} >= {EV_GATE_MIN_GRADED} "
                        f"but ROI {m['roiPct']:.2f}% <= 0%")
    if m["roiCiLoPct"] > 0:
        return "PASS", (f"graded n={m['graded']} < {EV_GATE_MIN_GRADED} but ROI CI "
                        f"lower bound {m['roiCiLoPct']:.2f}% > 0%")
    return "FAIL", (f"graded n={m['graded']} < {EV_GATE_MIN_GRADED} and ROI CI "
                    f"lower bound {m['roiCiLoPct']:.2f}% <= 0%")


def cluster_bootstrap_ci(df, key="eventId", iterations=2000, seed=20260701):
    """ROI CI resampling whole GAMES, not picks.

    Picks on the same game settle together, so a pick-level CI understates the
    spread whenever a board holds several lines on one event. Reported next to
    the gate's own number everywhere, never in place of it.
    """
    if len(df) == 0:
        return 0.0, 0.0, 0.0
    up = unit_profit(df["entryOdds"].to_numpy(float), df["hit"].astype(bool).to_numpy())
    codes, _ = df[key].factorize()
    order = np.argsort(codes, kind="stable")
    up_s, codes_s = up[order], codes[order]
    starts = np.searchsorted(codes_s, np.arange(codes_s.max() + 1), side="left")
    ends = np.searchsorted(codes_s, np.arange(codes_s.max() + 1), side="right")
    sums = np.add.reduceat(up_s, starts) if len(starts) else np.array([])
    cnts = (ends - starts).astype(float)
    r = np.random.default_rng(seed)
    idx = r.integers(0, len(sums), size=(iterations, len(sums)))
    means = np.sort(sums[idx].sum(axis=1) / cnts[idx].sum(axis=1))
    mean = float(up.mean())
    return mean, float(means[int(0.025 * iterations)]), float(means[min(iterations - 1, int(0.975 * iterations))])
