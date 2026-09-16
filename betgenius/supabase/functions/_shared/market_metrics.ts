declare const Deno: any;
/**
 * MLB Dynamic ML Policy Engine - Market Metrics Loader
 * Fetches historical metrics from v_market_training_features (per-event)
 * and v_market_gate_metrics (aggregate gate-ready) for use in
 * coverage_check, market_gate, and dynamic_scoring_wrapper.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export interface MarketMetricsRow {
  market_type: string;
  pick_side: string;
  historical_win_rate: number;
  confidence_variance: number;
  sample_size: number;
  avg_closing_line: number;
}

/** Aggregate gate-ready metrics from v_market_gate_metrics (one row per market+side). */
export interface MarketGateMetricsRow {
  market_type: string;
  pick_side: string;
  sample_size: number;
  grading_completeness: number;
  historical_win_rate: number;
  roi_lower_bound: number;
  avg_roi: number;
  brier_score: number;
  baseline_brier_score: number;
  avg_clv: number;
  confidence_variance: number;
  avg_closing_line: number;
}

const sH = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

export async function cacheMarketTrainingFeatures(): Promise<Map<string, MarketMetricsRow>> {
  const map = new Map<string, MarketMetricsRow>();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/v_market_training_features?select=*`, {
      headers: sH(),
    });
    
    if (!res.ok) {
      console.error(`[MarketMetrics] Failed to fetch v_market_training_features: ${res.status}`);
      return map;
    }

    const data: MarketMetricsRow[] = await res.json();
    for (const row of data) {
      const key = `${row.market_type}|${row.pick_side}`;
      map.set(key, row);
    }
  } catch (e) {
    console.error(`[MarketMetrics] Exception fetching metrics:`, e);
  }
  
  return map;
}

/**
 * Load aggregate gate metrics from v_market_gate_metrics.
 * Returns a map keyed by "market_type|pick_side".
 * Falls back to an empty map on any failure (fail-safe: gate will reject
 * because buildMarketGateMetrics returns null when no data exists).
 */
export async function cacheMarketGateMetrics(): Promise<Map<string, MarketGateMetricsRow>> {
  const map = new Map<string, MarketGateMetricsRow>();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/v_market_gate_metrics?select=*`, {
      headers: sH(),
    });

    if (!res.ok) {
      console.error(`[MarketMetrics] Failed to fetch v_market_gate_metrics: ${res.status}`);
      return map;
    }

    const data: MarketGateMetricsRow[] = await res.json();
    for (const row of data) {
      const key = `${row.market_type}|${row.pick_side}`;
      map.set(key, row);
    }
  } catch (e) {
    console.error(`[MarketMetrics] Exception fetching gate metrics:`, e);
  }

  return map;
}
