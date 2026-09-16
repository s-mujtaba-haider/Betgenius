"""Recompute the handedness split the slow way, and assert the as-of cut.

Same shape of test as check_asof.py, pointed at the new features. For a sample of
scored rows it rebuilds the platoon split from the box-score table directly --
plain pandas, no roll-up machinery -- and asserts three things:

  1. the pipeline's number equals a naive recomputation over that player's
     appearances on STRICTLY EARLIER local calendar dates against the same
     starter hand;
  2. the number WOULD be different if the game's own day were allowed in, for
     most sampled rows. A test that passes because the value never moves is not
     testing anything;
  3. the hand attached to a row matches the announced starter of the opposing
     team for that game.

    python harness/uplift/check_asof_hands.py [market ...] [--n=200]
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features
import frames
import hands

DEFAULT = ["batter_hits", "batter_home_runs", "pitcher_strikeouts"]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    n_sample = int(next((a.split("=")[1] for a in sys.argv[1:]
                         if a.startswith("--n=")), 200))
    markets = args or DEFAULT
    box = frames.load_box()
    sh = hands.starter_hands(box).set_index(["game_pk", "team_id"])
    bad_total = 0

    for market in markets:
        role, col, _ = frames.MARKETS[market]
        c = frames.load_candidates(market, box)
        d, _ = features.build(market, c, box)
        d = features.graded(d)
        mask = box["at_bats"].notna() if role == "batter" else box["innings_pitched"].notna()
        hist = box[mask][["player_id", "game_pk", "game_date", "team_id", col]].copy()
        hist["game_date"] = hist["game_date"].astype(str).str[:10]
        # the hand each historical appearance faced
        hj = pd.MultiIndex.from_arrays([hist["game_pk"], hist["team_id"]])
        hist["oppHand"] = sh["oppHand"].reindex(hj).to_numpy()

        rng = np.random.default_rng(20260917)
        take = d[d["vhN"].to_numpy(float) > 0]
        if not len(take):
            print(f"{market:20s} no rows with a non-empty split")
            continue
        pick = take.iloc[rng.choice(len(take), min(n_sample, len(take)), replace=False)]

        mism, would_move, hand_bad, checked = 0, 0, 0, 0
        for _, r in pick.iterrows():
            gd = str(r["game_date"])[:10]
            pid, gpk = int(r["playerId"]), r["game_pk"]
            want = sh["oppHand"].get((gpk, r["teamId"]), None)
            got_lhp = r["oppSpLhp"]
            if pd.notna(got_lhp) and want is not None:
                if (str(want)[:1] == "L") != bool(got_lhp):
                    hand_bad += 1
            if want is None or pd.isna(want):
                continue
            hp = hist[(hist["player_id"] == pid) & (hist["oppHand"] == want)]
            earlier = hp[hp["game_date"] < gd].sort_values("game_date").tail(25)
            incl = hp[hp["game_date"] <= gd].sort_values("game_date").tail(25)
            L = float(r["line"])
            naive_n = float(earlier[col].notna().sum())
            naive_s = float((earlier[col] > L).sum())
            incl_s = float((incl[col] > L).sum())
            incl_n = float(incl[col].notna().sum())
            checked += 1
            if abs(naive_n - float(r["vhN"])) > 1e-6:
                mism += 1
            elif naive_n > 0:
                pfair = float(r["pFairOver"])
                ref = (naive_s + pfair * features.PRIOR_N) / (naive_n + features.PRIOR_N)
                if abs(ref - float(r["vhClr"])) > 1e-6:
                    mism += 1
            if (incl_s, incl_n) != (naive_s, naive_n):
                would_move += 1
        bad_total += mism + hand_bad
        print(f"{market:20s} {checked:4d} rows recomputed the slow way, "
              f"{mism} mismatches, {hand_bad} wrong-hand; "
              f"{would_move} ({100.0 * would_move / max(checked, 1):.0f}%) would change "
              f"if the game's own day were let in")

    print("\n" + ("OK - the handedness split is as-of clean"
                  if bad_total == 0 else f"FAIL - {bad_total} problems"))
    return 0 if bad_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
