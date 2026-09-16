declare const Deno: any;
// Phase 1 backtest harness — report assembly + output.

import type { ClvStatus, DataSource } from "./market_config.ts";
import { impliedProb, unitProfit } from "./oddsmath.ts";
import {
  computeCalibrationBuckets,
  computeCoinFlipBaseline,
  computeDrawdown,
  computeFlatBetAllBaseline,
  computeMarketFavoriteBaseline,
  computeTierMetrics,
  evaluateEvGate,
  evaluateAllSideEvGates,
  evaluateM3Gate,
  type SideEvGateResults,
  type BaselineResult,
  type CalibrationBucket,
  type DrawdownResult,
  type ExcludedCandidate,
  type GradedPick,
  type EvGateResult,
  type M3GateResult,
  type TierMetrics,
} from "./metrics.ts";

/** Math.max(...arr) blows the call stack on 100k+ TB/hits scored sides. */
function maxOrNull(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i]! > m) m = xs[i]!;
  }
  return m;
}

export interface CoverageStats {
  totalOddsRowsFetched: number;
  candidateGroups: number;
  playersResolved: number;
  playersUnresolved: number;
  scoredCandidates: number;
  excludedByReason: Record<string, number>;
  gradeablePicks: number;
  pushCount: number;
  voidCount: number;
  statcastAsOfCount: number;
  statcastAsOfHitRatePct: number | null;
}

export interface BacktestReport {
  market: string;
  dataSource: DataSource;
  clvStatus: ClvStatus;
  generatedAt: string;
  windowStartIso: string;
  windowEndIso: string;
  detectedCoverage: {
    minCommenceTime: string | null;
    maxCommenceTime: string | null;
  };
  coverage: CoverageStats;
  tiers: TierMetrics[];
  calibration: CalibrationBucket[];
  drawdown: DrawdownResult;
  baselines: BaselineResult[];
  falseEdgeFlaggedTiers: string[];
  picks: GradedPick[];
  excluded: ExcludedCandidate[];
  m3Gate?: EvGateResult;
  /** M5 — same gate verdict, emitted for any market with evPerUnit picks. */
  evGate?: EvGateResult;
  /** M6 — per-side ev_filtered gate verdicts (all / over / under). */
  evGateBySide?: SideEvGateResults;
  sanity: {
    calibratedConfidenceMaxOver: number | null;
    calibratedConfidenceMaxUnder: number | null;
    d784ExpectedCeilingOver?: number;
    d784ExpectedCeilingUnder?: number;
    d784CeilingHoldsOver?: boolean;
    d784CeilingHoldsUnder?: boolean;
    samplePicks: Array<
      Pick<
        GradedPick,
        | "playerName"
        | "commenceTime"
        | "pickSide"
        | "line"
        | "entryOdds"
        | "confidence"
        | "actualStat"
        | "hit"
      >
    >;
  };
}

const TIER_THRESHOLDS: Array<{
  label: string;
  min: number;
  recommendableOnly?: boolean;
  evPassOnly?: boolean;
  evFilteredOnly?: boolean;
}> = [
  { label: "all", min: 0 },
  { label: "60+", min: 60 },
  { label: "recommendable", min: 60, recommendableOnly: true },
  { label: "ev_pass", min: 60, evPassOnly: true },
  { label: "ev_filtered", min: 60, evFilteredOnly: true },
  { label: "70+", min: 70 },
  { label: "80+", min: 80 },
  { label: "90+", min: 90 },
];

export interface BuildReportOptions {
  market: string;
  dataSource: DataSource;
  clvStatus: ClvStatus;
  d784CeilingOver?: number;
  d784CeilingUnder?: number;
  /** Game markets have no evPerUnit in production — gate the ev_pass slice instead. */
  evGateTier?: "ev_filtered" | "ev_pass";
}

