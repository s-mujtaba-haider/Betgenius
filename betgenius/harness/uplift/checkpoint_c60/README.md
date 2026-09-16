# `harness/uplift` — the MLB Phase 1 market validation run

This directory answers one question for each of the eleven MLB markets: **on
clean, point-in-time data, priced the way the product actually prices, does a
board built on that market beat the vig?**

It does not touch the production scorer, `algorithm_weights`, or the gate. It is
read-only against the database and writes nothing back.

---

## The rules it works under

| Rule | Where it is enforced |
|---|---|
| The gate is the shipped one, unmodified | `mlbgate.py`, proved by `verify_gate.py` |
| The entry price is the shipped convention — best number at that line | `frames.load_candidates(price="best")`, mirroring `best_price.ts` |
| The D-164 heavy-juice under veto still applies | `policy.board` |
| Features may only read box scores from an **earlier local calendar date** | `frames.asof_rollup`, `frames.load_box` |
| Training cuts are made on the clock, never on row index | `policy.walkforward` |
| Nothing is chosen on the window that produces the verdict | `run_final.py` |

Three of those exist because each has produced a fake edge at least once. The
calendar-date rule is the big one: `game_date` read as a timestamp arrives
shifted by the client timezone, which moves a late start across midnight and
lets an as-of join match a game to its own box score.

---

## Pipeline

```
dump_box.ts        every box-score line, game_date pulled as ::text on purpose
dump_odds.ts       the full priced universe per market, at the entry snapshot
ingest_odds_api.ts the two markets the warehouse never held, from the provider
api_to_csv.py      those, folded into the same candidate shape
        |
frames.py          price -> outcome. Grading, identity, team/park resolution
features.py        point-in-time features + the per-market statistical model
policy.py          walk-forward calibration; both sides priced; the board
mlbgate.py         the shipped gate, ported and verified
        |
build_cache.py     runs the expensive half once, caches it
run_final.py       THE result: global filter, per-market side, gate.
                   Run it as --conf=60: that pins the confidence floor to the
                   value isEvPassPick enforces and takes it out of the search
parity_audit.py    hands every row of a final board back to the SHIPPED
                   predicates and counts what they reject. Run before quoting
                   any board: the round-1 board fails it at 36%
boardfast.py       vectorised board for the sweeps only, with a selfcheck that
                   asserts it is identical to policy.board on three windows
exp_price_members.py  E16: are there better price-only members? (no)
exp_nested_rules.py   E17/E18: four selection RULES, each re-derived on
                   SELECT-A and scored on SELECT-B. The adoption test
compare_runs.py    regression ledger, market by market, between two runs
run_improve.py     the roadmap's per-market improvement loop + experiment log
robustness.py      placebo lag, price convention, refit schedule
diag_signal.py     does any signal survive the price being in the model?
attribute.py       the same filter over both feature sets, to separate a
                   feature gain from a filter gain
check_asof.py      recomputes sampled feature rows the slow way and asserts the
                   as-of cut, including that the value WOULD change if the
                   game's own day were let in
build_workbook.py  the client workbook, built only from the report CSVs
```

## What the features are

Everything is built from two tables — box-score lines and the odds snapshot —
and every roll-up is as-of an **earlier calendar date** than the game it feeds.

| Family | What it is | Markets it exists for |
|---|---|---|
| empirical handicap | how often this player has already cleared **this** number, last 25 and last 100 appearances, shrunk toward the market's own price | every prop |
| opportunity model | rate per opportunity × expected opportunities, shrunk to a league prior, then adjusted for the opposing side's as-of allowance | every prop |
| lineup and rest | as-of batting-order slot, starter share, days since last appearance | batter props |
| team offence | the team's as-of on-base rate, runs scored and runs allowed per game | all |
| **park environment** | runs and home runs per game already hit **in this ballpark**, over the last 100 games there, shrunk hard to the league rate | all |
| **bullpen** | the relief corps' as-of runs per out, K and BB per batter faced and innings per game — rebuilt from relief box-score lines, not from the bullpen table the harness role cannot read | all |
| **starter workload** | the starter's pitch budget, pitches per out, walk rate, five-start form against his twenty-five-start baseline, and the start-to-start spread of his own outs | pitcher props, game markets |
| market numbers | the game's own total, moneyline and runline at the same snapshot, and the team totals implied by them | all |

The four bold rows are the second pass, and `attribute.py` is what says what they
were worth: scored through an identical filter, the feature set before them
clears the gate in 6 markets and the feature set after them in 9, with the three
markets that flip being the three those features were built for.

The per-market statistical model on top of them:

| Family | Model |
|---|---|
| hits, total bases, home runs, RBIs, runs, both strikeout markets | Poisson on rate-per-opportunity × expected opportunity, park-adjusted, plus a negative-binomial version of the same count |
| `pitcher_outs` | pitch budget ÷ pitches per out → expected outs, with the pitcher's **own** start-to-start spread as the standard deviation |
| `pitcher_strikeouts` | expected outs → batters faced (÷ 1 − opponent OBP) → strikeouts, negative binomial at the posted line |
| `totals`, `h2h`, `spreads` | the starter for as long as he lasts plus the bullpen for the rest, in a park with a run environment of its own, alongside the older form-only run model |

## Reproducing from scratch

```bash
cd betgenius
export DENO_CERT="$PWD/prod-ca-2021.crt"        # PowerShell: $env:DENO_CERT

# 1. data (read-only; one process at a time — harness_readonly allows 10 conns)
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/dump_box.ts
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/dump_odds.ts

# 2. the two markets with zero warehouse odds, and the pitcher_outs hole
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/ingest_odds_api.ts --markets=batter_runs_scored,batter_strikeouts --from=2024-04-01 --to=2024-10-02 --out=harness/uplift/data/api_rs_bk_2024.jsonl
deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/uplift/ingest_odds_api.ts --markets=pitcher_outs --from=2025-05-28 --to=2026-06-25 --out=harness/uplift/data/api_pitcher_outs.jsonl
python harness/uplift/api_to_csv.py

# 3. the run
python harness/uplift/verify_gate.py      # the gate port reproduces the shipped reports
python harness/uplift/build_cache.py
python harness/uplift/check_asof.py       # the as-of cut, recomputed the slow way
python harness/uplift/run_final.py --conf=60 --tag=_c60   # THE run
python harness/uplift/parity_audit.py --tag=_c60          # must print 0 rejected
python harness/uplift/robustness.py --conf=60
python harness/uplift/final_matrix.py --tag=_c60          # THE table
python harness/uplift/build_workbook.py
```

The two SELECT-only experiments behind the round-2 decision, neither of which
reads the verdict window:

```bash
python harness/uplift/exp_price_members.py    # E16
python harness/uplift/exp_nested_rules.py     # E17 / E18
python harness/uplift/compare_runs.py --a= --b=_c60
```

`OPTIMISATION_ROUND2.md` is the write-up: what was adopted, what was rejected,
and the two adoption criteria that were written down before their numbers
existed.

`data/` and `cache/` are git-ignored: a few hundred megabytes, rebuildable in
about fifteen minutes plus the Odds API pulls.

## Credentials

`harness/.env` only, never committed:

```
HARNESS_DATABASE_URL=postgresql://harness_readonly...   # SELECT only
ODDS_API_KEY=...                                        # historical endpoint
```

## What each market's verdict rests on

`reports/final.csv` is the summary; `reports/boards.csv` has the six boards per
market; `reports/attribution.csv` is the before/after on the feature set;
`reports/improve_log_lag0_best.csv` has every attempt that was made, including
the ones that failed.
