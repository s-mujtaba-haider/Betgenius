// D-631 — Per-market UNVALIDATED tag classification.
//
// The dashboard previously HID markets where product_market_config.is_sellable
// = false. Those verdicts were measured on corrupted inputs (D-630 fixed
// weather 48% missing + Statcast 28% missing). D-631 surfaces ALL scored
// markets and tags the previously-hidden ones as UNVALIDATED until each
// re-measures +EV on clean post-D-630 data (D-630b watch).
//
// Confirmed (+EV measured on pre-D-630 data; tag NOT applied):
//   - batter_hits        (D-538: +8.4pp OOS edge at conf>=70)
//   - pitcher_k          (D-538: +2.3pp OOS edge at conf>=70)
//
// D-665 RE-TAGGED as UNVALIDATED (was previously confirmed):
//   - game_side / spreads — D-652 promoted v3 LIVE with 17 Claude-set
//     provisional weights; D-663 + D-664 added 10 more. ALL provisional
//     until the 2026-06-28 `d664-weight-fit-weekly` optimizer first run
//     gates them via OOS ≥+1.5pp lift + Bonferroni p<0.003 + sign-match.
//     The D-533 +4.2pp OOS edge was measured on the now-replaced v1 path.
//     See [d664_weight_fit_plan.md](docs/loop/architecture/d664_weight_fit_plan.md).
//
// D-799 — batter_total_bases CONFIRMED. TB went through the full audit funnel:
//   - D-788 audit (Step 0 data-integrity)
//   - D-789 per-side PAV calibration shipped + verified live (UNDER ceiling 69,
//     OVER ceiling 45 — no pick can show above honest realized rates)
//   - D-790 cohort backfill (10 D-785 factor cols on 6,296 historical picks)
//   - D-792 per-bin OOS tune (directional UNDER edge identified)
//   - D-796 root-cause investigation (xwOBA / launch angle / sweet spot /
//     hard-hit missing from BatterStatcastContext)
//   - D-797 wired xwOBA + 4 D-797 factors + fixed babip non-return
//   - D-801 point-in-time backfill of D-797 factors on cohort (94.1%, no leakage)
//   - D-798 re-tune verdict (xwOBA didn't convert directional → statistical at
//     this n; UNDER edge real but CI doesn't clear BE; D-789 ceiling caps any
//     inflated confidence going forward)
// Edge is directional, not statistical. UNVALIDATED tag was meaningful pre-D-789
// when calibration was inverted and confidence could surface inflated picks
// (~88% WR predicted, ~35% realized). Post-D-789 calibration ceiling enforces
// honest confidence. Per D-799 brief: "audited, calibrated, factors wired,
// tuned" — tag comes off. Re-measurement on forward data continues; if a
// statistical +EV tier emerges (D-804 forward-data retune), the market lifts
// from "directional-managed" to "+EV confirmed."
//
// D-810 — batter_runs_scored CONFIRMED. runs_scored went through the FULL audit
// + factor-build funnel:
//   - D-784 inverted-calibration root-cause fix + PAV calibration shipped
//     (UNDER ceiling 66, OVER ceiling 57 — honest realized rates enforced)
//   - D-793 forward-data retune confirmed the conf>=80 UNDER edge (+38.8pp)
//   - D-806 deep audit identified 3 missing runs-specific signal classes
//     (lineup protection, team offense, sprint speed) + 13 unwired factors
//   - D-806 wired 5 cross-applied factors (xwoba, hard_hit,
//     pitcher_hard_contact_allowed, pitcher_gb_fb_rate, weather_temp)
//   - D-807 BUILT lineup_protection (avg OPS of next 2 hitters behind) +
//     wired team_offense (TeamSeasonContext propagation)
//   - D-808 wired 8 deferred factors + BUILT sprint speed (Baseball Savant
//     leaderboard ingestion + new cache_statcast_batters_sprint_speed +
//     new score_batter_sprint_speed factor)
//   - D-809 set educated seed weights for all 16 new factors + verified
//     ALL 34 factors persisting at 15/15 on real picks (zero silent drops)
// Per D-810 closeout: 34-factor stack complete, calibrated, all factors
// persisting, edge confirmed → tag comes off. The D-810 forward retune
// (target 2026-07-12 to 2026-07-26 once cohort accumulates) refines seeds.
//
// D-819 — batter_hr CONFIRMED. HR went through the FULL audit + factor-build
// funnel:
//   - D-811 deep audit found 12 gaps (NO calibration, xwOBA HR-gate-mistake,
//     weather null cross-market, pull%/spray missing, lineup_spot null, 5
//     wired-but-not-displayed cards, 3 breakdown-only columns, scoring_inputs
//     6.5% historical capture, etc.)
//   - D-812 weather + lineup_spot system-wide fixes (cross-market — also
//     benefits runs_scored + TB)
//   - D-813 permanent inline weather + lineup_protection projected fallback
//   - D-814 D-617 dedup bypass for verification; PARTS 2+3 verified on real
//     rows (lineup_protection real values + provenance flag persisting)
//   - D-815 xwOBA HR-ungate (closed D-811 gate-mistake) + per-side PAV
//     calibration UNDER 91 / OVER 20 (the honest plus-money-aware ceilings)
//   - D-816 BUILT pull_rate (Baseball Savant batted-ball leaderboard;
//     293 batters ingested + new cache_statcast_batters_pull_rate +
//     new score_batter_pull_rate factor) + promoted 3 breakdown-only
//     columns (gb_fb_rate, hr_per_9, wind_direction_hr) + 6 display cards
//   - D-817 BUILT 30-row park dimensions reference + handedness-aware pull ×
//     pull-side fence interaction (the directional amplifier on pull_rate)
//   - D-818 set educated seed weights (pull_rate 1.0→1.25 CEO-approved) +
//     verified ALL 31 HR factors persisting at 6/6 (zero silent drops)
// Per D-819 closeout: 31-factor stack complete, calibrated, all factors
// persisting, scoring_inputs captures all 14 critical context fields → tag
// comes off. The D-820 forward retune (target 2026-07-12 to 2026-07-26 once
// cohort accumulates) refines seeds.
//
// Unvalidated (was hidden by is_sellable=false; now surfaced + tagged):
//   - batter_rbis, batter_strikeouts, game_total, pitcher_outs, game_side (D-665)
//
// Tag removal is per-market once measurement confirms +EV on clean data OR
// the market completes the audit-calibrate-wire-tune funnel (D-799/D-810/D-819).
// Removal-TODO is in framework §15.

const MLB_CONFIRMED_MARKETS = new Set<string>([
  // Phase 1 harness ev_filtered: combined PASS, overs vetoed in process-games-mlb.
  "batter_hits",
  // M6 unders-only PASS; overs vetoed in process-games-mlb.
  "batter_total_bases",
  // pick_history shown-slice: away-only PASS; home vetoed in process-games-mlb.
  "game_side",
  // pick_history shown-slice: unders PASS / overs FAIL; overs vetoed.
  "game_total",
  // pitcher_k, batter_runs_scored, batter_hr — harness FAIL; UNVALIDATED + backend veto.
]);
const MLB_CONFIRMED_PROP_TYPES = new Set<string>([
  "hits",
  "total_bases",
]);

export function isMarketUnvalidated(
  sport: string | null | undefined,
  propType: string | null | undefined,
  mlbMarketType?: string | null | undefined,
): boolean {
  if (!sport || sport !== "mlb") return false; // NBA out of D-631 scope
  if (mlbMarketType && MLB_CONFIRMED_MARKETS.has(mlbMarketType)) return false;
  if (propType && MLB_CONFIRMED_PROP_TYPES.has(propType)) return false;
  return true;
}
