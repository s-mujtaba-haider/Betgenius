# SharpAI — MLB Beta Build Specification

**Version:** 1.0 (draft for D-203)
**Author:** Claude (CTO) under CEO §19.3 authorization
**Status:** SPEC ONLY — no code shipped from this document. Batch 3+ tasks will execute against this spec.
**Reference docs:** `/docs/sharpai_architecture.md` §13.2 (MLB Beta posture), CEO §14 Q6 decision (D-192-A.1), framework §15.1 C20
**Build target:** Aug 1, 2026 closed-beta launch (per §14 Q7 Path C)

---

## 1. Scope summary

Seven MLB markets at Beta launch, mirroring NBA's `process-games` + `_shared/scoring.ts` architecture with MLB-specific factor weights calibrated against MLB-specific data sources. Tier-aware scoring (D-198/D-201) and Kelly-first product framing (D-202) inherited from Day 1 — MLB picks land in `pick_history` with `sport='mlb'`, automatically get tier-modifier treatment, and surface in the Kelly-first UI.

Sanity flags from Day 1: `coin_flip_flag`, `negative_stacking_flag`, `unbettable_juice_flag`, `is_secondary_market` — adapted with MLB-specific thresholds (see §5).

## 2. Current state — existing `process-games-mlb` (v0, dormant)

Per D-120 (May 11, 2026):
- `supabase/functions/process-games-mlb/index.ts` exists at 701 LoC, dormant
- v0 covers ONLY pitcher_strikeouts, manual-trigger only, no cron
- Reuses `_shared/error_handling`, `_shared/notify`, `_shared/sentry` (NOT `_shared/scoring.ts` — MLB has its own scoring inlined)
- Uses MLB Stats API + BDL Baseball (free tier)
- Same hot-streak failure mode as pre-megadeploy NBA per framework §15.1 C20 — needs rebuild

**v1 Beta requires:** rebuild scoring math, add 6 more markets, wire to Tier-Aware Scoring, populate sanity flags, add cron, add resolution, add calibration tracking.

## 3. Build sequence (priority-ordered)

Per task spec rationale (clean-data + most-modeled first → rare-event last):

| Phase | Market | Notes |
| --- | --- | --- |
| 1 | **Pitcher strikeouts** | Cleanest data, most-modeled, v0 baseline exists. Replace v0 scoring math. |
| 2 | **Batter hits** | High volume, medium difficulty. Daily props on most starters. |
| 3 | **Game sides (run-line / moneyline)** | Team-level, different surface from player props. Shares game-context cache with §13.2. |
| 4 | **Game totals (O/U runs)** | Same data as game sides; one cron tick produces both. |
| 5 | **Batter HRs** | Rare event, hardest calibration. n required for Beta exit gate. |
| 6 | **Batter total bases** | Compound of hits + slugging; depends on Phase 2 + 5. |
| 7 | **Batter RBIs** | Highly contextual (lineup spot, runners on); most variance. |

## 4. Per-market specification

### 4.1 Pitcher strikeouts (Phase 1)

**Plain English:** predict whether a starting pitcher will record over/under N strikeouts in his start. Single most-modeled prop in baseball analytics.

**Data sources:**
- MLB Stats API `/v1/people/{id}/stats?stats=season&group=pitching` — season K, IP, K/9
- MLB Stats API `/v1/people/{id}/stats?stats=gameLog` — last 10 starts: K, IP, opposing team
- MLB Stats API `/v1/schedule?date=X&hydrate=probablePitcher` — today's starters (key prerequisite — if pitcher isn't today's starter, drop the prop)
- BDL Baseball `/v1/games` — game scores for resolution (cache_mlb_game_scoreboard)
- BDL Baseball `/v1/players` — player metadata (handedness, role)
- The Odds API `/v4/sports/baseball_mlb/odds` — market lines + odds

