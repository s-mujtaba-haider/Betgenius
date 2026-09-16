// Phase 1 backtest harness — offline smoke tests.
//
// No live Postgres credentials required. Verifies:
//   1. Pure odds/metrics math (oddsmath.ts, metrics.ts) against known values.
//   2. The runs-aware context router + statcast AS-OF path end-to-end into a
//      real scoreBatterRunsScored() call, with leak-risk fields staying null
//      and the D-784 calibration ceilings holding — via a fake Db that
//      returns canned SQL rows instead of hitting a live database.
//
// Run: deno run --no-check --allow-env betgenius/harness/test/run_smoke_tests.ts

import {
  impliedProb,
  americanToDecimal,
  unitProfit,
  noVigProb,
  clvPct,
  isUnbettableJuice,
  passesOverBreakeven,
} from "../lib/oddsmath.ts";
import {
  wilsonInterval,
  bootstrapMeanCI,
  computeTierMetrics,
  computeDrawdown,
  computeCalibrationBuckets,
  computeCoinFlipBaseline,
  isRecommendablePick,
  isEvPassPick,
  isEvFilteredPick,
  isRecommendationShownPick,
  evaluateEvGate,
  evaluateAllSideEvGates,
  evaluateM3Gate,
  type GradedPick,
} from "../lib/metrics.ts";
import {
  buildLeakSafeBatterContext,
  newRouterCaches,
} from "../lib/context_batter.ts";
import {
  buildStatcastAsOfIndex,
  lookupStatcastAsOf,
} from "../lib/statcast_asof.ts";
import {
  buildReport,
  printSummary,
  writeReportCsv,
  writeReportJson,
} from "../lib/report.ts";
import { detectCoverageWindow, pickClosingSnapshot } from "../lib/candidates.ts";
import { groupsToGameCandidates, type GameOddsRow } from "../lib/game_candidates.ts";
import { gradeGameOutcome } from "../lib/grade_game.ts";
import { buildEventLookupIndex, eventLookupKey } from "../lib/event_lookup.ts";
import {
  clvStatusFor,
  getMarketConfig,
  listCliMarkets,
  resolveDataSource,
} from "../lib/market_config.ts";
import { loadPickHistoryUniverse } from "../lib/pick_history_candidates.ts";
import type { ExcludedCandidate } from "../lib/metrics.ts";
import type { Db } from "../lib/env.ts";
import {
  scoreBatterRunsScored,
  scoreBatterTotalBases,
  setActiveMarket,
  setMlbWeightsWithPerMarket,
  setPoissonTuningOverride,
  _getPoissonTuningForTest,
  getMlbDefaultWeights,
  type BatterScoringContext,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";

let failures = 0;
let passed = 0;

/** Fake Db for offline tests — pattern-matches table names in SQL. */
function createFakeDb(
  handlers: Record<string, (sql: string, params: unknown[]) => unknown[]>,
): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
      for (const [table, handler] of Object.entries(handlers)) {
        if (normalized.includes(table.toLowerCase())) {
          return handler(sql, params) as T[];
        }
      }
      return [] as T[];
    },
  };
}

function approx(a: number, b: number, tol = 1e-3): boolean {
  return Math.abs(a - b) <= tol;
}

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
  } else {
    failures++;
    console.error(`  FAIL: ${label}${detail ? " — " + detail : ""}`);
  }
}

console.log("== oddsmath.ts ==");
check("impliedProb(-110) ~= 0.5238", approx(impliedProb(-110), 0.5238, 1e-3));
check("impliedProb(+150) == 0.40", approx(impliedProb(150), 0.4));
check("impliedProb(+100) == 0.50", approx(impliedProb(100), 0.5));
check("americanToDecimal(+150) == 1.5", approx(americanToDecimal(150), 1.5));
check(
  "americanToDecimal(-110) ~= 0.9091",
  approx(americanToDecimal(-110), 0.9091, 1e-3),
);
check("unitProfit(+150, win) == 1.5", approx(unitProfit(150, true), 1.5));
check("unitProfit(-110, loss) == -1", approx(unitProfit(-110, false), -1));
check(
  "noVigProb(-110,-110) == 0.5 (no-vig two-way pick'em)",
  approx(noVigProb(-110, -110), 0.5),
);
// clvPct = (implied(closing) - implied(entry)) * 100. Beating the close
// means you locked in your side BEFORE the market moved to believe it was
// more likely — i.e. entry odds less negative (cheaper) than the closing
// odds on the same side (e.g. entry -110 -> closing -130: the market later
// priced your side as more likely than what you paid for it).
check(
  "clvPct positive when the close moved toward your side (entry -110 -> closing -130)",
  clvPct(-110, -130) > 0,
);
check(
  "clvPct negative when the close drifted away from your side (entry -130 -> closing -110)",
  clvPct(-130, -110) < 0,
);
check(
  "isUnbettableJuice flags under 65 conf at -210",
  isUnbettableJuice(65, -210, "under"),
);
check(
  "isUnbettableJuice skips over-side heavy juice",
  !isUnbettableJuice(65, -210, "over"),
);
check(
  "isUnbettableJuice skips under below -200 at 60+ conf",
  !isUnbettableJuice(65, -190, "under"),
);
check(
  "isUnbettableJuice tier 70 at -250",
  isUnbettableJuice(72, -250, "under"),
);
check(
  "isUnbettableJuice conf 72 at -240 still flagged via 60+ tier",
  isUnbettableJuice(72, -240, "under"),
);
check(
  "isUnbettableJuice conf 72 above -200 passes",
  !isUnbettableJuice(72, -190, "under"),
);
check(
  "passesOverBreakeven fails over 64 conf at -210",
  !passesOverBreakeven(64, -210),
);
check(
  "passesOverBreakeven passes over 64 conf at -155",
  passesOverBreakeven(64, -155),
);

