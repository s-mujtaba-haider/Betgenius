"""A vectorised re-implementation of policy.board + mlbgate.grade, for sweeps only.

The v2 global filter is chosen over 4,600 configurations x 11 markets. Built the
canonical way that is about 50,000 DataFrame copies, sorts and drop_duplicates,
which runs for hours; built this way it runs in minutes. So the SEARCH uses this
module and the RESULT does not: every board that reaches a report, a CSV or the
client table is rebuilt by policy.board and graded by mlbgate.grade, untouched.

`selfcheck()` asserts the two agree -- same n, same ROI to 1e-6 -- across every
market and a spread of filter settings, and run_final_v2.py calls it before it
uses this module for anything. A fast path is worth having only if it is
provably the same board.
"""
import numpy as np
import pandas as pd

import mlbgate as G
import policy


class Fast:
    """One market, one probability vector, one ladder-collapse convention."""

    def __init__(self, c, p, collapse="maxEv"):
        d = c["frame"]
        self.market = c["market"]
        self.n = len(d)
        dec_o = G.american_to_decimal(d["overOdds"].to_numpy(float))
        dec_u = G.american_to_decimal(d["underOdds"].to_numpy(float))
        ev_o = p * dec_o - (1 - p)
        ev_u = (1 - p) * dec_u - p
        take = ev_o >= ev_u
        self.ev = np.where(take, ev_o, ev_u)
        self.conf = np.round(100 * np.where(take, p, 1 - p))
        side = np.where(take, d["sideOver"].to_numpy(), d["sideUnder"].to_numpy())
        self.odds = np.where(take, d["overOdds"].to_numpy(float),
                             d["underOdds"].to_numpy(float))
        oh = d["overHit"].to_numpy(float)
        self.hit = np.where(take, oh, 1.0 - oh)
        self.ok = np.isfinite(p)
        self.juice = G.is_unbettable_juice(self.conf, self.odds, side)
        so, su = d["sideOver"].to_numpy(), d["sideUnder"].to_numpy()
        self.is_over = side == so
        gets = d["line"].to_numpy(float) > 0
        self.is_plus = side == np.where(gets, so, su)
        self.profit = np.where(self.hit > 0.5, G.american_to_decimal(self.odds), -1.0)
        # int64 nanoseconds, not object Timestamps: `score` is called ~50,000
        # times in one global sweep and an object-array comparison over 90,000
        # rows dominated the sweep. policy.walkforward hands the cache a frame
        # already sorted on the clock, so a time window is a SLICE -- asserted,
        # not assumed, because a frame out of order would silently score the
        # wrong window.
        # as_unit("ns") is load-bearing: pandas stores this column at MICROsecond
        # resolution, so a bare astype("int64") yields microseconds while
        # pd.Timestamp(...).value yields nanoseconds, and every windowed score
        # then reads the wrong window -- silently, because the counts stay
        # plausible. Pin both sides to ns.
        self.t = pd.DatetimeIndex(pd.to_datetime(d["commenceTime"], utc=True)).as_unit("ns").asi8
        if self.n > 1 and not (np.diff(self.t) >= 0).all():
            raise AssertionError(f"{self.market}: cached frame is not in commence-time order")
        key = policy.unit_key(self.market)
        codes = (pd.MultiIndex.from_arrays([d[k] for k in key]).factorize()[0]
                 if len(key) > 1 else d[key[0]].factorize()[0])
        by = self.ev if (collapse == "maxEv" or "nBooks" not in d) else d["nBooks"].to_numpy(float)
        self.order = np.lexsort((-self.ev, -by))
        # plain ndarray, not a Series: board_mask runs ~50,000 times in one
        # global sweep and a boolean take on a Series rebuilds an index every
        # call. np.unique(..., return_index=True) gives the first occurrence of
        # each unit key in this order, which is the same row `duplicated()`
        # kept. selfcheck is what proves the two agree.
        self._codes = codes[self.order]

    def board_mask(self, tau, side, conf, parity):
        k = self.ok & (self.conf >= conf) & ~self.juice
        if parity == "ev_filtered":
            k &= self.ev > tau
        if side == "over":
            k &= self.is_over
        elif side == "under":
            k &= ~self.is_over
        elif side == "plus":
            k &= self.is_plus
        elif side == "minus":
            k &= ~self.is_plus
        ks = k[self.order]
        rows = self.order[ks]
        if rows.size:
            _, first = np.unique(self._codes[ks], return_index=True)
            rows = rows[first]
        out = np.zeros(self.n, bool)
        out[rows] = True
        return out

    @staticmethod
    def _ns(x):
        """A cut -> int64 nanoseconds UTC, on the same clock as self.t."""
        if x is None:
            return None
        ts = pd.Timestamp(x)
        ts = ts.tz_localize("UTC") if ts.tzinfo is None else ts.tz_convert("UTC")
        return ts.as_unit("ns").value

    def score(self, mask, lo=None, hi=None, kblocks=3):
        a = 0 if lo is None else int(np.searchsorted(self.t, self._ns(lo), "left"))
        b_ = self.n if hi is None else int(np.searchsorted(self.t, self._ns(hi), "left"))
        if a >= b_:
            return dict(n=0, roi=np.nan, units=0.0, blocks=[], minBlock=np.nan)
        pr = self.profit[a:b_][mask[a:b_]]
        if pr.size == 0:
            return dict(n=0, roi=np.nan, units=0.0, blocks=[], minBlock=np.nan)
        # already in clock order, because the frame is
        b = ([float(100 * x.mean()) for x in np.array_split(pr, kblocks)]
             if pr.size >= kblocks * 40 else [])
        return dict(n=int(pr.size), roi=float(100 * pr.mean()), units=float(pr.sum()),
                    blocks=b, minBlock=min(b) if b else np.nan)


