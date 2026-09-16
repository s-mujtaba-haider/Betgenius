# Phase 1 — MLB End-to-End: scope and starting state

**Date:** 2026-08-30
**Branch:** `phase1-mlb`
**Prior harness work:** [MILESTONE2](MILESTONE2.md) · [MILESTONE3](MILESTONE3.md) · [MILESTONE4](MILESTONE4.md) · [MILESTONE5](MILESTONE5.md) · [MILESTONE6](MILESTONE6.md)

This document records what is already validated, what is not, and what Phase 1
has to close. Everything below is read from the live database or the repo —
nothing is carried over on trust. Phase 1 is **not** complete.

---

## 0. Environment verified

| Check | Result |
|---|---|
| `harness_readonly` login (rotated password) | OK |
| `SELECT cache_statcast_pitcher_arsenal` | granted — 9,222 rows |
| `SELECT cache_mlb_pitcher_season_stats` | granted — 195 rows |
| `SELECT pick_history` | granted (was a Phase 1 prerequisite in the harness README) |
| `SELECT cache_mlb_historical_outcomes` | **DENIED** — see Blockers |
| `SELECT cache_mlb_historical_bullpen` | **DENIED** — see Blockers |
| `rolconnlimit` | **10** (the project owner asked 20; do not `ALTER ROLE`) — sequential Deno only |
| `rolbypassrls` | true |
| Harness smoke tests | **141 passed, 0 failed** (game CLI `--market=h2h\|spreads\|totals` registered) |
| Live warehouse backtest | runs end to end (`batter_hits` Statcast-aware; TLS via `DENO_CERT`) |

**TLS note:** Deno needs the Supabase root cert or every connection fails with
"certificate is invalid". Fetch it once and export `DENO_CERT`:

```bash
curl -o prod-ca-2021.crt https://supabase-downloads.s3.amazonaws.com/prod/ssl/prod-ca-2021.crt
export DENO_CERT="$PWD/prod-ca-2021.crt"   # PowerShell: $env:DENO_CERT
```

The cert is public and git-ignored, not vendored.

---

## Blockers — needs the project owner (GRANT paste)

Statcast tables are already granted. `rolconnlimit` stays **10** — do not `ALTER ROLE`.
Paste in the Supabase SQL editor (table owner / superuser). No password in this
file; none should be pasted in chat.

```sql
GRANT SELECT ON TABLE cache_mlb_historical_outcomes TO harness_readonly;
GRANT SELECT ON TABLE cache_mlb_historical_bullpen TO harness_readonly;
```

| Blocker | Why it matters | Status |
|---|---|---|
| `cache_mlb_historical_outcomes` SELECT | Game-market warehouse grading/context. Live totals `--limit=5` loaded odds then scored **0** without this grant. Harness falls back to boxscore grading. | **DENIED** (probe 2026-08-30; also in `out/phase1_pitcher_outs_inventory.json`) |
| `cache_mlb_historical_bullpen` SELECT | PIT / bullpen as-of context for game sides & totals. Without it, game context degrades to league-avg. | **DENIED** (same probe) |
| `recommendations_cache` SELECT | Cannot verify dashboard surface from the harness | still missing (Gap C) |
| Deploy `process-games-mlb` + frontend | Local veto + confirmed-set are not live. This machine is logged into the wrong Supabase project. | local only |
| `pitcher_outs` `warehouseOddsAvailable` | Warehouse rows exist (26,055 / 2,699 events / 2024-04-02 → 2025-05-28) but **do not flip the flag** and **do not run** a warehouse outs backtest until a dedicated gate. No 2026 warehouse window. | flag stays `false` |

After both game-table grants: one sequential `deno` game-market warehouse run
(`--market=h2h` then `spreads` then `totals`). Do not start a second `run_backtest`.

**Partial workaround for the bullpen grant (2026-09-16).** `cache_mlb_historical_bullpen`
is still DENIED, but the information in it is not only there: every relief
appearance is also a row of the box score, which `harness_readonly` can read. The
pen's as-of runs per out, K and BB per batter faced and innings per game are
rebuilt from those rows in `harness/uplift/features.bullpen`, and the same file
rebuilds the starter's pitch budget and pitches per out from `pitches_thrown`.
That is what took `pitcher_outs` and `totals` across the gate in
`MLB_PHASE1_RESULTS.md`. It does **not** replace the grant for the live path:
what a moneyline needs is which arms are *available tonight*, and that is not
recoverable from what the pen has already thrown.

