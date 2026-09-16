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
run_final.py       THE result: global filter, per-market side, gate
run_improve.py     the roadmap's per-market improvement loop + experiment log
robustness.py      placebo lag, price convention, refit schedule
diag_signal.py     does any signal survive the price being in the model?
build_workbook.py  the client workbook, built only from the report CSVs
```

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
python harness/uplift/run_final.py
python harness/uplift/robustness.py
python harness/uplift/build_workbook.py
```

`data/` and `cache/` are git-ignored: a few hundred megabytes, rebuildable in
about fifteen minutes plus the Odds API pulls.

## Credentials

`harness/.env` only, never committed:

```
HARNESS_DATABASE_URL=postgresql://harness_readonly...   # SELECT only
ODDS_API_KEY=...                                        # historical endpoint
```

## What each market's verdict rests on

`reports/final.csv` is the summary; `reports/boards.csv` has the four boards per
market; `reports/improve_log_lag0_best.csv` has every attempt that was made,
including the ones that failed.