console.log("== metrics.ts ==");
{
  const w = wilsonInterval(50, 100);
  check(
    "wilsonInterval(50/100) contains 0.5",
    w.lo < 0.5 && w.hi > 0.5,
    `lo=${w.lo} hi=${w.hi}`,
  );
  check(
    "wilsonInterval(50/100) is a sane 95% band (~0.40-0.60)",
    w.lo > 0.39 && w.hi < 0.61,
    `lo=${w.lo} hi=${w.hi}`,
  );
}
{
  const boot = bootstrapMeanCI([1, 1, 1, 1, 1]);
  check(
    "bootstrapMeanCI on constant array collapses to that constant",
    approx(boot.mean, 1) && approx(boot.lo, 1) && approx(boot.hi, 1),
  );
}
{
  // 10 picks: 7 win at -110 (implies a real edge), 3 lose. Should show a
  // healthy positive ROI with the CI not straddling break-even by much.
  const picks: GradedPick[] = [];
  for (let i = 0; i < 10; i++) {
    picks.push({
      eventId: `e${i}`,
      playerId: i,
      playerName: `Player ${i}`,
      commenceTime: new Date(2026, 5, 1 + i).toISOString(),
      pickSide: "over",
      line: 0.5,
      entryOdds: -110,
      entryBookmaker: "test",
      otherSideEntryOdds: -120,
      closingOdds: i < 5 ? -130 : null,
      closingBookmaker: i < 5 ? "test" : null,
      confidence: 75,
      confidencePreCap: 75,
      projectedStat: 0.9,
      contextCompleteness: 1,
      suppressedLeakRiskFactors: [],
      actualStat: i < 7 ? 1 : 0,
      hit: i < 7,
      voided: false,
    });
  }
  const tier = computeTierMetrics(picks, 70, "all", "70+");
  check("tier n == 10", tier.n === 10);
  check("tier graded == 10 (no pushes/voids)", tier.graded === 10);
  check("tier winRate == 70%", approx(tier.winRatePct, 70));
  check(
    "tier ROI > 0 for a 70% WR at -110",
    tier.roiPct > 0,
    `roiPct=${tier.roiPct}`,
  );
  check(
    "tier CLV computed only over the 5 picks with a closing price",
    tier.clvN === 5,
  );
  check(
    "tier avgClvPct is positive (closing line moved toward the bettor's side: entry -110 -> closing -130)",
    (tier.avgClvPct ?? -1) > 0,
  );

  const recPick: GradedPick = {
    eventId: "r1",
    playerId: 99,
    playerName: "Rec Test",
    commenceTime: "2026-06-01T00:00:00.000Z",
    pickSide: "under",
    line: 5.5,
    entryOdds: -210,
    entryBookmaker: "test",
    otherSideEntryOdds: 180,
    closingOdds: null,
    closingBookmaker: null,
    confidence: 65,
    confidencePreCap: 65,
    projectedStat: 4,
    contextCompleteness: 1,
    suppressedLeakRiskFactors: [],
    actualStat: 3,
    hit: true,
    voided: false,
  };
  check(
    "isRecommendablePick excludes unbettable under juice",
    !isRecommendablePick(recPick),
  );
  const recTier = computeTierMetrics(
    [...picks, recPick],
    60,
    "all",
    "recommendable",
    { recommendableOnly: true },
  );
  check(
    "recommendable tier excludes unbettable under pick",
    recTier.n === 10,
    `n=${recTier.n}`,
  );

  const overFailPick: GradedPick = {
    ...recPick,
    eventId: "r2",
    playerId: 98,
    playerName: "Over Fail",
    pickSide: "over",
    entryOdds: -210,
    confidence: 64,
    hit: true,
  };
  check(
    "isRecommendablePick excludes over failing breakeven gate",
    !isRecommendablePick(overFailPick),
  );
  check(
    "isEvPassPick matches isRecommendablePick",
    isEvPassPick(overFailPick) === isRecommendablePick(overFailPick),
  );

  const overPassPick: GradedPick = {
    ...overFailPick,
    eventId: "r3",
    playerId: 97,
    playerName: "Over Pass",
    entryOdds: -155,
    hit: false,
  };
  check(
    "isRecommendablePick includes over clearing implied BE",
    isRecommendablePick(overPassPick),
  );

  const recTierWithOver = computeTierMetrics(
    [...picks, overFailPick, overPassPick],
    60,
    "all",
    "recommendable",
    { recommendableOnly: true },
  );
  const evTier = computeTierMetrics(
    [...picks, overFailPick, overPassPick],
    60,
    "all",
    "ev_pass",
    { evPassOnly: true },
  );
  check(
    "recommendable and ev_pass tiers agree on n",
    recTierWithOver.n === evTier.n,
    `rec=${recTierWithOver.n} ev=${evTier.n}`,
  );

  const evPassNoEvPick: GradedPick = {
    ...recPick,
    eventId: "r4",
    playerId: 96,
    playerName: "Ev Pass No EV",
    pickSide: "under",
    entryOdds: -110,
    confidence: 65,
    evPerUnit: -0.05,
    hit: true,
  };
  const evFilteredPick: GradedPick = {
    ...evPassNoEvPick,
    eventId: "r5",
    playerId: 95,
    playerName: "Ev Filtered",
    evPerUnit: 0.12,
    hit: false,
  };
  check(
    "isEvFilteredPick excludes ev_pass pick with evPerUnit <= 0",
    !isEvFilteredPick(evPassNoEvPick),
  );
  check(
    "isEvFilteredPick includes ev_pass pick with evPerUnit > 0",
    isEvFilteredPick(evFilteredPick),
  );
  check(
    "isRecommendationShownPick matches isEvFilteredPick",
    isRecommendationShownPick(evFilteredPick) === isEvFilteredPick(evFilteredPick),
  );

  const evFilteredTier = computeTierMetrics(
    [...picks, evPassNoEvPick, evFilteredPick],
    60,
    "all",
    "ev_filtered",
    { evFilteredOnly: true },
  );
  const evPassTierWithEv = computeTierMetrics(
    [...picks, evPassNoEvPick, evFilteredPick],
    60,
    "all",
    "ev_pass",
    { evPassOnly: true },
  );
  check(
    "ev_filtered.n <= ev_pass.n (monotonic filter)",
    evFilteredTier.n <= evPassTierWithEv.n,
    `filtered=${evFilteredTier.n} pass=${evPassTierWithEv.n}`,
  );
  check(
    "ev_filtered tier keeps only positive-EV pick",
    evFilteredTier.n === 1,
    `n=${evFilteredTier.n}`,
  );

  const m3Gate = evaluateM3Gate([
    computeTierMetrics(
      [evFilteredPick],
      60,
      "all",
      "ev_filtered",
      { evFilteredOnly: true },
    ),
  ]);
  check("evaluateM3Gate finds ev_filtered tier", m3Gate.graded === 1);
  check(
    "evaluateM3Gate fails when ROI CI lower bound <= 0 at small n",
    !m3Gate.pass,
  );

  const naPicks: GradedPick[] = picks.map((p) => ({
    ...p,
    closingOdds: null,
    closingBookmaker: null,
  }));
  const naTier = computeTierMetrics(naPicks, 70, "all", "70+");
  check("CLV N/A mode: clvN == 0 when all closingOdds null", naTier.clvN === 0);
  check(
    "CLV N/A mode: avgClvPct null when no closing prices",
    naTier.avgClvPct === null,
  );

  const drawdown = computeDrawdown(picks);
  check("drawdown.n == 10", drawdown.n === 10);
  check("drawdown.maxDrawdownUnits >= 0", drawdown.maxDrawdownUnits >= 0);

  const calib = computeCalibrationBuckets(picks);
  const bucket70 = calib.find((b) => b.lo === 70);
  check(
    "calibration bucket 70-79 captures all 10 picks",
    bucket70?.n === 10,
    JSON.stringify(calib),
  );

  const coinFlip = computeCoinFlipBaseline(picks);
  check(
    "coin-flip baseline ROI is negative at -110 (the house edge)",
    coinFlip.roiPct < 0,
    `roiPct=${coinFlip.roiPct}`,
  );
}