---

## 1. Player prop markets — already gated (M3–M6)

Seven player-prop markets are wired into the harness and have been run through
the `ev_filtered` gate. Restating their verdicts so Phase 1 does not repeat them:

| Market | Source | Graded n | ROI | Gate | Production today |
|---|---|---:|---:|---|---|
| `batter_hits` | warehouse Apr 25–May 24, Statcast as-of | **1,127** | **+7.10%** | **PASS** combined / **FAIL overs** (−2.01% n=398) / **PASS unders** (+12.07% n=729) | unders-only side policy (local; deploy pending) |
| `batter_total_bases` | warehouse | 4,012 | −2.70% | FAIL all / **PASS unders-only** (+4.42% in-sample n=1,052, +5.27% OOS n=515) | unders-only side policy (local; deploy pending) |
| `batter_runs_scored` | pick_history | 462 | +5.50% | FAIL (CI lower −1.50%, n<500) | vetoed in `mlbRecommendationShown` |
| `batter_rbis` | warehouse | 310 | −9.28% | FAIL | vetoed in `mlbRecommendationShown` |
| `batter_home_runs` (`batter_hr`) | warehouse | 5 | n/a | FAIL (no volume) | vetoed in `mlbRecommendationShown` |
| `pitcher_strikeouts` (`pitcher_k`) | warehouse | 81 | −5.38% | FAIL | vetoed in `mlbRecommendationShown` |
| `pitcher_outs` | pick_history | 62 | −25.34% | FAIL | vetoed in `mlbRecommendationShown` |

**Gate:** `ev_filtered` graded n ≥ 500 and ROI > 0%, else ROI 95% CI lower
bound > 0%.

**Statcast on hits:** as-of hit 1,250 / 7,669 scored (16.3%). Snapshots start
~2026-05-20, so only the tail of this window is covered. Artifact
`out/batter_hits_2026-04-25_to_2026-05-24.json` (generated 2026-08-30) **replaces**
the stale M3/M4 +7.15% n=1,125 (Statcast count was 0). The 7.15→7.10 move is
**not** evidence that Statcast adds no signal — the comparison is diluted by
the uncovered majority of the window.

---

## 1b. FAIL / vetoed markets — exact cause + lever

the project owner bullet 9. Numbers from existing M3–M6 / Phase 1 artifacts only — no
new 12h backtests. Cause class is one of **data / juice / side / n / model**
(primary first). `mlb_ev_policy.ts` already applies the listed veto or side
filter locally; **not deployed**.