export function buildReport(
  picks: GradedPick[],
  excluded: ExcludedCandidate[],
  totalOddsRowsFetched: number,
  candidateGroupCount: number,
  playersResolved: number,
  playersUnresolved: number,
  windowStartIso: string,
  windowEndIso: string,
  detectedCoverage: {
    minCommenceTime: string | null;
    maxCommenceTime: string | null;
  },
  statcastReconstructedCount: number,
  options: BuildReportOptions,
): BacktestReport {
  const tiers: TierMetrics[] = [];
  for (const t of TIER_THRESHOLDS) {
    const tierOptions = {
      recommendableOnly: t.recommendableOnly ?? false,
      evPassOnly: t.evPassOnly ?? false,
      evFilteredOnly: t.evFilteredOnly ?? false,
    };
    tiers.push(computeTierMetrics(picks, t.min, "all", t.label, tierOptions));
    tiers.push(computeTierMetrics(picks, t.min, "over", t.label, tierOptions));
    tiers.push(computeTierMetrics(picks, t.min, "under", t.label, tierOptions));
    if (picks.some((p) => p.pickSide === "home" || p.pickSide === "away")) {
      tiers.push(computeTierMetrics(picks, t.min, "home", t.label, tierOptions));
      tiers.push(computeTierMetrics(picks, t.min, "away", t.label, tierOptions));
    }
  }

  const excludedByReason: Record<string, number> = {};
  for (const e of excluded)
    excludedByReason[e.reason] = (excludedByReason[e.reason] ?? 0) + 1;

  const gradeablePicks = picks.filter(
    (p) => !p.voided && p.hit !== null,
  ).length;
  const pushCount = picks.filter((p) => !p.voided && p.hit === null).length;
  const voidCount = picks.filter((p) => p.voided).length;

  const marketFavorite = computeMarketFavoriteBaselineFromPicks(picks);
  const flatAll = computeFlatBetAllBaseline(picks);
  const coinFlip = computeCoinFlipBaseline(picks);

  const overConfs = picks
    .filter((p) => p.pickSide === "over")
    .map((p) => p.confidence);
  const underConfs = picks
    .filter((p) => p.pickSide === "under")
    .map((p) => p.confidence);
  const maxOver = maxOrNull(overConfs);
  const maxUnder = maxOrNull(underConfs);

  const hasD784 =
    options.d784CeilingOver !== undefined &&
    options.d784CeilingUnder !== undefined;

  return {
    market: options.market,
    dataSource: options.dataSource,
    clvStatus: options.clvStatus,
    generatedAt: new Date().toISOString(),
    windowStartIso,
    windowEndIso,
    detectedCoverage,
    coverage: {
      totalOddsRowsFetched,
      candidateGroups: candidateGroupCount,
      playersResolved,
      playersUnresolved,
      scoredCandidates: picks.length,
      excludedByReason,
      gradeablePicks,
      pushCount,
      voidCount,
      statcastAsOfCount: statcastReconstructedCount,
      statcastAsOfHitRatePct:
        picks.length > 0
          ? (statcastReconstructedCount / picks.length) * 100
          : null,
    },
    tiers,
    calibration: computeCalibrationBuckets(picks),
    drawdown: computeDrawdown(picks),
    baselines: [marketFavorite, flatAll, coinFlip],
    falseEdgeFlaggedTiers: tiers
      .filter((t) => t.falseEdgeFlag)
      .map((t) => `${t.tierLabel}/${t.side}`),
    picks,
    excluded,
    ...(picks.some((p) => p.evPerUnit !== undefined) || options.evGateTier === "ev_pass"
      ? {
          evGate: evaluateEvGate(tiers, "all", options.evGateTier ?? "ev_filtered"),
          evGateBySide: evaluateAllSideEvGates(tiers, options.evGateTier ?? "ev_filtered"),
          m3Gate: evaluateEvGate(tiers, "all", options.evGateTier ?? "ev_filtered"),
        }
      : {}),
    sanity: {
      calibratedConfidenceMaxOver: maxOver,
      calibratedConfidenceMaxUnder: maxUnder,
      ...(hasD784
        ? {
            d784ExpectedCeilingOver: options.d784CeilingOver,
            d784ExpectedCeilingUnder: options.d784CeilingUnder,
            d784CeilingHoldsOver:
              maxOver === null ||
              maxOver <= (options.d784CeilingOver as number),
            d784CeilingHoldsUnder:
              maxUnder === null ||
              maxUnder <= (options.d784CeilingUnder as number),
          }
        : {}),
      samplePicks: picks.slice(0, 5).map((p) => ({
        playerName: p.playerName,
        commenceTime: p.commenceTime,
        pickSide: p.pickSide,
        line: p.line,
        entryOdds: p.entryOdds,
        confidence: p.confidence,
        actualStat: p.actualStat,
        hit: p.hit,
      })),
    },
  };
}