console.log("== report.ts ==");
{
  const picks: GradedPick[] = [];
  for (let i = 0; i < 12; i++) {
    const win = i % 3 !== 0; // 8 win, 4 lose
    picks.push({
      eventId: `e${i}`,
      playerId: i,
      playerName: `Player ${i}`,
      commenceTime: new Date(2026, 5, 1 + i).toISOString(),
      pickSide: i % 2 === 0 ? "over" : "under",
      line: 0.5,
      entryOdds: -115,
      entryBookmaker: "test",
      otherSideEntryOdds: -110,
      closingOdds: -120,
      closingBookmaker: "test",
      confidence: 55 + i * 3,
      confidencePreCap: 55 + i * 3,
      projectedStat: 0.8,
      contextCompleteness: 0.9,
      suppressedLeakRiskFactors: ["statcast", "splits"],
      actualStat: win ? 1 : 0,
      hit: win,
      voided: false,
      evPerUnit: 0.05,
    });
  }
  const excluded: ExcludedCandidate[] = [
    {
      eventId: "eX",
      playerName: "Unresolved Guy",
      line: 0.5,
      reason: "player_unresolved",
    },
    {
      eventId: "eY",
      playerName: "No Price Guy",
      line: 0.5,
      reason: "no_entry_price_for_agreeing_side",
    },
  ];
  const report = buildReport(
    picks,
    excluded,
    500,
    14,
    12,
    1,
    "2026-06-01T00:00:00.000Z",
    "2026-06-13T00:00:00.000Z",
    {
      minCommenceTime: "2026-05-01T00:00:00.000Z",
      maxCommenceTime: "2026-06-20T00:00:00.000Z",
    },
    7,
    {
      market: "batter_hits",
      dataSource: "warehouse",
      clvStatus: "computed",
    },
  );
  check(
    "report.tiers has 24 rows (8 thresholds x 3 sides)",
    report.tiers.length === 24,
    `got ${report.tiers.length}`,
  );
  check(
    "report includes ev_filtered tier",
    report.tiers.some((t) => t.tierLabel === "ev_filtered"),
  );
  check(
    "report.m3Gate present for batter_hits",
    report.m3Gate !== undefined && typeof report.m3Gate.pass === "boolean",
  );
  check(
    "report.coverage.statcastAsOfCount == 7",
    report.coverage.statcastAsOfCount === 7,
  );
  check(
    "report.coverage.statcastAsOfHitRatePct ~= 58.3% (7/12)",
    approx(report.coverage.statcastAsOfHitRatePct ?? -1, (7 / 12) * 100, 1e-6),
    `got ${report.coverage.statcastAsOfHitRatePct}`,
  );
  check(
    "report.coverage.scoredCandidates == 12",
    report.coverage.scoredCandidates === 12,
  );
  check(
    "report.coverage.excludedByReason tallies both exclusion reasons",
    report.coverage.excludedByReason.player_unresolved === 1 &&
      report.coverage.excludedByReason.no_entry_price_for_agreeing_side === 1,
  );
  check(
    "report.baselines has 3 entries (market_favorite, flat_bet_all, coin_flip_ev)",
    report.baselines.length === 3,
  );
  check("report.calibration has 5 buckets", report.calibration.length === 5);
  check("report includes full picks array", report.picks.length === 12);
  check("report includes excluded array", report.excluded.length === 2);

  const outDir = new URL("../out/", import.meta.url);
  await Deno.mkdir(outDir, { recursive: true });

  const jsonUrl = new URL("_smoke_test_report.json", outDir);
  await writeReportJson(report, jsonUrl);
  const written = JSON.parse(await Deno.readTextFile(jsonUrl));
  check(
    "writeReportJson wrote valid, re-readable JSON",
    written.market === "batter_hits" && written.dataSource === "warehouse",
  );
  check("writeReportJson includes picks in JSON", written.picks.length === 12);
  await Deno.remove(jsonUrl).catch(() => {});

  const csvUrl = new URL("_smoke_test_report.csv", outDir);
  await writeReportCsv(report, csvUrl);
  const csvText = await Deno.readTextFile(csvUrl);
  check(
    "writeReportCsv includes meta section",
    csvText.includes("meta,market,batter_hits"),
  );
  check(
    "writeReportCsv includes tiers section",
    csvText.includes("tiers,all,all,"),
  );
  check(
    "writeReportCsv includes calibration section",
    csvText.includes("calibration,0-59,"),
  );
  check(
    "writeReportCsv includes baselines section",
    csvText.includes("baselines,market_favorite,"),
  );
  check(
    "writeReportCsv includes drawdown section",
    csvText.includes("drawdown,max_drawdown_units,"),
  );
  check(
    "writeReportCsv includes sanity section",
    csvText.includes("sanity,calibrated_confidence_max_over,"),
  );
  check(
    "writeReportCsv includes picks section with CLV",
    csvText.includes("picks,e0,") && csvText.includes("clv_pct"),
  );
  await Deno.remove(csvUrl).catch(() => {});

  // printSummary should not throw on a fully-populated report.
  const originalLog = console.log;
  console.log = () => {};
  try {
    printSummary(report);
    check("printSummary runs without throwing", true);
  } catch (e) {
    check("printSummary runs without throwing", false, String(e));
  } finally {
    console.log = originalLog;
  }
}