| Market | Gate | n / ROI | Primary cause | Exact cause | Practical lever |
|---|---|---|---|---|---|
| `batter_hits` **overs** | **FAIL** | ev_filtered n=398, **−2.01%** (CI lo −10.05%). Combined still **PASS** +7.10% n=1,127; unders **PASS** +12.07% n=729 | **side** (juice secondary) | Overs lose after vig even on the EV-filtered surface. Unfiltered `all/over` was already −5.50% at ~60% WR (M3 false-edge). n=398 also misses n≥500. | Unders-only already in `MLB_EV_SIDE_POLICY`. Do not refit. Deploy pending. |
| `batter_total_bases` **combined** | **FAIL** | ev_filtered n=4,012, **−2.70%** (CI entirely ≤0: [−5.42%, −0.07%]) | **side** | Overs n=2,960 **−5.23%** drown unders n=1,052 **+4.42%**. Not an n problem. | Keep unders-only policy. Do not surface combined. Do not refit. |
| `batter_total_bases` **unders policy** | **PASS** (warehouse) | in-sample n=1,052 **+4.42%**; OOS May 11–24 n=515 **+5.27%** | — (this slice wins) | M6 Poisson vs D-789 isotonic kept the under edge. λ/shrink sweep was inconclusive (quick n=14); default retained. | Code ready (`MLB_EV_SIDE_POLICY.batter_total_bases = "under"`). CEO/deploy still pending. No weight refit. |
| `batter_total_bases` **lifetime replay** | **FAIL_roi** | pick_history after unders policy n=3,053, **−1.45%** (`out/phase1_pick_history_policy_replay.json`) | **model / juice** (not a warehouse unders falsification) | Lifetime production surface (no `ev_per_unit` on pick_history, so EV floor not applied) vs M6 Apr–May warehouse window. Different scorer/window, not the M6 OOS holdout. | Keep M6 warehouse unders policy. Do not treat this FAIL as a reason to drop unders or to refit. |
| `batter_hr` (`batter_home_runs`) | **FAIL** | ev_filtered n=**5** (ROI +195% not meaningful; CI lo −100%) | **n** (data/price drives the n) | 21,999 candidate groups → 20,178 excluded `no_entry_price_for_agreeing_side` → 25 scored → 5 ev_filtered. Poisson HR is a rare-event pilot. Unders n=0 in the slice. | Whole-market veto already in `MLB_EV_VETO_MARKETS`. Do not refit. Volume is the blocker, not a juiced-but-measured edge. |
| `batter_rbis` | **FAIL** | ev_filtered n=310, **−9.28%** (CI [−20.61%, +2.33%]) | **model** (n secondary) | Both sides negative in ev_filtered (over **−16.47%**, under **−4.08%**). n<500 would fail anyway; ROI is not a near-miss. | Whole-market veto applied. Do not refit. |
| `batter_runs_scored` | **FAIL** (marginal) | pick_history n=462, **+5.50%** (CI lo **−1.50%**) | **n** | ROI is positive but n<500 and CI lower bound ≤0. All ev_filtered picks are **under** (over n=0). Not a proven minus-EV market — the gate cannot clear. | Whole-market veto (conservative; not a side policy). Do not refit until ev_filtered n≥500 with CI>0. |
| `pitcher_k` (`pitcher_strikeouts`) | **FAIL** | ev_filtered n=81, **−5.38%** (CI lo −25.09%). Overs n=39 **+8.26%** FAIL(n); unders **−18.05%** | **n** + **juice** | Unfiltered WR 65.9% with ROI −3.81% and `falseEdgeFlag` — vig eats the hit rate. Apr–May overs edge does **not** survive the full-window quick sample (n=5, −7.97%). | Whole-market veto applied. Do not promote an overs-only side gate. Do not refit. Warehouse window exists; no new 13h run this turn. |
| `pitcher_outs` | **FAIL** | pick_history n=62, **−25.34%** (CI entirely negative: [−48.19%, −1.84%]). Over n=5 −66.21% / under n=57 −21.75% | **model** (n secondary) | Both sides fail. Poisson still beats D-780 isotonic on this slice; neither clears. Gate window Jun 13–Jul 8 (inventory is 1,572 pick_history rows through 2026-08-30). Context-build failures present on re-score. | Whole-market veto applied. **Do not flip** `warehouseOddsAvailable`. **Do not run** warehouse outs backtest. Warehouse 26,055 rows exist but end 2025-05-28 (no 2026). Do not refit. |
| `game_total` **overs** | **FAIL** (shown-slice) | pre-policy shown n=915, **−4.9%**. Combined n=1,915 **−1.25% FAIL**; unders n=1,000 **+2.1%** / policy-replay unders n=965 **+2.06% PASS** | **side** | Overs bleed; unders carry a small plus. Warehouse game gate **not run** (outcomes/bullpen GRANT missing; `--limit=5` scored 0). | Unders-only already in `MLB_EV_SIDE_POLICY.game_total`. Deploy pending. Need grants before warehouse confirm. Do not refit. |
| `game_side` **home** | **FAIL** on home (combined barely PASS) | pre-policy home n=1,421, **−2.9%**. Combined n=2,775 **+0.58%**; away n=1,354 **+4.22% PASS** (policy replay) | **side** | Home loses; away is the edge. Same warehouse-grant block as totals. | Away-only already in `MLB_EV_SIDE_POLICY.game_side`. Deploy pending. Need grants before warehouse confirm. Do not refit. |

HR / RBI / runs / K / outs: **0 shown** after current veto on the 2026-08-30
pick_history policy replay (graded 116,763 → after policy 5,872).

**Do not refit scoring weights** without the project owner GO (cardinal rule). The lever
on every FAIL row above is veto / side-policy / grant / wait-for-n — not a
weight change.

---

## 2. Gap A — game-market warehouse gate still open

the project owner's Phase 0 question was specifically about **sides and totals, regular
bets**. `h2h` / `spreads` / `totals` are now registered in
`harness/lib/market_config.ts` (CLI `--market=h2h|spreads|totals`). Pick_history
side-policy replay is done (away / under PASS — see §1b). The **full-window
warehouse** run has **not** started: `harness_readonly` is DENIED on
`cache_mlb_historical_outcomes` and `cache_mlb_historical_bullpen` (live
`--limit=5` totals loaded odds then scored 0; boxscore fallback exists).

They are not absent from the data, and they are not absent from production.