function computeMarketFavoriteBaselineFromPicks(
  picks: GradedPick[],
): BaselineResult {
  const pairs = picks.map((p) => ({
    overOdds: p.pickSide === "over" ? p.entryOdds : p.otherSideEntryOdds,
    underOdds: p.pickSide === "under" ? p.entryOdds : p.otherSideEntryOdds,
    actualStat: p.actualStat,
    line: p.line,
  }));
  return computeMarketFavoriteBaseline(pairs);
}

export type ReportFormat = "json" | "csv" | "both";

const HARNESS_OUT_DIR = new URL("../out/", import.meta.url);

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") s = value;
  else if (typeof value === "boolean") s = value ? "true" : "false";
  else s = String(value);
  if (
    s.includes(",") ||
    s.includes('"') ||
    s.includes("\n") ||
    s.includes("\r")
  ) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function ensureParentDir(target: string | URL): Promise<void> {
  if (typeof target === "string") {
    const normalized = target.replace(/\\/g, "/");
    const slash = normalized.lastIndexOf("/");
    const dir = slash > 0 ? normalized.slice(0, slash) : ".";
    if (dir !== ".") await Deno.mkdir(dir, { recursive: true }).catch(() => {});
    return;
  }
  await Deno.mkdir(new URL(".", target), { recursive: true }).catch(() => {});
}