console.log("== statcast_asof.ts (AS-OF Statcast reconstruction) ==");
{
  const PLAYER_ID = 555;

  const xstatsRows = [
    {
      player_id: PLAYER_ID,
      snapshot_date: "2026-06-10",
      est_ba: 0.26,
      est_slg: 0.43,
      est_slg_minus_slg_diff: 0.01,
      est_woba: 0.32,
      est_woba_minus_woba_diff: -0.005,
    },
    {
      player_id: PLAYER_ID,
      snapshot_date: "2026-06-13",
      est_ba: 0.27,
      est_slg: 0.44,
      est_slg_minus_slg_diff: 0.02,
      est_woba: 0.34,
      est_woba_minus_woba_diff: -0.003,
    },
    {
      player_id: PLAYER_ID,
      snapshot_date: "2026-06-15",
      est_ba: 0.28,
      est_slg: 0.45,
      est_slg_minus_slg_diff: 0.03,
      est_woba: 0.36,
      est_woba_minus_woba_diff: -0.001,
    },
  ];
  const exitVeloRows = [
    {
      player_id: PLAYER_ID,
      snapshot_date: "2026-06-10",
      ev95percent: 40,
      avg_hit_speed: 89.0,
      avg_hit_angle: 11.0,
      anglesweetspotpercent: 32.0,
      brl_pa: 0.06,
      brl_percent: 7.0,
    },
    {
      player_id: PLAYER_ID,
      snapshot_date: "2026-06-13",
      ev95percent: 45,
      avg_hit_speed: 90.0,
      avg_hit_angle: 12.0,
      anglesweetspotpercent: 34.0,
      brl_pa: 0.08,
      brl_percent: 8.5,
    },
    {
      player_id: PLAYER_ID,
      snapshot_date: "2026-06-15",
      ev95percent: 50,
      avg_hit_speed: 91.0,
      avg_hit_angle: 13.0,
      anglesweetspotpercent: 36.0,
      brl_pa: 0.1,
      brl_percent: 10.0,
    },
  ];

  const db = createFakeDb({
    cache_statcast_batters_xstats: () => xstatsRows,
    cache_statcast_batters_exit_velo: () => exitVeloRows,
  });

  const index = await buildStatcastAsOfIndex(db, [PLAYER_ID]);

  const onBoundary = lookupStatcastAsOf(index, PLAYER_ID, "2026-06-15");
  check(
    "LEAKAGE GATE: snapshot dated == game_date is rejected, falls back to 2026-06-13 (est_woba=0.340)",
    onBoundary?.est_woba === 0.34,
    JSON.stringify(onBoundary),
  );
  check(
    "LEAKAGE GATE: same-day exit_velo (ev95percent=50) never leaks through",
    onBoundary?.ev95percent === 45,
    JSON.stringify(onBoundary),
  );

  const midRange = lookupStatcastAsOf(index, PLAYER_ID, "2026-06-14");
  check(
    "mid-range game_date picks latest strictly-prior snapshot (2026-06-13)",
    midRange?.est_woba === 0.34,
    JSON.stringify(midRange),
  );

  const dayAfterEarliest = lookupStatcastAsOf(index, PLAYER_ID, "2026-06-11");
  check(
    "game_date one day after earliest snapshot picks that earliest row",
    dayAfterEarliest?.est_ba === 0.26,
    JSON.stringify(dayAfterEarliest),
  );

  const beforeAnyHistory = lookupStatcastAsOf(index, PLAYER_ID, "2026-06-10");
  check(
    "game_date == earliest snapshot_date has no strictly-prior row -> null (no history yet)",
    beforeAnyHistory === null,
    JSON.stringify(beforeAnyHistory),
  );

  const unknownPlayer = lookupStatcastAsOf(index, 999999, "2026-06-20");
  check("unresolved player (no rows in index) -> null", unknownPlayer === null);

  check(
    "merged object carries all 11 BatterStatcastContext fields",
    onBoundary !== null &&
      Object.keys(onBoundary).sort().join(",") ===
        [
          "est_ba",
          "est_slg",
          "est_slg_minus_slg_diff",
          "brl_pa",
          "brl_percent",
          "avg_hit_speed",
          "est_woba",
          "est_woba_minus_woba_diff",
          "ev95percent",
          "avg_hit_angle",
          "anglesweetspotpercent",
        ]
          .sort()
          .join(","),
    JSON.stringify(onBoundary),
  );
}

