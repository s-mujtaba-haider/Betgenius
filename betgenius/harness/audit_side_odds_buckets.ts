// Milestone 1 — Side × odds bucket audit (read-only).
// Slices harness CSV pick rows into over/under × odds-band tables.
//
// Run:
//   deno run --allow-read --allow-write harness/audit_side_odds_buckets.ts \
//     --input=harness/out/batter_hits_2026-04-25_to_2026-05-24.csv

import { impliedProb, unitProfit } from "./lib/oddsmath.ts";
import { bootstrapMeanCI, wilsonInterval, type PickSide } from "./lib/metrics.ts";

interface PickRow {
  pickSide: PickSide;
  entryOdds: number;
  confidence: number;
  hit: boolean;
  closingOdds: number | null;
}

interface BucketDef {
  label: string;
  min: number;
  max: number;
}

const ODDS_BANDS: BucketDef[] = [
  { label: "plus_150_plus", min: 150, max: Infinity },
  { label: "plus_100_149", min: 100, max: 149 },
  { label: "pickem_-109_+99", min: -109, max: 99 },
  { label: "juice_-110_-149", min: -149, max: -110 },
  { label: "heavy_-150_-199", min: -199, max: -150 },
  { label: "heavy_-200_-249", min: -249, max: -200 },
  { label: "extreme_-250_plus", min: -Infinity, max: -250 },
];

function oddsBand(odds: number): string {
  for (const b of ODDS_BANDS) {
    if (odds >= b.min && odds <= b.max) return b.label;
  }
  return "other";
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, "\"\"")}"`;
  }
  return s;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

