"""R5-04 -- the `8-pooled-ml` architecture, rebuilt here, and its instability.

One XGBoost model across every market at once, with market identity as a
feature, instead of eleven per-market models. That is the only architectural
idea either branch had that this project does not already implement.

The branch's own status document says the result is run-to-run unstable -- "the
same model, re-run, produces a different PASS/FAIL verdict from run to run" --
and tells anyone picking the work back up to fix that FIRST. So this script does
the diagnosis before the result, exactly as Part 33 asks:

  (a) fit the pooled model FIVE times, seeds 1..5, with row order, feature order
      and fold boundaries byte-identical across runs;
  (b) report all five. Never select one.

The stability bar is the project's own noise band, 0.0011 of log loss -- the same
number every other round-4 and round-5 experiment is held to. If the spread
across seeds exceeds it, the pooled model is rejected as a production candidate
and the instability IS the finding.

What is pooled
--------------
Markets do not share a feature vector: a prop carries `expOpp` and a game market
carries `eloDiff`. The pooled design is therefore the INTERSECTION of the eleven
feature sets plus a market one-hot -- which is what "market type as a categorical
feature" means when the feature spaces genuinely differ. The intersection is
reported in the output so the reduction is visible rather than implied.

Splitting is chronological across the WHOLE pool, on the clock, with the same
warm-up this project uses everywhere. It is deliberately NOT the branch's
"75/25 within each calendar year, then pooled", which puts 2026 training rows
and 2024 test rows in the same pooled split and is not a chronological holdout.

    UPLIFT_DATA_DIR=... python harness/uplift/exp_pooled_r5.py --tag=_r5
"""
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features
import frames
import mlbgate as G
import policy
import run_final

HERE = os.path.dirname(os.path.abspath(__file__))
REPORTS = os.path.join(HERE, "reports")
SEEDS = (1, 2, 3, 4, 5)
NOISE = 0.0011
ORDER = run_final.ORDER