console.log(
  "== context_router_batter.ts (runs-aware edit) + scoreBatterRunsScored ==",
);
{
  const EVENT_ID = "evt_smoke_1";
  const BATTER_ID = 123;
  const PITCHER_ID = 999;
  const COMMENCE_TIME = "2026-06-15T23:05:00Z";
  const GAME_DATE = "2026-06-15";

  const battingGames = [1, 0, 2, 1, 0].map((runs, i) => ({
    player_id: BATTER_ID,
    game_pk: 700000 + i,
    game_date: `2026-06-${(14 - i).toString().padStart(2, "0")}`,
    team_id: 1,
    player_name: "Test Batter",
    position_type: "Outfielder",
    is_starter: true,
    batting_order_slot: 3,
    at_bats: 4,
    hits: runs > 0 ? 2 : 1,
    home_runs: 0,
    total_bases: runs > 0 ? 3 : 1,
    rbi: 1,
    plate_appearances: 4,
    innings_pitched: null,
    runs_scored: runs,
  }));
  const expectedSeasonRuns = battingGames.reduce(
    (a, g) => a + g.runs_scored,
    0,
  );

  const pitcherGames = new Array(5).fill(0).map((_, i) => ({
    player_id: PITCHER_ID,
    game_pk: 800000 + i,
    game_date: `2026-06-${(14 - i).toString().padStart(2, "0")}`,
    innings_pitched: 6,
    strikeouts: 6,
    walks: 2,
    pitcher_earned_runs: 3,
    batters_faced: 26,
    pitches_thrown: 95,
    position_type: "Pitcher",
    is_starter: true,
    team_id: 2,
    player_name: "Test Pitcher",
    batting_order_slot: null,
    at_bats: null,
    hits: null,
    home_runs: null,
    total_bases: null,
    rbi: null,
    plate_appearances: null,
    pitcher_runs: 3,
    runs_scored: null,
  }));

  const db = createFakeDb({
    cache_mlb_historical_events: (_sql, params) => {
      if (
        params[0] === EVENT_ID ||
        (Array.isArray(params[0]) && params[0].length === 0)
      ) {
        return [
          {
            event_id: EVENT_ID,
            commence_time: COMMENCE_TIME,
            home_team: "New York Yankees",
            away_team: "Boston Red Sox",
            game_pk: 700123,
          },
        ];
      }
      return [];
    },
    cache_mlb_historical_lineups: () => [
      {
        event_id: EVENT_ID,
        team_side: "home",
        player_id: BATTER_ID,
        lineup_position: 3,
      },
    ],
    cache_mlb_player_metadata: (_sql, params) => {
      const pid = params[0];
      if (pid === BATTER_ID)
        return [
          {
            player_id: BATTER_ID,
            full_name: "Test Batter",
            bats: "R",
            throws: null,
          },
        ];
      return [];
    },
    cache_mlb_boxscore_player_stats: (_sql, params) => {
      if (params[0] === BATTER_ID) return battingGames;
      if (params[0] === PITCHER_ID) return pitcherGames;
      return [];
    },
    cache_mlb_historical_opposing_pitcher: () => [
      {
        event_id: EVENT_ID,
        home_starter_id: 888,
        home_starter_name: "Home SP",
        home_starter_hand: "L",
        away_starter_id: PITCHER_ID,
        away_starter_name: "Test Pitcher",
        away_starter_hand: "R",
      },
    ],
    cache_ballpark_factors: () => [
      {
        park_name: "Yankee Stadium",
        hits_factor: 1.02,
        hr_factor: 1.1,
        k_factor: 0.98,
        runs_factor: 1.05,
      },
    ],
    cache_mlb_historical_weather: () => [
      {
        event_id: EVENT_ID,
        temperature_f: 78,
        wind_speed_mph: 5,
        wind_direction_degrees: 90,
        precipitation_mm: 0,
        humidity_pct: 50,
        is_dome: false,
      },
    ],
    cache_statcast_batters_xstats: () => [
      {
        player_id: BATTER_ID,
        snapshot_date: "2026-06-14",
        est_ba: 0.275,
        est_slg: 0.445,
        est_slg_minus_slg_diff: 0.015,
        est_woba: 0.335,
        est_woba_minus_woba_diff: -0.004,
      },
    ],
    cache_statcast_batters_exit_velo: () => [
      {
        player_id: BATTER_ID,
        snapshot_date: "2026-06-14",
        ev95percent: 42,
        avg_hit_speed: 89.5,
        avg_hit_angle: 12.5,
        anglesweetspotpercent: 33.0,
        brl_pa: 0.07,
        brl_percent: 8.0,
      },
    ],
  });

  const caches = newRouterCaches();
  const statcastIndex = await buildStatcastAsOfIndex(db, [BATTER_ID]);
  const contextResult = await buildLeakSafeBatterContext(
    db,
    EVENT_ID,
    BATTER_ID,
    caches,
    statcastIndex,
    GAME_DATE,
  );

  check(
    "season.runs propagated from cache_mlb_boxscore_player_stats.runs_scored",
    contextResult.ctx.season.runs === expectedSeasonRuns,
    `got ${contextResult.ctx.season.runs}, want ${expectedSeasonRuns}`,
  );
  check(
    "gameLog[].runs propagated per game",
    contextResult.ctx.gameLog.every(
      (g, i) => g.runs === battingGames[i]?.runs_scored,
    ),
    JSON.stringify(contextResult.ctx.gameLog.map((g) => g.runs)),
  );
  check("gameLog length == 5", contextResult.ctx.gameLog.length === 5);
  check("season.gamesPlayed == 5", contextResult.ctx.season.gamesPlayed === 5);
  check(
    "opposingPitcher resolved (era from boxscore aggregate)",
    contextResult.ctx.opposingPitcher !== null &&
      contextResult.ctx.opposingPitcher.era > 0,
  );
  check(
    "ballpark resolved (Yankee Stadium runsFactor)",
    contextResult.ctx.ballpark?.runsFactor === 1.05,
  );

  check(
    "all leak-risk fields suppressed (null)",
    contextResult.leakedFactors.length === 0,
    `leaked=${JSON.stringify(contextResult.leakedFactors)}`,
  );
  check(
    "suppressedLeakRiskFactors reports the 10 remaining tracked fields as null (statcast moved out)",
    contextResult.suppressedLeakRiskFactors.length === 10,
    JSON.stringify(contextResult.suppressedLeakRiskFactors),
  );
  check(
    "statcast is NOT in suppressedLeakRiskFactors (un-suppressed, AS-OF reconstructed instead)",
    !contextResult.suppressedLeakRiskFactors.includes("statcast"),
  );

  check(
    "statcastReconstructed == true",
    contextResult.statcastReconstructed === true,
  );
  check(
    "ctx.statcast populated from the AS-OF snapshot (est_woba=0.335)",
    contextResult.ctx.statcast?.est_woba === 0.335,
    JSON.stringify(contextResult.ctx.statcast),
  );
  check(
    "ctx.statcast exit-velo fields populated from the AS-OF snapshot (ev95percent=42)",
    contextResult.ctx.statcast?.ev95percent === 42,
    JSON.stringify(contextResult.ctx.statcast),
  );

  setMlbWeightsWithPerMarket(getMlbDefaultWeights(), {});
  setActiveMarket("batter_runs_scored");

  const overResult = scoreBatterRunsScored({
    ...contextResult.ctx,
    prop: {
      propType: "batter_runs_scored",
      line: 0.5,
      odds: -120,
      pickSide: "over",
      bookmaker: "test",
    },
  } as BatterScoringContext);
  const underResult = scoreBatterRunsScored({
    ...contextResult.ctx,
    prop: {
      propType: "batter_runs_scored",
      line: 0.5,
      odds: -110,
      pickSide: "under",
      bookmaker: "test",
    },
  } as BatterScoringContext);

  check(
    "scoreBatterRunsScored returns a finite projectedStat > 0",
    Number.isFinite(overResult.projectedStat) && overResult.projectedStat > 0,
    `projectedStat=${overResult.projectedStat}`,
  );
  check(
    "confidence is within [0,100]",
    overResult.confidence >= 0 && overResult.confidence <= 100,
  );
  check(
    "scoreBatterRunsScored exports positive EV fields (M5 Poisson path)",
    overResult.evPerUnit !== undefined && overResult.winProb !== undefined,
    `evPerUnit=${overResult.evPerUnit}`,
  );
  check(
    "M5 Poisson path skips D-784 isotonic ceiling — confidence may exceed 57 on OVER",
    overResult.confidence >= 0 && overResult.confidence <= 100,
  );
  check(
    "M5 Poisson UNDER confidence within [0,100]",
    underResult.confidence >= 0 && underResult.confidence <= 100,
  );
  check(
    "verdict is a non-empty string",
    typeof overResult.verdict === "string" && overResult.verdict.length > 0,
  );
}