**Factors (12 — mirror NBA's scoreOneSide pattern):**

| Factor | NBA analog | MLB-specific notes |
| --- | --- | --- |
| `score_l5_k` | l5 hit rate | Last 5 starts hit-rate vs the line |
| `score_l10_k` | l10 hit rate | Last 10 starts |
| `score_season_k` | season hit rate | Season-long K count vs line |
| `score_floor_ceiling_k` | floor/ceiling | Min/max K in last 10 starts |
| `score_recent_form_k` | recent form | L5 K avg vs season K avg % delta |
| `score_opp_k_rate` | opp_defense | **Critical MLB factor**: opposing lineup season K% (right-handed vs left-handed splits if pitcher available) |
| `score_park_factor` | (new — no NBA analog) | Ballpark K factor — Coors Field deflates K rates ~7%; Petco inflates ~5% |
| `score_umpire_k` | (new) | Home plate umpire season K% (some umps have wider zones — adds 5-15% K rate variance) |
| `score_pitcher_rest` | rest_days | Days since last start. Sub-4 = "short rest" (rare; flag) |
| `score_pitcher_handedness_split` | home/away | LHP vs LHP-heavy lineups + vice versa |
| `score_weather_k` | (new) | Wind direction + temperature — wind in / hot weather depresses K rates |
| `score_velocity_trend` | minutes_volume | Last 3 starts avg velocity — degradation = K-rate decline signal |

**Sanity flags (MLB-specific thresholds):**
- `coin_flip_flag`: Elite confidence (≥80) + season K-rate ratio 0.95-1.05× line (essentially priced at expectation)
- `unbettable_juice_flag`: tier-tier breakeven thresholds same as NBA (Elite -350, Strong -300, Good -250, Lean -200)
- `negative_stacking_flag`: Elite + 3+ negative factor scores
- `is_secondary_market`: same player + game_date with multiple prop-type picks (e.g. pitcher K's + walks + outs) — primary = highest confidence
- **New MLB-specific**: `weather_red_flag` — wind 15+mph in, rain probability >40% — caps confidence at 75 (weather variance overwhelms model)

**Implementation lift:** ~6-8h. Replace v0 scoring, add 11 new factors, wire to upsert_pick_history with sport='mlb', cron schedule daily 17:00 UTC (peak betting time).

### 4.2 Batter hits (Phase 2)

**Plain English:** predict over/under N hits for a starting batter.

**Data sources:** same as 4.1 + MLB Stats API `/v1/people/{id}/stats?stats=season&group=hitting` for season AB, H, BA.

**Factors (10):**

| Factor | Description |
| --- | --- |
| score_l5_hits, score_l10_hits, score_season_hits | hit rate cascades |
| score_recent_form_hits | L5 hits/AB vs season |
| score_pitcher_matchup | Opposing starter's WHIP, hits/9 |
| score_pitcher_handedness | Batter's avg vs LHP/RHP split (batter's L/R/S) |
| score_park_factor_hits | Park hit factor (Coors +10%, Marlins Park -5%) |
| score_batting_order | 1-2-3 spot = ~4.5 PA expected; 8-9 = ~3.5 PA; affects projection |
| score_weather_hits | Wind out → fly-ball-hits boost (small); humid air → wOBA boost |
| score_pitcher_workload | Opposing starter season IP — high-IP signals fatigue late in season |

**Sanity flags:** same set as 4.1 with hit-specific thresholds.
**Lift:** ~5-6h.

### 4.3 Game sides — run-line / moneyline (Phase 3)

**Plain English:** team A wins / covers a 1.5-run line.

**Data sources:**
- MLB Stats API `/v1/schedule?date=X` — team records + win-pct
- BDL Baseball `/v1/teams/{id}/stats?season=YYYY` — team season run differential, OBP, OPS, pitching ERA
- The Odds API — game-level run-line + moneyline odds

**Factors (8 — game-level, not player-specific):**

| Factor | Description |
| --- | --- |
| score_team_wpct | Win% delta favored vs underdog |
| score_run_differential | Per-game run diff |
| score_recent_form_team | L10 win% |
| score_pitcher_matchup_game | Probable starter ERA delta |
| score_bullpen_quality | Bullpen ERA delta (matters in 1-run games) |
| score_home_advantage_game | Home win-pct boost (small in MLB — ~4%) |
| score_b2b_game | Day game after night game = degradation signal |
| score_park_factor_runs | High-run parks favor over on totals |

**Sanity flags:** subset of NBA's — `coin_flip_flag` (Elite + run diff < 0.5), `unbettable_juice_flag` (heavy-favorite money lines past tier breakeven).
**Lift:** ~6-8h. Game-level scoring is a different shape from player-prop scoring; shares cache layer.

### 4.4 Game totals (Phase 4)

**Plain English:** predict over/under total runs in a game.

**Data sources:** same as 4.3.

**Factors:** subset of 4.3 + weather + park factor heavily weighted. ~8 factors total.

**Lift:** ~4-5h (shares scaffolding with 4.3).

### 4.5 Batter HRs (Phase 5)

**Plain English:** predict whether batter hits ≥1 HR. Binary prop, very rare event.

**Data sources:** same as 4.2 + ISO power data.

**Factors:** 10 factors emphasizing power (ISO, HR%, exit velocity, barrel rate from Statcast if available — fallback to ISO).

**Beta caveat:** Rare-event prop — Beta exit gate needs n=200 picks resolved per market (vs 100 for hits) to confirm WR signal. Set explicit "Early Beta" badge until n hit.

**Lift:** ~6-8h.

### 4.6 Batter total bases (Phase 6)

**Plain English:** sum of bases reached (1B + 2×2B + 3×3B + 4×HR).

**Lift:** ~4h. Compound of hits + HR with similar factor set; mostly inherits Phase 2 + 5.

### 4.7 Batter RBIs (Phase 7)

**Plain English:** runs batted in.

**Highly contextual** — depends on (a) batter performance, (b) runners on base when batter comes up, (c) batting order spot. Hardest to model.

**Lift:** ~8-10h. Most variance in this set. Beta exit gate may take longer.

## 5. Shared infrastructure

### 5.1 New cache tables

```
cache_pitcher_game_logs        — per-pitcher last 10 starts (K, IP, opp)
cache_batter_season_stats      — per-batter season hitting (AB, H, HR, OBP, OPS, ISO, BA vs LHP/RHP)
cache_team_batting_stats       — per-team season hitting (K%, OBP, OPS)
cache_team_pitching_stats      — per-team bullpen + rotation ERA
cache_ballpark_factors         — static-ish (refreshed yearly) — K factor, hit factor, HR factor per park
cache_mlb_game_scoreboard      — per-game home/away teams + score + status (mirrors cache_game_scoreboard)
cache_umpire_stats             — home plate ump K% (BDL or external scraping; fallback to league avg)
cache_weather_at_game          — per-game weather (wind dir, speed, temp, precip) at game time
```

All tables: RLS read-public-to-authed, write service-role only. PK includes `snapshot_date` for daily refresh idempotency.

### 5.2 New cron jobs

```
fetch-mlb-pitcher-stats        daily 13:00 UTC — per-pitcher gameLog refresh
fetch-mlb-team-stats           daily 13:30 UTC — team-level batting + pitching stats
fetch-mlb-ballpark-factors     weekly Sunday 02:00 UTC (static-ish)
fetch-mlb-weather              hourly during peak betting (13:00-22:00 UTC) — only for today's games
fetch-mlb-umpires              daily 14:00 UTC — when lineups + umpire confirmed
process-games-mlb              daily 17:00 UTC — main scoring tick (after all caches populated)
fetch-odds-mlb                 every 15 min during betting window — props + game lines
resolve-picks-mlb              twice daily 14:00 UTC + 04:30 UTC — settles MLB picks
write-mlb-calibration-snapshot daily 11:15 UTC — sport-specific calibration tracking
```

### 5.3 Schema additions to `pick_history`

Per §1.17 audit discipline, ALL new column additions audit ALL writer paths:

```
-- MLB-specific factor score columns (NULLable; NBA picks stay NULL on these):
score_park_factor          INT
score_umpire_k             INT
score_pitcher_handedness   INT
score_weather_k            INT
score_velocity_trend       INT
score_pitcher_workload     INT
score_batting_order        INT
score_team_wpct            INT
score_run_differential     INT
score_pitcher_matchup_game INT
score_bullpen_quality      INT
score_home_advantage_game  INT
score_b2b_game             INT
score_park_factor_runs     INT
-- MLB-specific flags
weather_red_flag           BOOLEAN DEFAULT false
```

Each column ADD is a separate migration paired with §1.12 verification migration + RPC regen + writer-path audit. Estimated 14 migrations across the build sequence.

### 5.4 `_shared/scoring_mlb.ts` (new)

Separate module from `_shared/scoring.ts` (NBA canonical). Shape-similar but MLB-specific:
- `scoreMlbPitcherProp(...)` for K's
- `scoreMlbBatterProp(...)` for hits / HR / total bases / RBIs
- `scoreMlbGameProp(...)` for sides + totals
- `MlbScoringWeights` interface
- `loadMlbWeightsFromDB()`
- `MlbScoreOneSideHelpers` interface

**Critical:** `_shared/scoring_mlb.ts` will integrate with `applyTierAwareModifiers` from `_shared/scoring.ts` (Day-1 inheritance per D-198) — the tier-modifier table `algorithm_weights_tier_modifiers` is sport-agnostic; same Elite/Strong/Good/Lean/Pass tiers apply.

### 5.5 New table `algorithm_weights_mlb` 

Mirrors `algorithm_weights` but for MLB factors. Single-row config. Tunable via §19.3 manual UPDATE. Initial weights: gut-bucket 1.0 default per factor; tune from calibration data.

## 6. Inheritance from Batch 1 + 2 ships

| Feature | D-record | MLB inheritance |
| --- | --- | --- |
| Tier-Aware Scoring | D-198/D-201 | `algorithm_weights_tier_modifiers` is sport-agnostic; MLB scoring will call same `applyTierAwareModifiers()` |
| Kelly-first product framing | D-202 | MLB picks render in Kelly-first PickCard from Day 1 |
| `ai_verdict` structured column | D-199 | Sonnet AI analysis prompt extended for MLB context; verdict parsing same |
| Calibration snapshots | D-118 | `calibration_snapshots.sport='mlb'` filter; per-sport drift detection |
| §8.5 calibration-drift alerts | D-118 + §13.2 | MLB-specific thresholds (60% amber, 55% red) per §13.2 |
| §1.17 schema audit | Cardinal Rule | Every MLB column add audits writer paths |
| §1.12 verification migrations | Cardinal Rule | Paired with each schema change |

## 7. Beta calibration plan

### 7.1 Per-market Beta exit gate

Per market (one of 7), exit Beta when ALL hold:
- ≥60% rolling-30d 70+ WR for 14 consecutive days (per §13.2)
- n ≥ 100 picks resolved at 70+ tier (200 for rare events: HR, RBI)
- Zero open §8.5 calibration-drift alerts on that market for 14 days
- CEO §19.3 explicit promotion approval

### 7.2 "Early Beta" subscriber-facing badge

Until n=100 (200 for rare events) resolved at 70+ tier per market, subscribers see:
- `Beta · MLB Pitcher K's · Early Beta — calibrating (NN/100 resolved)`

After n hit + WR floor: `Beta · MLB Pitcher K's — calibrated (62% rolling-30d, n=NNN)`

### 7.3 Transparency

`/performance` page MLB tier-table includes per-market sub-tabs once Phase 2+ ships. Subscribers can drill into pitcher K's calibration vs batter hits calibration.

## 8. Risk register

| Risk | Mitigation |
| --- | --- |
| BDL Baseball free-tier rate limits | Same pacing discipline as BDL NBA (1100ms inter-call) + cron sequencing (refresh during off-peak hours) |
| MLB Stats API outages | Fallback to BDL Baseball where coverage overlaps; structured `logError` per Cardinal Rule §1.5 |
| Weather data vendor (TBD) | Decision-gate before Phase 1 ships — likely NOAA or OpenWeather; document in D-203-A |
| Umpire data sparse coverage | Fallback to league-avg K% when ump-specific row absent |
| Rare-event calibration (HR/RBI) slow to converge | Explicit "Early Beta" labeling per §7.2; honest sample-size display |
| Park factor data drift (renovations, fence moves) | Yearly refresh; manual CEO §19.3 update when stadiums modified |
| Lineup uncertainty (no probable batter list) | Skip prop if today's lineup not confirmed by game time; lower volume but higher confidence |
| Beta period overlap with NBA finals (May-June) | Off-season for MLB beta calibration — leverage; NBA cron schedule unchanged |

## 9. Build sequence summary

| Phase | Market | Estimated lift | Order |
| --- | --- | --- | --- |
| 1 | Pitcher K's (rebuild) | 6-8h | First — clean baseline |
| 2 | Batter hits | 5-6h | Second — high volume |
| 3 | Game sides | 6-8h | Third — different surface |
| 4 | Game totals | 4-5h | Fourth — shares with sides |
| 5 | Batter HRs | 6-8h | Fifth — rare event |
| 6 | Batter total bases | 4h | Sixth — compound |
| 7 | Batter RBIs | 8-10h | Seventh — highest variance |

**Total estimated build effort:** 39-49 hours of focused work + per-phase Beta calibration windows (4 weeks each from first cron tick to n-hit + WR-floor).

**Calendar target:** Phase 1+2+3 ship by July 1, 2026 (4 weeks calibration before Aug 1 launch). Phases 4-7 land during closed-beta window (Aug-Sep) ramping into public-launch on Oct 1.

## 10. Inputs needed from CEO before Batch 3 build kicks off

1. **Weather vendor decision** — NOAA (free, slower) vs OpenWeather ($10/mo, faster API). 5-min decision.
2. **Umpire data source confirmation** — BDL Baseball has it; verify free tier covers + falls back gracefully.
3. **Park factor refresh policy** — confirm yearly is enough or quarterly during stadium renovations.
4. **Beta exit gate threshold confirmation** — §13.2 sets 60% rolling-30d as AMBER; confirm or adjust per market.
5. **Subscriber-facing "Early Beta" copy approval** — final wording for the calibration-progress label.

---

## D-203 Beta build spec committed to repo

This document is the locked input for Batch 3 autonomous MLB Beta build. Per §1.16, future MLB ships reference §X.Y of this spec; per §1.12, every shipped phase pairs with a verification migration confirming 7-day calibration_snapshots data on the new market.

**Approval gate:** CEO §19.3 review of this spec before Batch 3 kickoff. The 10 inputs above (§10) close the spec into actionable.