export async function writeReportJson(
  report: BacktestReport,
  outPath: string | URL,
): Promise<void> {
  const target = typeof outPath === "string" ? outPath : outPath;
  await ensureParentDir(target);
  await Deno.writeTextFile(target, JSON.stringify(report, null, 2));
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

function pickClvPct(p: GradedPick): number | null {
  if (p.closingOdds === null) return null;
  return (impliedProb(p.closingOdds) - impliedProb(p.entryOdds)) * 100;
}

function pickUnitProfit(p: GradedPick): number | null {
  if (p.voided || p.hit === null) return null;
  return unitProfit(p.entryOdds, p.hit === true);
}

function appendEvGateCsv(lines: string[], label: string, g: EvGateResult): void {
  lines.push(
    csvRow([label, "pass", g.pass]),
    csvRow([label, "graded", g.graded]),
    csvRow([label, "roi_pct", g.roiPct]),
    csvRow([label, "roi_ci_lo_pct", g.roiCiLoPct]),
    csvRow([label, "roi_ci_hi_pct", g.roiCiHiPct]),
    csvRow([label, "avg_clv_pct", g.avgClvPct ?? ""]),
    csvRow([label, "pct_positive_clv_pct", g.pctPositiveClvPct ?? ""]),
    csvRow([label, "clv_n", g.clvN]),
    csvRow([label, "bonus_clv_positive", g.bonusClvPositive]),
    csvRow([label, "reason", g.reason]),
  );
}

function appendSideEvGateCsv(lines: string[], report: BacktestReport): void {
  if (report.evGateBySide) {
    appendEvGateCsv(lines, "ev_gate_all", report.evGateBySide.all);
    appendEvGateCsv(lines, "ev_gate_over", report.evGateBySide.over);
    appendEvGateCsv(lines, "ev_gate_under", report.evGateBySide.under);
  }
}

/** Multi-section CSV: meta, coverage, tiers, calibration, baselines, drawdown, sanity, picks, excluded. */
export function buildReportCsvContent(report: BacktestReport): string {
  const lines: string[] = [];

  lines.push(csvRow(["section", "key", "value"]));
  lines.push(csvRow(["meta", "market", report.market]));
  lines.push(csvRow(["meta", "data_source", report.dataSource]));
  lines.push(csvRow(["meta", "clv_status", report.clvStatus]));
  lines.push(csvRow(["meta", "generated_at", report.generatedAt]));
  lines.push(csvRow(["meta", "window_start_iso", report.windowStartIso]));
  lines.push(csvRow(["meta", "window_end_iso", report.windowEndIso]));
  lines.push(
    csvRow([
      "meta",
      "detected_coverage_min",
      report.detectedCoverage.minCommenceTime ?? "",
    ]),
  );
  lines.push(
    csvRow([
      "meta",
      "detected_coverage_max",
      report.detectedCoverage.maxCommenceTime ?? "",
    ]),
  );
  lines.push("");

  lines.push(csvRow(["section", "metric", "value"]));
  lines.push(
    csvRow([
      "coverage",
      "total_odds_rows_fetched",
      report.coverage.totalOddsRowsFetched,
    ]),
  );
  lines.push(
    csvRow(["coverage", "candidate_groups", report.coverage.candidateGroups]),
  );
  lines.push(
    csvRow(["coverage", "players_resolved", report.coverage.playersResolved]),
  );
  lines.push(
    csvRow([
      "coverage",
      "players_unresolved",
      report.coverage.playersUnresolved,
    ]),
  );
  lines.push(
    csvRow(["coverage", "scored_candidates", report.coverage.scoredCandidates]),
  );
  lines.push(
    csvRow(["coverage", "gradeable_picks", report.coverage.gradeablePicks]),
  );
  lines.push(csvRow(["coverage", "push_count", report.coverage.pushCount]));
  lines.push(csvRow(["coverage", "void_count", report.coverage.voidCount]));
  lines.push(
    csvRow([
      "coverage",
      "statcast_asof_count",
      report.coverage.statcastAsOfCount,
    ]),
  );
  lines.push(
    csvRow([
      "coverage",
      "statcast_asof_hit_rate_pct",
      report.coverage.statcastAsOfHitRatePct ?? "",
    ]),
  );
  for (const [reason, count] of Object.entries(
    report.coverage.excludedByReason,
  )) {
    lines.push(csvRow(["coverage", `excluded_${reason}`, count]));
  }
  lines.push("");

  lines.push(
    csvRow([
      "section",
      "tier_label",
      "side",
      "min_confidence",
      "n",
      "graded",
      "wins",
      "losses",
      "pushes",
      "voids",
      "win_rate_pct",
      "win_rate_ci_lo_pct",
      "win_rate_ci_hi_pct",
      "roi_pct",
      "roi_ci_lo_pct",
      "roi_ci_hi_pct",
      "total_units",
      "avg_clv_pct",
      "pct_positive_clv_pct",
      "clv_n",
      "avg_no_vig_fair_prob_pct",
      "avg_entry_implied_prob_pct",
      "false_edge_flag",
    ]),
  );
  for (const t of report.tiers) {
    lines.push(
      csvRow([
        "tiers",
        t.tierLabel,
        t.side,
        t.minConfidence,
        t.n,
        t.graded,
        t.wins,
        t.losses,
        t.pushes,
        t.voids,
        t.winRatePct,
        t.winRateCiLoPct,
        t.winRateCiHiPct,
        t.roiPct,
        t.roiCiLoPct,
        t.roiCiHiPct,
        t.totalUnits,
        t.avgClvPct ?? "",
        t.pctPositiveClvPct ?? "",
        t.clvN,
        t.avgNoVigFairProbPct ?? "",
        t.avgEntryImpliedProbPct,
        t.falseEdgeFlag,
      ]),
    );
  }
  lines.push("");

  lines.push(
    csvRow([
      "section",
      "bucket_label",
      "lo",
      "hi",
      "n",
      "avg_confidence",
      "realized_win_rate_pct",
    ]),
  );
  for (const c of report.calibration) {
    lines.push(
      csvRow([
        "calibration",
        c.bucketLabel,
        c.lo,
        c.hi,
        c.n,
        c.avgConfidence,
        c.realizedWinRatePct,
      ]),
    );
  }
  lines.push("");

  lines.push(csvRow(["section", "label", "n", "win_rate_pct", "roi_pct"]));
  for (const b of report.baselines) {
    lines.push(csvRow(["baselines", b.label, b.n, b.winRatePct, b.roiPct]));
  }
  lines.push("");

  lines.push(csvRow(["section", "metric", "value"]));
  lines.push(csvRow(["drawdown", "n", report.drawdown.n]));
  lines.push(
    csvRow([
      "drawdown",
      "final_cumulative_units",
      report.drawdown.finalCumulativeUnits,
    ]),
  );
  lines.push(csvRow(["drawdown", "peak_units", report.drawdown.peakUnits]));
  lines.push(
    csvRow([
      "drawdown",
      "max_drawdown_units",
      report.drawdown.maxDrawdownUnits,
    ]),
  );
  lines.push("");

  lines.push(csvRow(["section", "metric", "value"]));
  lines.push(
    csvRow([
      "sanity",
      "calibrated_confidence_max_over",
      report.sanity.calibratedConfidenceMaxOver ?? "",
    ]),
  );
  lines.push(
    csvRow([
      "sanity",
      "calibrated_confidence_max_under",
      report.sanity.calibratedConfidenceMaxUnder ?? "",
    ]),
  );
  if (report.sanity.d784ExpectedCeilingOver !== undefined) {
    lines.push(
      csvRow([
        "sanity",
        "d784_expected_ceiling_over",
        report.sanity.d784ExpectedCeilingOver,
      ]),
    );
    lines.push(
      csvRow([
        "sanity",
        "d784_expected_ceiling_under",
        report.sanity.d784ExpectedCeilingUnder,
      ]),
    );
    lines.push(
      csvRow([
        "sanity",
        "d784_ceiling_holds_over",
        report.sanity.d784CeilingHoldsOver,
      ]),
    );
    lines.push(
      csvRow([
        "sanity",
        "d784_ceiling_holds_under",
        report.sanity.d784CeilingHoldsUnder,
      ]),
    );
  }
  lines.push(
    csvRow([
      "sanity",
      "false_edge_flagged_tiers",
      report.falseEdgeFlaggedTiers.join("; "),
    ]),
  );
  if (report.m3Gate) {
    appendEvGateCsv(lines, "m3_gate", report.m3Gate);
  }
  appendSideEvGateCsv(lines, report);
  lines.push("");

  if (report.falseEdgeFlaggedTiers.length > 0) {
    lines.push(csvRow(["section", "tier_side"]));
    for (const tier of report.falseEdgeFlaggedTiers) {
      lines.push(csvRow(["false_edge", tier]));
    }
    lines.push("");
  }

  if (report.excluded.length > 0) {
    lines.push(
      csvRow([
        "section",
        "event_id",
        "player_name",
        "line",
        "reason",
        "detail",
      ]),
    );
    for (const e of report.excluded) {
      lines.push(
        csvRow([
          "excluded",
          e.eventId,
          e.playerName,
          e.line,
          e.reason,
          e.detail ?? "",
        ]),
      );
    }
    lines.push("");
  }

  lines.push(
    csvRow([
      "section",
      "event_id",
      "player_id",
      "player_name",
      "commence_time",
      "pick_side",
      "line",
      "entry_odds",
      "entry_bookmaker",
      "closing_odds",
      "closing_bookmaker",
      "confidence",
      "confidence_pre_cap",
      "projected_stat",
      "win_prob",
      "edge_vs_implied",
      "ev_per_unit",
      "unbettable_over_breakeven",
      "context_completeness",
      "actual_stat",
      "hit",
      "voided",
      "void_reason",
      "clv_pct",
      "unit_profit",
    ]),
  );
  for (const p of report.picks) {
    lines.push(
      csvRow([
        "picks",
        p.eventId,
        p.playerId,
        p.playerName,
        p.commenceTime,
        p.pickSide,
        p.line,
        p.entryOdds,
        p.entryBookmaker,
        p.closingOdds,
        p.closingBookmaker,
        p.confidence,
        p.confidencePreCap,
        p.projectedStat,
        p.winProb ?? "",
        p.edgeVsImplied ?? "",
        p.evPerUnit ?? "",
        p.unbettableOverBreakevenFlag ?? "",
        p.contextCompleteness,
        p.actualStat,
        p.hit,
        p.voided,
        p.voidReason ?? "",
        pickClvPct(p) ?? "",
        pickUnitProfit(p) ?? "",
      ]),
    );
  }

  return lines.join("\n") + "\n";
}

export async function writeReportCsv(
  report: BacktestReport,
  outPath: string | URL,
): Promise<void> {
  const target = typeof outPath === "string" ? outPath : outPath;
  await ensureParentDir(target);
  await Deno.writeTextFile(target, buildReportCsvContent(report));
}

/** Write report to harness/out/ (or a custom base path). Returns paths written. */
export async function writeReportOutputs(
  report: BacktestReport,
  options: { format?: ReportFormat; outBase?: string },
): Promise<string[]> {
  const format = options.format ?? "both";
  const base =
    options.outBase ??
    `${report.market}_${report.windowStartIso.slice(0, 10)}_to_${report.windowEndIso.slice(0, 10)}`;
  await Deno.mkdir(HARNESS_OUT_DIR, { recursive: true });

  const written: string[] = [];
  if (format === "json" || format === "both") {
    const jsonUrl = new URL(`${base}.json`, HARNESS_OUT_DIR);
    await writeReportJson(report, jsonUrl);
    written.push(`harness/out/${base}.json`);
  }
  if (format === "csv" || format === "both") {
    const csvUrl = new URL(`${base}.csv`, HARNESS_OUT_DIR);
    await writeReportCsv(report, csvUrl);
    written.push(`harness/out/${base}.csv`);
  }
  return written;
}

export function parseReportFormat(raw: string | undefined): ReportFormat {
  if (!raw || raw === "both") return "both";
  if (raw === "json" || raw === "csv") return raw;
  throw new Error(`[harness] Invalid --format=${raw}. Use json, csv, or both.`);
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "" : ""}${n.toFixed(2)}%`;
}

function printEvGateSummary(
  lines: string[],
  label: string,
  g: EvGateResult,
): void {
  lines.push(`-- ${label} (ev_filtered) --`);
  lines.push(`  verdict:             ${g.pass ? "PASS" : "FAIL"}`);
  lines.push(`  graded n:            ${g.graded}`);
  lines.push(
    `  ROI-after-vig:       ${fmtPct(g.roiPct)}  [${fmtPct(g.roiCiLoPct)}, ${fmtPct(g.roiCiHiPct)}]`,
  );
  lines.push(
    `  avg CLV:             ${g.avgClvPct === null ? "n/a" : fmtPct(g.avgClvPct)}  (n=${g.clvN})`,
  );
  lines.push(
    `  % positive CLV:      ${g.pctPositiveClvPct === null ? "n/a" : fmtPct(g.pctPositiveClvPct)}`,
  );
  lines.push(
    `  bonus CLV > 0:       ${g.bonusClvPositive ? "yes" : "no"}`,
  );
  lines.push(`  reason:              ${g.reason}`);
  lines.push("");
}

export function printSummary(report: BacktestReport): void {
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push(`SharpAI Phase 1 Backtest — ${report.market}`);
  lines.push("=".repeat(78));
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Data source: ${report.dataSource}`);
  lines.push(
    `CLV: ${report.clvStatus === "na" ? "N/A (pick_history mode)" : "computed from historical odds"}`,
  );
  lines.push(
    `Window requested: ${report.windowStartIso} -> ${report.windowEndIso}`,
  );
  lines.push(
    `Detected coverage: ${report.detectedCoverage.minCommenceTime ?? "none"} -> ${
      report.detectedCoverage.maxCommenceTime ?? "none"
    }`,
  );
  lines.push("");
  lines.push("-- Coverage --");
  lines.push(
    `  odds/pick rows fetched:   ${report.coverage.totalOddsRowsFetched}`,
  );
  lines.push(`  candidate groups:       ${report.coverage.candidateGroups}`);
  lines.push(`  players resolved:       ${report.coverage.playersResolved}`);
  lines.push(`  players unresolved:     ${report.coverage.playersUnresolved}`);
  lines.push(`  scored candidates:      ${report.coverage.scoredCandidates}`);
  lines.push(`  gradeable (win/loss):   ${report.coverage.gradeablePicks}`);
  lines.push(`  pushes:                 ${report.coverage.pushCount}`);
  lines.push(`  voids (DNP/no boxscore): ${report.coverage.voidCount}`);
  lines.push(
    `  Statcast AS-OF found:     ${report.coverage.statcastAsOfCount}/${report.coverage.scoredCandidates}` +
      ` (${report.coverage.statcastAsOfHitRatePct === null ? "n/a" : fmtPct(report.coverage.statcastAsOfHitRatePct)})`,
  );
  for (const [reason, count] of Object.entries(
    report.coverage.excludedByReason,
  )) {
    lines.push(`  excluded (${reason}): ${count}`);
  }
  lines.push("");
  lines.push(
    `-- Tiers (win rate / ROI-after-vig / CLV${report.clvStatus === "na" ? " — N/A" : ""}) --`,
  );
  lines.push(
    "  recommendable / ev_pass = conf>=60 excluding unbettable under juice + overs must clear implied BE",
  );
  lines.push(
    "  ev_filtered = ev_pass + evPerUnit > 0 (production recommendation_shown parity)",
  );
  lines.push(
    "  tier   side   n     graded  WR%      WR_CI95%          ROI%     ROI_CI95%           CLV%avg  CLV+%   Brier   falseEdge",
  );
  for (const t of report.tiers) {
    const clvAvg =
      report.clvStatus === "na"
        ? "N/A"
        : t.avgClvPct === null
          ? "n/a"
          : fmtPct(t.avgClvPct);
    const clvPos =
      report.clvStatus === "na"
        ? "N/A"
        : t.pctPositiveClvPct === null
          ? "n/a"
          : fmtPct(t.pctPositiveClvPct);
    lines.push(
      `  ${t.tierLabel.padEnd(5)} ${t.side.padEnd(5)} ${String(t.n).padStart(5)} ${String(t.graded).padStart(6)}  ` +
        `${fmtPct(t.winRatePct).padStart(7)}  [${fmtPct(t.winRateCiLoPct)}, ${fmtPct(t.winRateCiHiPct)}]  ` +
        `${fmtPct(t.roiPct).padStart(7)}  [${fmtPct(t.roiCiLoPct)}, ${fmtPct(t.roiCiHiPct)}]  ` +
        `${clvAvg}  ${clvPos}  ${t.brierScore !== null ? t.brierScore.toFixed(4).padStart(6) : "  n/a "}  ${t.falseEdgeFlag ? "*** FALSE EDGE ***" : ""}`,
    );
  }
  lines.push("");
  lines.push("-- Calibration (calibrated confidence bucket vs realized WR) --");
  for (const c of report.calibration) {
    lines.push(
      `  ${c.bucketLabel.padEnd(6)} n=${String(c.n).padStart(5)}  avgConf=${c.avgConfidence.toFixed(1).padStart(6)}  realizedWR=${fmtPct(
        c.realizedWinRatePct,
      )}`,
    );
  }
  lines.push("");
  lines.push("-- Baselines (SharpAI must beat these to claim a real edge) --");
  for (const b of report.baselines) {
    lines.push(
      `  ${b.label.padEnd(16)} n=${String(b.n).padStart(6)}  WR=${fmtPct(b.winRatePct).padStart(8)}  ROI=${fmtPct(b.roiPct)}`,
    );
  }
  lines.push("");
  lines.push("-- Drawdown (all taken picks, chronological, flat 1u) --");
  lines.push(`  n graded:            ${report.drawdown.n}`);
  lines.push(
    `  final cumulative:    ${report.drawdown.finalCumulativeUnits.toFixed(2)}u`,
  );
  lines.push(`  peak:                ${report.drawdown.peakUnits.toFixed(2)}u`);
  lines.push(
    `  max drawdown:        ${report.drawdown.maxDrawdownUnits.toFixed(2)}u`,
  );
  lines.push("");
  lines.push("-- Sanity checks --");
  if (report.sanity.d784ExpectedCeilingOver !== undefined) {
    lines.push(
      `  D-784 OVER ceiling (${report.sanity.d784ExpectedCeilingOver}):  max observed = ${
        report.sanity.calibratedConfidenceMaxOver ?? "n/a"
      } -> ${report.sanity.d784CeilingHoldsOver ? "OK" : "VIOLATED"}`,
    );
    lines.push(
      `  D-784 UNDER ceiling (${report.sanity.d784ExpectedCeilingUnder}): max observed = ${
        report.sanity.calibratedConfidenceMaxUnder ?? "n/a"
      } -> ${report.sanity.d784CeilingHoldsUnder ? "OK" : "VIOLATED"}`,
    );
  }
  lines.push("  sample picks:");
  for (const s of report.sanity.samplePicks) {
    lines.push(
      `    ${s.commenceTime}  ${s.playerName.padEnd(24)} ${s.pickSide} ${s.line} @ ${s.entryOdds}  conf=${s.confidence}  actual=${s.actualStat}  hit=${s.hit}`,
    );
  }
  lines.push("");
  if (report.m3Gate) {
    printEvGateSummary(lines, "M3 gate / all", report.m3Gate);
  }
  if (report.evGateBySide) {
    printEvGateSummary(lines, "EV gate / all", report.evGateBySide.all);
    printEvGateSummary(lines, "EV gate / over", report.evGateBySide.over);
    printEvGateSummary(lines, "EV gate / under", report.evGateBySide.under);
  }
  if (report.falseEdgeFlaggedTiers.length > 0) {
    lines.push(
      `*** FALSE EDGE DETECTED in: ${report.falseEdgeFlaggedTiers.join(", ")} ***`,
    );
  } else {
    lines.push(
      "No false-edge tiers detected (high WR without corresponding ROI).",
    );
  }
  lines.push("=".repeat(78));
  console.log(lines.join("\n"));
}