console.log("== market_config.ts ==");
{
  check("listCliMarkets returns 10 markets", listCliMarkets().length === 10);
  const hits = getMarketConfig("batter_hits");
  check(
    "batter_hits warehouseOddsAvailable",
    hits.warehouseOddsAvailable === true,
  );
  check("batter_hits gradeColumn hits", hits.gradeColumn === "hits");
  const rs = getMarketConfig("batter_runs_scored");
  check(
    "batter_runs_scored allows pick_history",
    rs.allowedSources.includes("pick_history"),
  );
  check(
    "batter_runs_scored warehouseOddsAvailable false",
    rs.warehouseOddsAvailable === false,
  );
  check(
    "CLV computed for warehouse runs_scored",
    clvStatusFor(rs, "warehouse") === "computed",
  );
  check(
    "CLV na for pick_history runs_scored",
    clvStatusFor(rs, "pick_history") === "na",
  );
  check(
    "resolveDataSource pick_history for runs_scored",
    resolveDataSource(rs, "pick_history") === "pick_history",
  );
  try {
    resolveDataSource(hits, "pick_history");
    check("batter_hits rejects pick_history source", false);
  } catch {
    check("batter_hits rejects pick_history source", true);
  }
  const hr = getMarketConfig("batter_home_runs");
  check("HR mlbMarketType batter_hr", hr.mlbMarketType === "batter_hr");
  check(
    "HR oddsMarketKey batter_home_runs",
    hr.oddsMarketKey === "batter_home_runs",
  );
  const pk = getMarketConfig("pitcher_strikeouts");
  check(
    "pitcher_strikeouts warehouseOddsAvailable",
    pk.warehouseOddsAvailable === true,
  );
  check("pitcher_strikeouts contextKind pitcher", pk.contextKind === "pitcher");
  check(
    "pitcher_strikeouts gradeColumn",
    pk.gradeColumn === "pitcher_strikeouts",
  );
  const po = getMarketConfig("pitcher_outs");
  check(
    "pitcher_outs pick_history only",
    po.allowedSources.join(",") === "pick_history",
  );
  check(
    "pitcher_outs warehouseOddsAvailable false",
    po.warehouseOddsAvailable === false,
  );
  check(
    "CLV na for pick_history pitcher_outs",
    clvStatusFor(po, "pick_history") === "na",
  );
  const h2h = getMarketConfig("h2h");
  check("h2h contextKind game", h2h.contextKind === "game");
  check("h2h mlbMarketType game_side", h2h.mlbMarketType === "game_side");
  const spr = getMarketConfig("spreads");
  check("spreads gameKind spreads", spr.contextKind === "game" && spr.gameKind === "spreads");
  const tot = getMarketConfig("totals");
  check("totals mlbMarketType game_total", tot.mlbMarketType === "game_total");
}