### Warehouse coverage (`cache_mlb_historical_odds`)

| `market_key` | Rows | Events | Window |
|---|---:|---:|---|
| `h2h__home` | 272,623 | 7,440 | 2023-05-03 → 2026-05-24 |
| `h2h__away` | 272,623 | 7,440 | 2023-05-03 → 2026-05-24 |
| `totals` | 268,249 | 7,440 | 2023-05-03 → 2026-05-24 |
| `spreads__home` | 259,663 | 7,440 | 2023-05-03 → 2026-05-24 |
| `spreads__away` | 259,663 | 7,440 | 2023-05-03 → 2026-05-24 |

### Production picks already firing (`pick_history`, MLB)

| `prop_type` | Picks | Graded | Window |
|---|---:|---:|---|
| `totals` | 5,519 | 5,141 | 2026-05-18 → 2026-08-29 |
| `spreads` | 4,691 | 4,401 | 2026-05-18 → 2026-08-29 |
| `h2h` | 2,602 | 2,504 | 2026-05-18 → 2026-08-29 |
| `game_total` | 810 | 770 | — |
| `game_side` | 777 | 769 | — |

**pick_history policy replay** (`harness/scripts/gate_shown_replay.ts` → `out/phase1_pick_history_policy_replay.json`, 2026-08-30): graded 116,763 rows through current veto + side policy (no `ev_per_unit` on pick_history). After policy n=5,872:

| Market | n | ROI | Verdict |
|---|---:|---:|---|
| `game_side` (away) | 1,354 | **+4.22%** | **PASS** |
| `game_total` (under) | 965 | **+2.06%** | **PASS** |
| `batter_hits` (under) | 500 | **+2.07%** | **PASS** |
| `batter_total_bases` (under) | 3,053 | −1.45% | FAIL_roi — keep M6 warehouse unders policy; this is lifetime production, not the M6 window |

HR / RBI / runs / K / outs: 0 shown after veto.

**Older shown-slice (pre-policy, `recommendation_shown=true`):**

| `mlb_market_type` | Shown n | ROI | Gate | Lever |
|---|---:|---:|---|---|
| `game_side` | 2,775 | **+0.58%** | **PASS** combined; away +4.2% n=1,354 / home −2.9% n=1,421 | away-only side policy (local) |
| `game_total` | 1,915 | −1.25% | FAIL combined; under +2.1% n=1,000 / over −4.9% n=915 | unders-only side policy (local) |

This is the live confidence≥60 surface, not a warehouse re-score. Warehouse
game-market **code** landed; full-window run is blocked on the two SELECT grants.

### Encoding notes for the loader

Game markets are stored differently from player props:

- Side is baked into `market_key`, not into a row field:
  `h2h__home` / `h2h__away`, `spreads__home` / `spreads__away`.
- For those, the price lives in `over_odds`; `under_odds` is `NULL`.
- `h2h` rows carry `line = 0`. `spreads` rows carry the actual spread
  (`±1.5`). `totals` carries the total and uses **both** `over_odds` and
  `under_odds`.
- `player_name` is empty for all game markets.

### Grading source

`cache_mlb_historical_events` holds event metadata and `game_pk` only — **no
final scores**. So warehouse-mode grading for game markets needs team runs
derived from `cache_mlb_boxscore_player_stats`, or the run must go through
`pick_history` mode where production has already graded `hit`.

**Recommended path:** pick_history gate is done (see §1b). Warehouse mode is
the remaining confirm — three-season window plus outcomes/bullpen context —
and is **blocked on the two SELECT grants**.

---

## 3. Gap B — local veto is done; live surface is not

the project owner's requirement: *"no dead/mediocre market left running. Anything that
can't win is either removed or veto-filtered so it never bleeds money live."*

**Local (this branch, not deployed):**

- `mlb_ev_policy.ts`: whole-market veto HR / RBI / runs / Ks / outs; side policy
  hits under, TB under, game_total under, game_side away.
- `process-games-mlb` imports `mlbRecommendationShown()` on batter, pitcher,
  and game writes (juice + conf; game results still have no `evPerUnit`).
- `marketValidation.ts` confirmed set is now:

```ts
const MLB_CONFIRMED_MARKETS = new Set<string>([
  "batter_hits",
  "batter_total_bases",
  "game_side",
  "game_total",
]);
```

`pitcher_k`, `batter_hr`, and `batter_runs_scored` are **no longer** confirmed
(UNVALIDATED + backend veto). This machine is logged into the wrong Supabase
project — **do not deploy from here**.