def logloss(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def build_pool():
    """Every market's features, reduced to the shared columns, concatenated."""
    box = frames.load_box()
    parts, colsets = [], []
    for m in ORDER:
        if not frames.market_files(m):
            print(f"  {m}: no data files")
            continue
        c = frames.load_candidates(m, box, price="best")
        d, cols = features.build(m, c, box, lag_days=0)
        g = features.graded(d)
        if len(g) < 300:
            continue
        g = g.copy()
        g["market"] = m
        parts.append((m, g, cols))
        colsets.append(set(cols))
        print(f"  {m:20s} {len(g):7,} graded  {len(cols)} feature columns")
        sys.stdout.flush()
    shared = sorted(set.intersection(*colsets))
    print(f"\nshared feature columns across all {len(parts)} markets: {len(shared)}")
    print("  " + ", ".join(shared))
    keep = shared + ["market", "commenceTime", "overHit"]
    pool = pd.concat([g[keep] for _, g, _ in parts], ignore_index=True)
    # deterministic ordering: the clock, then the market name, then the row's own
    # position. Two runs of this script produce byte-identical row order.
    pool = pool.sort_values(["commenceTime", "market"], kind="stable").reset_index(drop=True)
    for m in ORDER:
        pool[f"mkt_{m}"] = (pool["market"] == m).astype(float)
    feat = shared + [f"mkt_{m}" for m in ORDER]
    return pool, feat, shared


def walkforward_pooled(pool, feat, seed):
    """One pooled model, refit forward on the clock. Same contract as policy."""
    import xgboost as xgb
    y = pool["overHit"].astype(int).to_numpy()
    t = pd.to_datetime(pool["commenceTime"], utc=True).to_numpy("datetime64[ns]")
    X = pool[feat].to_numpy(float)
    n = len(pool)
    start = int(policy.WARMUP * n)
    edges = [t[start]]
    step = max(1, (n - start) // policy.N_BLOCKS)
    for i in range(start + step, n, step):
        if t[i] > edges[-1]:
            edges.append(t[i])
    edges.append(np.datetime64("2999-01-01T00:00:00"))
    p = np.full(n, np.nan)
    for lo, hi in zip(edges[:-1], edges[1:]):
        te = (t >= lo) & (t < hi)
        tr = t < lo
        if te.sum() == 0 or tr.sum() < 200:
            continue
        m = xgb.XGBClassifier(
            max_depth=3, n_estimators=200, learning_rate=0.05, min_child_weight=200,
            reg_lambda=5.0, subsample=0.8, colsample_bytree=0.8,
            tree_method="hist", n_jobs=1, random_state=seed,
            eval_metric="logloss", verbosity=0)
        m.fit(X[tr], y[tr])
        p[te] = m.predict_proba(X[te])[:, 1]
    return p


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_r5")
    t0 = time.time()
    print("building the pool ...")
    pool, feat, shared = build_pool()
    print(f"\npooled rows: {len(pool):,}   features: {len(feat)}"
          f"   [{time.time() - t0:.0f}s]\n")

    y = pool["overHit"].astype(int).to_numpy()
    t = pool["commenceTime"]
    rows = []
    preds = {}
    for seed in SEEDS:
        ts = time.time()
        p = walkforward_pooled(pool, feat, seed)
        preds[seed] = p
        ok = np.isfinite(p)
        # SELECT / VERDICT split on the pooled clock, same halving rule as the
        # per-market pipeline. The verdict half is NOT read to choose anything --
        # it is reported so the instability can be seen where it matters.
        cut = t[ok].quantile(0.5)
        sel = ok & (t < cut).to_numpy()
        ver = ok & (t >= cut).to_numpy()
        # SELECT-A / SELECT-B inside the select half, q=0.5
        sub = t[sel].quantile(0.5)
        A = sel & (t < sub).to_numpy()
        B = sel & (t >= sub).to_numpy()
        r = dict(seed=seed, n=int(ok.sum()),
                 llAll=round(logloss(p[ok], y[ok]), 6),
                 llSelectA=round(logloss(p[A], y[A]), 6),
                 llSelectB=round(logloss(p[B], y[B]), 6),
                 llVerdict=round(logloss(p[ver], y[ver]), 6),
                 secs=round(time.time() - ts, 1))
        rows.append(r)
        print(f"  seed {seed}: llSelectB={r['llSelectB']:.6f}  llAll={r['llAll']:.6f}"
              f"  [{r['secs']:.0f}s]")
        sys.stdout.flush()

    out = pd.DataFrame(rows)
    spread = float(out["llSelectB"].max() - out["llSelectB"].min())
    stable = spread < NOISE
    out["spreadSelectB"] = round(spread, 6)
    out["noiseBand"] = NOISE
    out["STABLE"] = stable
    out.to_csv(os.path.join(REPORTS, f"pooled_stability{tag}.csv"), index=False)

    print("\n" + "=" * 78)
    print(out.to_string(index=False))
    print("=" * 78)
    print(f"SELECT-B log-loss spread across 5 seeds: {spread:.6f}"
          f"   noise band: {NOISE}")
    print(f"STABILITY VERDICT: {'PASS' if stable else 'FAIL'}"
          f"  ->  {'pooled model proceeds to the adoption rule' if stable else 'pooled model REJECTED as a production candidate; the instability is the finding'}")

    # per-market log loss of the pooled model against the per-market incumbent,
    # reported whichever way it goes. Seed 1 only, named in advance, not chosen.
    p = preds[SEEDS[0]]
    ok = np.isfinite(p)
    per = []
    for m in ORDER:
        sel = ok & (pool["market"] == m).to_numpy()
        if sel.sum() < 500:
            continue
        per.append(dict(market=m, n=int(sel.sum()),
                        pooledLogLoss=round(logloss(p[sel], y[sel]), 6)))
    pd.DataFrame(per).to_csv(os.path.join(REPORTS, f"pooled_permarket{tag}.csv"),
                             index=False)
    print("\nper-market log loss of the pooled model (seed 1, named in advance):")
    print(pd.DataFrame(per).to_string(index=False))
    print(f"\ntotal {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