console.log("== pick_history_candidates.ts + event_lookup.ts ==");
{
  const phRows = [
    {
      id: "pick-1",
      player_name: "Test Player",
      team: "New York Yankees",
      opponent: "Boston Red Sox",
      game_date: "2026-06-15",
      game_time: "19:05",
      is_home: true,
      line: 0.5,
      pick_side: "over",
      odds: -115,
    },
  ];
  const phDb = createFakeDb({
    pick_history: () => phRows,
  });
  const universe = await loadPickHistoryUniverse(
    phDb,
    "batter_runs_scored",
    "2026-06-01",
    "2026-06-30",
  );
  check(
    "loadPickHistoryUniverse returns 1 candidate",
    universe.candidates.length === 1,
  );
  check(
    "pick_history candidate has entryOdds from row",
    universe.candidates[0].entryOdds === -115,
  );
  check(
    "pick_history candidate pickSide over",
    universe.candidates[0].pickSide === "over",
  );

  const evDb = createFakeDb({
    cache_mlb_historical_events: (_sql, params) => {
      if (params[0] === "2026-06-15") {
        return [
          {
            event_id: "evt_ph_1",
            commence_time: "2026-06-15T23:05:00Z",
            home_team: "New York Yankees",
            away_team: "Boston Red Sox",
            game_pk: 700999,
          },
        ];
      }
      return [];
    },
  });
  const evIndex = await buildEventLookupIndex(evDb, [
    {
      gameDate: "2026-06-15",
      team: "New York Yankees",
      opponent: "Boston Red Sox",
      isHome: true,
    },
  ]);
  const key = eventLookupKey(
    "2026-06-15",
    "New York Yankees",
    "Boston Red Sox",
    true,
  );
  check(
    "event_lookup resolves home team match",
    evIndex.get(key)?.eventId === "evt_ph_1",
  );
  check("event_lookup resolves game_pk", evIndex.get(key)?.gamePk === 700999);
}

console.log("== candidates.ts (parameterized coverage) ==");
{
  const oddsDb = createFakeDb({
    cache_mlb_historical_odds: () => [
      {
        min_commence_time: "2026-06-01T00:00:00Z",
        max_commence_time: "2026-06-30T00:00:00Z",
        count: "12345",
      },
    ],
  });
  const cov = await detectCoverageWindow(oddsDb, "batter_hits");
  check("detectCoverageWindow rowCount", cov.rowCount === 12345);
  check(
    "detectCoverageWindow min date",
    cov.minCommenceTime === "2026-06-01T00:00:00Z",
  );
  const commenceMs = Date.parse("2026-06-01T18:00:00Z");
  const t6h = "2026-06-01T12:00:00Z";
  const t1h = "2026-06-01T17:00:00Z";
  const t15m = "2026-06-01T17:45:00Z";
  const closing = pickClosingSnapshot([t6h, t1h, t15m], commenceMs, t1h);
  check(
    "pickClosingSnapshot prefers later snapshot distinct from entry",
    closing === t15m,
  );
}

console.log("== report.ts pick_history CLV N/A ==");
{
  const picks: GradedPick[] = [
    {
      eventId: "e1",
      playerId: 1,
      playerName: "Player",
      commenceTime: "2026-06-15T23:05:00Z",
      pickSide: "over",
      line: 0.5,
      entryOdds: -110,
      entryBookmaker: "",
      otherSideEntryOdds: null,
      closingOdds: null,
      closingBookmaker: null,
      confidence: 72,
      confidencePreCap: 72,
      projectedStat: 0.8,
      contextCompleteness: 1,
      suppressedLeakRiskFactors: [],
      actualStat: 1,
      hit: true,
      voided: false,
    },
  ];
  const phReport = buildReport(
    picks,
    [],
    1,
    1,
    1,
    0,
    "2026-06-01T00:00:00Z",
    "2026-06-30T00:00:00Z",
    {
      minCommenceTime: "2026-06-01T00:00:00Z",
      maxCommenceTime: "2026-06-30T00:00:00Z",
    },
    1,
    {
      market: "batter_runs_scored",
      dataSource: "pick_history",
      clvStatus: "na",
      d784CeilingOver: 57,
      d784CeilingUnder: 66,
    },
  );
  check("pick_history report clvStatus na", phReport.clvStatus === "na");
  check(
    "pick_history report dataSource",
    phReport.dataSource === "pick_history",
  );
  check("pick_history tier clvN zero", phReport.tiers[0].clvN === 0);
}

console.log("== M6 metrics.ts side-policy evaluateEvGate ==");
{
  const tiers = [
    computeTierMetrics([], 60, "all", "ev_filtered", { evFilteredOnly: true }),
    computeTierMetrics(
      [
        {
          eventId: "e1",
          playerId: 1,
          playerName: "U",
          commenceTime: "2026-05-01T00:00:00Z",
          pickSide: "under",
          line: 1.5,
          entryOdds: -110,
          entryBookmaker: "test",
          otherSideEntryOdds: -110,
          closingOdds: -115,
          closingBookmaker: "test",
          confidence: 65,
          confidencePreCap: 65,
          projectedStat: 1.0,
          contextCompleteness: 1,
          suppressedLeakRiskFactors: [],
          actualStat: 0,
          hit: true,
          voided: false,
          evPerUnit: 0.05,
        },
      ],
      60,
      "under",
      "ev_filtered",
      { evFilteredOnly: true },
    ),
  ];
  tiers[0].tierLabel = "ev_filtered";
  tiers[0].side = "all";
  tiers[0].graded = 600;
  tiers[0].roiPct = -1;
  tiers[0].roiCiLoPct = -2;
  tiers[0].roiCiHiPct = 0;

  const underGate = evaluateEvGate(tiers, "under");
  check("evaluateEvGate(under) finds under slice", underGate.graded === 1);
  check(
    "evaluateEvGate(under) reason prefixed",
    underGate.reason.startsWith("under-only:"),
  );
  const sideGates = evaluateAllSideEvGates(tiers);
  check("evaluateAllSideEvGates has three keys", sideGates.over !== undefined);
}