**Still true until deploy:** production continues to show FAIL markets and
unfiltered game sides/overs on the live dashboard.

---

## 4. Gap C — data limits that cap what the gate can prove

| Limit | Effect | Status |
|---|---|---|
| Warehouse odds end **2026-05-24** | No warehouse backtest on Jun–Aug 2026; OOS windows must come from 2025 or from `pick_history` | confirmed by query |
| **One snapshot per event** across all 2026 markets (`h2h__home`, `spreads__home`, `totals`, `batter_hits` all avg 1.00) | Harness CLV is structurally 0% for 2026 windows; only the 2025 window has multi-snapshot depth | confirmed by query |
| `recommendations_cache` not readable by `harness_readonly` | Cannot verify dashboard surface from the harness; production surface has to be read from code | needs a grant to close |
| `pitcher_outs` warehouse **confirmed 2026-08-30** | `cache_mlb_historical_odds` `market_key='pitcher_outs'`: **26,055 rows**, 2,699 events, **2024-04-02 → 2025-05-28**. pick_history: 1,572 rows 2026-06-13 → 2026-08-30. `market_config` still `warehouseOddsAvailable: false` / pick_history-only (M5 had 0 rows). **Do not flip the flag** until a warehouse gate runs. Warehouse outs stop May 2025 — no 2026 warehouse window. Artifact: `out/phase1_pitcher_outs_inventory.json` | inventory done; warehouse re-gate still open |
| `harness_readonly` missing SELECT on `cache_mlb_historical_outcomes` and `cache_mlb_historical_bullpen` | Game-market warehouse **does not wait** on these grants: team RPG/L10 + final scores use `cache_mlb_boxscore_player_stats` (SELECT ok). Bullpen + H2H stay null until GRANTed. Gate is still honest (leak-safe) but not full PIT parity with production. | confirmed probe 2026-08-30; boxscore fallback 2026-08-30 |

---

## 5. Phase 1 work plan

Ordered by value, one market at a time, sequential runs because the connection
limit is 10.

1. **Register game markets in the harness** — `h2h`, `spreads`, `totals` in
   `market_config.ts`, a candidate loader that understands the
   `__home` / `__away` key split, leak-safe game context, and
   `cache_mlb_historical_outcomes` grading. **Code landed** (2026-08-30).
   CLI: `--market=h2h|spreads|totals`. Gate slice is **ev_pass** (production
   game write has no `evPerUnit`). Full-window warehouse run still open;
   pick_history gate already exists via `gate_shown_replay.ts`.
2. **Gate each game market on `pick_history`** — shown-slice + policy replay
   **done** (away / under PASS; home / over FAIL — §1b). Warehouse confirm still
   blocked on grants.
3. **Put game markets behind the EV gate** — replace the bare
   `confidence >= 60` on the game write path with `mlbRecommendationShown()`
   so losers cannot surface. **Local code done** (juice + conf; no `evPerUnit` on game results yet). Deploy pending.
4. **Reconcile `marketValidation.ts` with gate verdicts** — the frontend
   confirmed-set must match what actually passed. **Local code done**
   (hits, TB, game_side, game_total). Deploy pending.
5. **Veto-filter the failed player props** — HR, RBI, K, outs, runs_scored,
   and TB overs. **Local code done.** Deploy pending.
6. **Re-check `pitcher_outs` warehouse mode** — inventory **done** (26,055 warehouse rows, 2024-04-02 → 2025-05-28). Config still pick_history-only. Do not enable warehouse mode until a gated backtest. No 2026 warehouse coverage.
7. **Extend warehouse game-market backtest** — blocked on the two SELECT grants.
   After grants: sequential `--market=h2h` then `spreads` then `totals`. One
   Deno process. Boxscore fallback exists if outcomes stay denied.
8. **Verify end to end on the live dashboard** — pick generated → EV and
   confidence → displayed. **Not done.**

Each step lands on `phase1-mlb` as its own commit with the artifact that backs
it.

---

## 6. Reproduce

```bash
cd betgenius
export DENO_CERT="$PWD/prod-ca-2021.crt"

# offline
deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts

# live (sequential — connection limit 10)
deno run --no-check --allow-net --allow-env --allow-read --allow-write \
  harness/run_backtest.ts --market=batter_hits --limit=50
```

Market inventory queries behind sections 2–4: [`scripts/phase1_market_inventory.py`](scripts/phase1_market_inventory.py).
