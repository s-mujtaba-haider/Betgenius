"""Would production have shown every pick on this board?

`policy.board` re-implements the shipped eligibility rules rather than calling
them, so the claim "this board is production parity" is a claim about two pieces
of code agreeing. This file checks it the other way round: it rebuilds each
market's final board, hands every row to the ported shipped predicates in
`mlbgate` -- `ev_pass_mask` / `ev_filtered_mask`, the line-for-line port of
isEvPassPick / isEvFilteredPick -- and counts the rows they reject.

Three rules make up the shipped filter, and `policy.board` applies two of them
directly:

    confidence >= 60          the board's min_conf
    not isUnbettableJuice     applied verbatim
    over side must clear breakeven   NOT applied by policy.board

The third is the one worth measuring. On an ev_filtered board an EV floor above
zero implies it except at very long prices, and on an ev_pass board it bites
only where the picked side is literally called "over", so on a board whose side
policy is `under` it is vacuous. Rather than argue that, this counts.

    python harness/uplift/parity_audit.py [--tag=_c60]
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cache
import mlbgate as G
import policy
import run_final

REPORTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def main():
    tag = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--tag=")), "_c60")
    f = pd.read_csv(os.path.join(REPORTS, f"final{tag}.csv"))
    rows = []
    for _, r in f.iterrows():
        c = build_cache.load(r["market"])
        if c is None:
            continue
        spec = tuple(str(r["spec"]).split("+"))
        side = None if r["side"] == "both" else r["side"]
        sel = policy.board(c["frame"], run_final.prob(c, spec), tau=float(r["tau"]),
                           one_per=policy.unit_key(r["market"]), side=side,
                           parity=r["parity"], min_conf=int(r["minConf"]),
                           collapse=str(r["collapse"]))
        if not len(sel):
            rows.append(dict(market=r["market"], board=0, conf60=0, juice=0,
                             breakeven=0, shippedOk=0, parity="empty"))
            continue
        shipped = (G.ev_filtered_mask(sel) if r["parity"] == "ev_filtered"
                   else G.ev_pass_mask(sel))
        conf = sel["confidence"].to_numpy(float)
        rows.append(dict(
            market=r["market"], board=int(len(sel)),
            conf60=int((conf < 60).sum()),
            juice=int(G.is_unbettable_juice(sel["confidence"], sel["entryOdds"],
                                            sel["pickSide"]).sum()),
            breakeven=int(((sel["pickSide"].to_numpy() == "over") &
                           ~G.passes_over_breakeven(sel["confidence"],
                                                    sel["entryOdds"])).sum()),
            shippedOk=int(shipped.sum()),
            parity=str(r["parity"])))
    d = pd.DataFrame(rows)
    d["rejected"] = d["board"] - d["shippedOk"]
    d.to_csv(os.path.join(REPORTS, f"parity_audit{tag}.csv"), index=False)
    pd.set_option("display.width", 200)
    print(d.to_string(index=False))
    tot, rej = int(d["board"].sum()), int(d["rejected"].sum())
    print(f"\nboard rows {tot:,}   rejected by the shipped predicates {rej:,}"
          f"   ({100.0 * rej / max(tot, 1):.3f}%)")
    print("PARITY HOLDS" if rej == 0 else "PARITY DOES NOT HOLD -- see `rejected`")
    print(f"\n-> {os.path.join(REPORTS, f'parity_audit{tag}.csv')}")


if __name__ == "__main__":
    main()
