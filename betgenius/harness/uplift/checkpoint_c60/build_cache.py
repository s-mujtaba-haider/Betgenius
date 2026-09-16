"""Build every market once: candidates -> features -> walk-forward member
probabilities, cached to disk.

Everything downstream (the spec sweep, the placebo, the price sensitivity, the
final report) reads this cache, so the expensive half of the pipeline runs once
and every later comparison is guaranteed to be on identical scores.

    python harness/uplift/build_cache.py [market ...] [--lag=N] [--price=best]
"""
import os
import pickle
import sys
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features
import frames
import policy
import run_markets

# UPLIFT_CACHE_DIR lets a second feature set be built side by side without
# clobbering the live cache, which is what attribute.py compares against.
CACHE = os.environ.get(
    "UPLIFT_CACHE_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache"))


def cache_path(market, lag, price, warmup=policy.WARMUP, blocks=policy.N_BLOCKS):
    stem = f"{market}_lag{lag}_{price}"
    if (warmup, blocks) != (policy.WARMUP, policy.N_BLOCKS):
        stem += f"_w{int(warmup * 100)}b{blocks}"
    return os.path.join(CACHE, stem + ".pkl")


def build(market, box, lag=0, price="best", warmup=policy.WARMUP, blocks=policy.N_BLOCKS):
    c = frames.load_candidates(market, box, price=price)
    d, cols = features.build(market, c, box, lag_days=lag)
    g = features.graded(d)
    if len(g) < 300:
        return None
    probs, g = policy.walkforward(g, cols, members=run_markets.MEMBERS,
                                  warmup=warmup, n_blocks=blocks)
    keep = [c for c in ("market", "game_date", "commenceTime", "eventId", "game_pk",
                        "playerId", "player_name", "line", "overOdds", "underOdds",
                        "pFairOver", "overHit", "actual", "sideOver", "sideUnder",
                        "imp_over_med", "imp_under_med", "nHist", "isHome",
                        "empP", "parP", "nBooks") if c in g]
    return dict(market=market, frame=g[keep].copy(), probs=probs, cols=cols,
                candidates=int(len(d)), graded=int(len(g)),
                events=int(g["game_pk"].nunique()),
                fromDate=g["game_date"].min(), toDate=g["game_date"].max())


def load(market, lag=0, price="best", warmup=policy.WARMUP, blocks=policy.N_BLOCKS):
    p = cache_path(market, lag, price, warmup, blocks)
    return pickle.load(open(p, "rb")) if os.path.exists(p) else None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    lag = next((int(a.split("=")[1]) for a in flags if a.startswith("--lag=")), 0)
    price = next((a.split("=")[1] for a in flags if a.startswith("--price=")), "best")
    warmup = float(next((a.split("=")[1] for a in flags if a.startswith("--warmup=")),
                        policy.WARMUP))
    blocks = int(next((a.split("=")[1] for a in flags if a.startswith("--blocks=")),
                      policy.N_BLOCKS))
    markets = args or [m for m in frames.MARKETS
                       if frames.market_files(m)]
    os.makedirs(CACHE, exist_ok=True)
    box = frames.load_box()
    for m in markets:
        t0 = time.time()
        out = build(m, box, lag=lag, price=price, warmup=warmup, blocks=blocks)
        if out is None:
            print(f"  {m}: too few graded candidates")
            continue
        pickle.dump(out, open(cache_path(m, lag, price, warmup, blocks), "wb"), protocol=4)
        print(f"  {m:20s} {out['graded']:7,} graded  {out['events']:5,} events  "
              f"{out['fromDate']} -> {out['toDate']}  [{time.time() - t0:.0f}s]")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