def selfcheck(caches, probs_of, quiet=True):
    """Assert the fast path builds the same board the canonical one does."""
    cases = ((0.02, None, 55, "ev_filtered"), (0.0, "under", 50, "ev_filtered"),
             (0.04, "over", 60, "ev_pass"), (0.01, "plus", 0, "ev_filtered"),
             (0.03, "minus", 45, "ev_filtered"))
    bad = []
    for c in caches:
        p = probs_of(c)
        scored = c["frame"][np.isfinite(c["probs"]["price"])]
        cut = scored["commenceTime"].quantile(0.5) if len(scored) else None
        for collapse in ("maxEv", "mostBooks"):
            f = Fast(c, p, collapse)
            for tau, side, conf, par in cases:
                full = policy.board(c["frame"], p, tau=tau,
                                    one_per=policy.unit_key(c["market"]),
                                    side=side, parity=par, min_conf=conf,
                                    collapse=collapse)
                mask = f.board_mask(tau, side, conf, par)
                # unwindowed, and BOTH halves: a clock-unit error in the window
                # slice leaves the unwindowed board correct and silently moves
                # the other two, so all three are checked.
                wins = [(None, None, full)]
                if cut is not None:
                    wins += [(None, cut, full[full["commenceTime"] < cut]),
                             (cut, None, full[full["commenceTime"] >= cut])]
                for lo, hi, ref_df in wins:
                    ref = G.grade(ref_df)
                    got = f.score(mask, lo, hi)
                    if ref["graded"] != got["n"] or (
                            ref["graded"] and abs(ref["roiPct"] - got["roi"]) > 1e-6):
                        bad.append((c["market"], collapse, tau, side, conf, par,
                                    str(lo)[:10], str(hi)[:10], ref["graded"], got["n"]))
    if bad:
        raise AssertionError(f"boardfast disagrees with policy.board: {bad[:5]}")
    if not quiet:
        print(f"  boardfast selfcheck: {len(caches)} markets x 2 collapses x "
              f"{len(cases)} filters x 3 windows, all identical to policy.board")
    return True
