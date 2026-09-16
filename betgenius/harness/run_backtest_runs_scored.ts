#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
// Deprecated wrapper — use run_backtest.ts --market=batter_runs_scored instead.

import {
  getMarketConfig,
  resolveDataSource,
} from "./lib/market_config.ts";
import {
  parseArgs,
  runPickHistoryBacktest,
  runWarehouseBacktest,
} from "./run_backtest.ts";

async function main() {
  const args = parseArgs(Deno.args);
  if (!args.market) args.market = "batter_runs_scored";
  const config = getMarketConfig(args.market);
  const source = resolveDataSource(config, args.source);
  if (source === "pick_history") {
    await runPickHistoryBacktest(config, args);
  } else {
    await runWarehouseBacktest(config, args);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[harness] FATAL:", e);
    Deno.exit(1);
  });
}
