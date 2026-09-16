/**
 * MLB Dynamic ML Policy Engine - Failure Log
 * Auto-generates structured failure logs when the market gate fails.
 */

import { notify } from "./notify.ts";
import { logErrorStructured } from "./error_handling.ts";
import type { MarketGateResult, MarketGateMetrics } from "./market_gate.ts";

export interface FailureRecord {
  market: string;
  gameId: string;
  pickSide: string;
  timestamp: string;
  gateMetrics: MarketGateMetrics;
  failureReasons: string[];
}

export async function logMarketGateFailure(
  market: string,
  gameId: string,
  pickSide: string,
  gateMetrics: MarketGateMetrics,
  gateResult: MarketGateResult
): Promise<void> {
  if (gateResult.pass) return;

  const record: FailureRecord = {
    market,
    gameId,
    pickSide,
    timestamp: new Date().toISOString(),
    gateMetrics,
    failureReasons: gateResult.reasons
  };

  const logMessage = `[MARKET_GATE_FAILURE] Market: ${market}, Side: ${pickSide}, Game: ${gameId}\nReasons: ${gateResult.reasons.join(', ')}`;
  
  await logErrorStructured("warning", {
    function_name: "process-games-mlb",
    phase: "market_gate",
    error_type: "market_gate_failure",
    message: logMessage,
    payload: { record }
  });

  // If we have a critical failure (like ROI < 0), send a lower-priority alert
  // (using priority 1 for non-pager alerts, 2 for pagers)
  if (gateMetrics.roiLowerBound < 0 || gateMetrics.avgClv < 0) {
    await notify({ severity: 'warning', title: 'Negative ROI/CLV', message: `Negative ROI/CLV detected on ${market} ${pickSide}. Market gate blocked execution.` });
  }
  
  // Note: Future enhancement could insert this record into a dedicated `error_log` 
  // or `market_gate_failures` table in Supabase.
}