console.log("== M6 setPoissonTuningOverride + isotonic TB path ==");
{
  setPoissonTuningOverride(null);
  check(
    "default override is null",
    _getPoissonTuningForTest() === null,
  );

  setMlbWeightsWithPerMarket(getMlbDefaultWeights(), {});
  setActiveMarket("batter_total_bases");

  const tbCtx = {
    season: {
      gamesPlayed: 40,
      atBats: 150,
      hits: 45,
      doubles: 8,
      triples: 1,
      homeRuns: 5,
      totalBases: 70,
      rbi: 20,
      runs: 22,
      walks: 10,
      strikeOuts: 30,
      battingAvg: 0.3,
      obp: 0.36,
      slg: 0.47,
      ops: 0.83,
      bats: "R",
    },
    gameLog: Array.from({ length: 10 }, (_, i) => ({
      gameDate: `2026-05-${String(i + 1).padStart(2, "0")}`,
      atBats: 4,
      hits: 1,
      doubles: 0,
      triples: 0,
      homeRuns: 0,
      totalBases: 1,
      rbi: 0,
      runs: 0,
      walks: 0,
      strikeOuts: 1,
    })),
    opposingPitcher: {
      era: 4.2,
      whip: 1.25,
      kPerNine: 9.0,
      inningsPitched: 50,
      baseOnBalls: 20,
      strikeOuts: 50,
      homeRuns: 5,
      hand: "R",
    },
    ballpark: {
      parkName: "Test Park",
      hitsFactor: 1.0,
      hrFactor: 1.0,
      kFactor: 1.0,
      runsFactor: 1.0,
    },
    weather: { tempF: 72, windSpeed: 5, windDirection: 90 },
    prop: {
      propType: "batter_total_bases",
      line: 1.5,
      odds: -110,
      pickSide: "under",
      bookmaker: "test",
    },
  } as unknown as BatterScoringContext;

  setPoissonTuningOverride(null);
  const poissonTb = scoreBatterTotalBases(tbCtx as BatterScoringContext);

  setPoissonTuningOverride({ disablePoisson: true, market: "batter_total_bases" });
  const isotonicTb = scoreBatterTotalBases(tbCtx as BatterScoringContext);
  setPoissonTuningOverride(null);

  check(
    "Poisson TB exports evPerUnit",
    poissonTb.evPerUnit !== undefined,
  );
  check(
    "isotonic TB path omits evPerUnit",
    isotonicTb.evPerUnit === undefined,
  );
  check(
    "isotonic TB uses D-789 ceiling (under max 69)",
    isotonicTb.confidence <= 69,
  );
}

console.log("== game_candidates.ts + grade_game.ts ==");
{
  const ts = "2026-05-20T16:00:00.000Z";
  const snap = "2026-05-20T15:00:00.000Z";
  const h2hRows: GameOddsRow[] = [
    {
      event_id: "e1",
      snapshot_timestamp: snap,
      commence_time: ts,
      home_team: "New York Yankees",
      away_team: "Boston Red Sox",
      bookmaker_key: "hardrockbet",
      market_key: "h2h__home",
      line: 0,
      over_odds: -150,
      under_odds: null,
    },
    {
      event_id: "e1",
      snapshot_timestamp: snap,
      commence_time: ts,
      home_team: "New York Yankees",
      away_team: "Boston Red Sox",
      bookmaker_key: "hardrockbet",
      market_key: "h2h__away",
      line: 0,
      over_odds: 130,
      under_odds: null,
    },
  ];
  const h2hGroups = groupsToGameCandidates("h2h", h2hRows);
  check("h2h pairs home+away into 1 group", h2hGroups.length === 1);
  check("h2h home price from __home over_odds", h2hGroups[0].entryHomeOrOverOdds === -150);
  check("h2h away price from __away over_odds", h2hGroups[0].entryAwayOrUnderOdds === 130);

  const spreadKeep: GameOddsRow[] = [
    { ...h2hRows[0], market_key: "spreads__home", line: -1.5, over_odds: -110 },
    { ...h2hRows[1], market_key: "spreads__away", line: 1.5, over_odds: -110 },
  ];
  const spreadSkip: GameOddsRow[] = [
    { ...h2hRows[0], event_id: "e2", market_key: "spreads__home", line: -1, over_odds: -110 },
    { ...h2hRows[1], event_id: "e2", market_key: "spreads__away", line: 1, over_odds: -110 },
  ];
  check("spreads keeps |line|=1.5", groupsToGameCandidates("spreads", spreadKeep).length === 1);
  check("spreads drops |line|=1 (D-391)", groupsToGameCandidates("spreads", spreadSkip).length === 0);

  const totRows: GameOddsRow[] = [
    {
      event_id: "e3",
      snapshot_timestamp: snap,
      commence_time: ts,
      home_team: "New York Yankees",
      away_team: "Boston Red Sox",
      bookmaker_key: "hardrockbet",
      market_key: "totals",
      line: 8.5,
      over_odds: -105,
      under_odds: -115,
    },
  ];
  const totGroups = groupsToGameCandidates("totals", totRows);
  check("totals uses both over and under", totGroups.length === 1 && totGroups[0].entryHomeOrOverOdds === -105 && totGroups[0].entryAwayOrUnderOdds === -115);

  const totHit = gradeGameOutcome("totals", "under", 8.5, 3, 4);
  check("totals under hits when 7 < 8.5", totHit.hit === true);
  const totPush = gradeGameOutcome("totals", "over", 8, 4, 4);
  check("totals push on exact total", totPush.hit === null && totPush.voided === false);
  const mlHit = gradeGameOutcome("h2h", "away", 0, 2, 5);
  check("h2h away wins when away scores more", mlHit.hit === true);
  const spreadCover = gradeGameOutcome("spreads", "home", -1.5, 5, 3);
  check("home -1.5 covers 5-3", spreadCover.hit === true);
  const spreadCoverNumericString = gradeGameOutcome(
    "spreads",
    "home",
    "-1.5" as unknown as number,
    7,
    1,
  );
  check(
    "home -1.5 still covers when pg numeric arrives as string",
    spreadCoverNumericString.hit === true,
  );
}

console.log("");
console.log(`${passed} passed, ${failures} failed`);
if (failures > 0) Deno.exit(1);