function parseHarnessCsv(text: string): { market: string; picks: PickRow[] } {
  const lines = text.split(/\r?\n/);
  let market = "unknown";
  const picks: PickRow[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (cols[0] === "meta" && cols[1] === "market") market = cols[2];
    if (cols[0] !== "picks") continue;

    const voided = cols[17] === "true";
    const hitRaw = cols[16];
    if (voided || hitRaw === "") continue;

    picks.push({
      pickSide: cols[5] as PickSide,
      entryOdds: Number(cols[7]),
      confidence: Number(cols[11]),
      hit: hitRaw === "true",
      closingOdds: cols[9] === "" ? null : Number(cols[9]),
    });
  }

  return { market, picks };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"" && line[i + 1] === "\"") {
        cur += "\"";
        i++;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

type AuditSide = PickSide | "all";

interface BucketMetrics {
  side: AuditSide;
  oddsBand: string;
  n: number;
  graded: number;
  wins: number;
  losses: number;
  winRatePct: number;
  winRateCiLoPct: number;
  winRateCiHiPct: number;
  avgBreakevenPct: number;
  gapVsBreakevenPp: number;
  roiPct: number;
  roiCiLoPct: number;
  roiCiHiPct: number;
  avgClvPct: number | null;
  clvN: number;
  falseEdgeFlag: boolean;
}

function computeBucketMetrics(side: AuditSide, band: string, rows: PickRow[]): BucketMetrics {
  const wins = rows.filter((r) => r.hit).length;
  const graded = rows.length;
  const losses = graded - wins;
  const winRatePct = graded > 0 ? (wins / graded) * 100 : 0;
  const wilson = wilsonInterval(wins, graded);
  const profits = rows.map((r) => unitProfit(r.entryOdds, r.hit));
  const roiBoot = bootstrapMeanCI(profits);
  const avgBreakevenPct = graded > 0
    ? (rows.reduce((a, r) => a + impliedProb(r.entryOdds), 0) / graded) * 100
    : 0;
  const clvRows = rows.filter((r) => r.closingOdds !== null);
  const clvValues = clvRows.map((r) =>
    (impliedProb(r.closingOdds as number) - impliedProb(r.entryOdds)) * 100
  );
  const avgClvPct = clvValues.length > 0
    ? clvValues.reduce((a, b) => a + b, 0) / clvValues.length
    : null;

  return {
    side,
    oddsBand: band,
    n: graded,
    graded,
    wins,
    losses,
    winRatePct,
    winRateCiLoPct: wilson.lo * 100,
    winRateCiHiPct: wilson.hi * 100,
    avgBreakevenPct,
    gapVsBreakevenPp: winRatePct - avgBreakevenPct,
    roiPct: roiBoot.mean * 100,
    roiCiLoPct: roiBoot.lo * 100,
    roiCiHiPct: roiBoot.hi * 100,
    avgClvPct,
    clvN: clvValues.length,
    falseEdgeFlag: graded >= 20 && wilson.lo > 0.5 && roiBoot.hi <= 0,
  };
}

function buildAuditRowsClean(picks: PickRow[]): BucketMetrics[] {
  const out: BucketMetrics[] = [];
  if (picks.length > 0) {
    out.push(computeBucketMetrics("all", "ALL", picks));
  }

  for (const side of ["over", "under"] as const) {
    const sideRows = picks.filter((p) => p.pickSide === side);
    if (sideRows.length > 0) {
      out.push(computeBucketMetrics(side, "ALL", sideRows));
    }
    for (const band of ODDS_BANDS) {
      const rows = sideRows.filter((p) => oddsBand(p.entryOdds) === band.label);
      if (rows.length > 0) out.push(computeBucketMetrics(side, band.label, rows));
    }
  }
  return out;
}

function buildCsvContent(market: string, sourcePath: string, rows: BucketMetrics[]): string {
  const lines: string[] = [];
  lines.push(csvRow(["section", "key", "value"]));
  lines.push(csvRow(["meta", "market", market]));
  lines.push(csvRow(["meta", "source", sourcePath]));
  lines.push(csvRow(["meta", "generated_at", new Date().toISOString()]));
  lines.push("");

  lines.push(csvRow([
    "section",
    "side",
    "odds_band",
    "n",
    "wins",
    "losses",
    "win_rate_pct",
    "win_rate_ci_lo_pct",
    "win_rate_ci_hi_pct",
    "avg_breakeven_pct",
    "gap_vs_breakeven_pp",
    "roi_pct",
    "roi_ci_lo_pct",
    "roi_ci_hi_pct",
    "avg_clv_pct",
    "clv_n",
    "false_edge_flag",
  ]));
  for (const r of rows) {
    lines.push(csvRow([
      "buckets",
      r.side,
      r.oddsBand,
      r.n,
      r.wins,
      r.losses,
      r.winRatePct,
      r.winRateCiLoPct,
      r.winRateCiHiPct,
      r.avgBreakevenPct,
      r.gapVsBreakevenPp,
      r.roiPct,
      r.roiCiLoPct,
      r.roiCiHiPct,
      r.avgClvPct ?? "",
      r.clvN,
      r.falseEdgeFlag,
    ]));
  }
  return lines.join("\n") + "\n";
}

function printConsoleSummary(market: string, rows: BucketMetrics[]): void {
  console.log(`\n=== ${market} — side × odds bucket audit ===`);
  const overBands = rows.filter((r) => r.side === "over" && r.oddsBand !== "ALL");
  const underBands = rows.filter((r) => r.side === "under" && r.oddsBand !== "ALL");

  console.log("\nOVER bands (sorted by ROI):");
  for (const r of [...overBands].sort((a, b) => a.roiPct - b.roiPct)) {
    console.log(
      `  ${r.oddsBand.padEnd(20)} n=${String(r.n).padStart(5)} WR=${r.winRatePct.toFixed(1)}% BE=${r.avgBreakevenPct.toFixed(1)}% gap=${r.gapVsBreakevenPp >= 0 ? "+" : ""}${r.gapVsBreakevenPp.toFixed(1)}pp ROI=${r.roiPct.toFixed(1)}%`,
    );
  }

  console.log("\nUNDER bands (sorted by ROI desc):");
  for (const r of [...underBands].sort((a, b) => b.roiPct - a.roiPct)) {
    console.log(
      `  ${r.oddsBand.padEnd(20)} n=${String(r.n).padStart(5)} WR=${r.winRatePct.toFixed(1)}% BE=${r.avgBreakevenPct.toFixed(1)}% gap=${r.gapVsBreakevenPp >= 0 ? "+" : ""}${r.gapVsBreakevenPp.toFixed(1)}pp ROI=${r.roiPct.toFixed(1)}%`,
    );
  }
}

async function main(): Promise<void> {
  const args = Deno.args;
  const inputs: string[] = [];
  let outBase: string | null = null;

  for (const arg of args) {
    if (arg.startsWith("--input=")) {
      inputs.push(...arg.slice("--input=".length).split(","));
    } else if (arg.startsWith("--out=")) {
      outBase = arg.slice("--out=".length);
    }
  }

  if (inputs.length === 0) {
    inputs.push(
      "harness/out/batter_hits_2026-04-25_to_2026-05-24.csv",
      "harness/out/pitcher_strikeouts_2026-04-25_to_2026-05-24.csv",
    );
  }

  for (const inputPath of inputs) {
    const text = await Deno.readTextFile(inputPath);
    const { market, picks } = parseHarnessCsv(text);
    const rows = buildAuditRowsClean(picks);
    printConsoleSummary(market, rows);

    const stem = inputPath.replace(/\\/g, "/").replace(/\.csv$/, "").split("/").pop() ?? "audit";
    const outPath = outBase ?? `harness/out/audit_side_odds_${stem}.csv`;
    await Deno.mkdir(outPath.replace(/\\/g, "/").replace(/\/[^/]+$/, ""), { recursive: true }).catch(() => {});
    await Deno.writeTextFile(outPath, buildCsvContent(market, inputPath, rows));
    console.log(`\nWrote ${outPath} (${rows.length} bucket rows from ${picks.length} picks)`);
  }
}

main();
