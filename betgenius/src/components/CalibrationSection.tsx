// CalibrationSection — real-money calibration tracking on /performance.
// May 11, 2026.
//
// Reads from public.calibration_snapshots (written daily by cron jobid 13
// "calibration-snapshot-daily" at 11:15 UTC via write-calibration-snapshot
// edge function). Bootstrap-populated May 7-11.
//
// Sample sizes shown honestly with "low sample" badge when bets_resolved
// < 30 per bucket (per CEO spec — don't hide low-sample data, surface with
// caveats).

import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { useAuthSession } from "@/lib/auth";

type WindowType = "rolling_7d" | "rolling_30d" | "all_time";

interface CalibrationRow {
  id: number;
  snapshot_date: string;
  window_type: WindowType;
  metric_type: "overall" | "tier" | "prop_type" | "factor_presence";
  metric_key: string;
  bets_count: number;
  bets_resolved: number;
  bets_hit: number;
  hit_rate: number | null;
  avg_confidence: number | null;
  backtest_hit_rate: number | null;
  calibration_delta: number | null;
  sample_size_warning: boolean;
}

function pctFmt(v: number | null | undefined, decimals = 1): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(decimals)}%`;
}

function deltaPctFmt(v: number | null | undefined): string {
  if (v == null) return "—";
  const pp = v * 100;
  const sign = pp >= 0 ? "+" : "";
  return `${sign}${pp.toFixed(1)}pp`;
}

function tierOrder(key: string): number {
  const order: Record<string, number> = { "90+": 1, "80-89": 2, "70-79": 3, "60-69": 4, "<60": 5 };
  return order[key] ?? 99;
}

export default function CalibrationSection() {
  const { session } = useAuthSession();
  const [rows, setRows] = useState<CalibrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeWindow, setActiveWindow] = useState<WindowType>("rolling_30d");
  // Tier 1 #7 (May 13, 2026): reference #4 from §15.7.8 — synthetic backtest
  // hit rate filtered to the post-megadeploy organic-resolved corpus. The
  // existing tier table's `backtest_hit_rate` is reference #2 (unfiltered
  // 12,497-row synthetic corpus from D-111 / May 8 era) which the §15.7.2
  // v2.32 framing called out as apples-to-oranges vs real-money. Reference
  // #4 is the honest apples-to-apples comparison. Queried inline rather
  // than via calibration_snapshots because the existing writer
  // (D-118 compute_calibration_snapshot) only emits reference #2; adding
  // a `metric_type='reference_4'` would be a write-side change deferred
  // to a follow-up §19.3 review.
  const [ref4ByTier, setRef4ByTier] = useState<Map<string, { wr: number; n: number }>>(new Map());

  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Pull last 60 days of snapshots so the trend chart has data.
        const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        const url =
          `${SUPABASE_URL}/rest/v1/calibration_snapshots` +
          `?snapshot_date=gte.${cutoff}` +
          `&order=snapshot_date.desc,id.desc` +
          `&select=*`;
        const res = await fetch(url, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CalibrationRow[];
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session?.access_token]);

  // Tier 1 #7: fetch the reference #4 corpus inline. Raw pick_history rows
  // (~50-80 in the post-May-4 synthetic resolved cohort) are small enough
  // to aggregate client-side; avoids a Postgres view / RPC dependency.
  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    (async () => {
      try {
        const url =
          `${SUPABASE_URL}/rest/v1/pick_history` +
          `?is_synthetic=eq.true&source=eq.backfill` +
          `&game_date=gte.2026-05-04` +
          `&hit=not.is.null&voided=eq.false` +
          `&select=confidence,hit`;
        const res = await fetch(url, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        if (!res.ok) return; // soft-fail — reference #4 is enriching, not critical
        const data = (await res.json()) as Array<{ confidence: number; hit: boolean }>;
        const buckets: Record<string, { hits: number; total: number }> = {
          "90+": { hits: 0, total: 0 }, "80-89": { hits: 0, total: 0 },
          "70-79": { hits: 0, total: 0 }, "60-69": { hits: 0, total: 0 },
          "<60":   { hits: 0, total: 0 },
        };
        for (const row of data) {
          const c = row.confidence;
          const key = c >= 90 ? "90+" : c >= 80 ? "80-89" : c >= 70 ? "70-79" : c >= 60 ? "60-69" : "<60";
          buckets[key].total += 1;
          if (row.hit) buckets[key].hits += 1;
        }
        const m = new Map<string, { wr: number; n: number }>();
        for (const k of Object.keys(buckets)) {
          const b = buckets[k];
          if (b.total > 0) m.set(k, { wr: b.hits / b.total, n: b.total });
        }
        if (!cancelled) setRef4ByTier(m);
      } catch {
        // soft-fail
      }
    })();
    return () => { cancelled = true; };
  }, [session?.access_token]);

  // Most-recent snapshot date in the dataset
  const latestDate = useMemo(() => {
    if (!rows.length) return null;
    return rows.reduce((max, r) => r.snapshot_date > max ? r.snapshot_date : max, rows[0].snapshot_date);
  }, [rows]);

  // Filter to latest snapshot for the active window
  const latestRows = useMemo(
    () => rows.filter(r => r.snapshot_date === latestDate && r.window_type === activeWindow),
    [rows, latestDate, activeWindow],
  );

  const overall = useMemo(
    () => latestRows.find(r => r.metric_type === "overall"),
    [latestRows],
  );

  const tierRows = useMemo(
    () => latestRows
      .filter(r => r.metric_type === "tier")
      .sort((a, b) => tierOrder(a.metric_key) - tierOrder(b.metric_key)),
    [latestRows],
  );

  const propRows = useMemo(
    () => latestRows
      .filter(r => r.metric_type === "prop_type")
      .sort((a, b) => b.bets_resolved - a.bets_resolved),
    [latestRows],
  );

  const factorRows = useMemo(
    () => latestRows
      .filter(r => r.metric_type === "factor_presence")
      .sort((a, b) => b.bets_resolved - a.bets_resolved),
    [latestRows],
  );

  // 30-day trend — overall hit_rate per snapshot_date, active window
  const trendData = useMemo(() => {
    return rows
      .filter(r => r.window_type === activeWindow && r.metric_type === "overall" && r.hit_rate != null)
      .map(r => ({
        date: r.snapshot_date,
        hit_rate_pct: r.hit_rate != null ? Number((r.hit_rate * 100).toFixed(2)) : null,
        bets: r.bets_resolved,
      }))
      .sort((a, b) => a.date < b.date ? -1 : 1);
  }, [rows, activeWindow]);

  if (loading) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Calibration</h2>
        <p className="text-sm text-zinc-500 mt-2">Loading…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Calibration</h2>
        <p className="text-sm text-red-400 mt-2">Error loading calibration data: {error}</p>
      </section>
    );
  }

  if (!rows.length || !overall) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Calibration</h2>
        <p className="text-sm text-zinc-500 mt-2">No calibration snapshots yet. First daily snapshot lands at 11:15 UTC.</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Calibration</h2>
          <p className="text-xs text-zinc-500 mt-1">
            Real-money hit rate vs algorithm confidence. Snapshot {latestDate}.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
          {(["rolling_7d", "rolling_30d", "all_time"] as WindowType[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setActiveWindow(w)}
              className={
                "px-2 py-1 text-xs rounded-md " +
                (activeWindow === w
                  ? "bg-emerald-600 text-white"
                  : "text-zinc-300 hover:bg-zinc-800")
              }
            >
              {w === "rolling_7d" ? "7d" : w === "rolling_30d" ? "30d" : "All time"}
            </button>
          ))}
        </div>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs text-zinc-500">Real-money win rate</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1">
            {pctFmt(overall.hit_rate)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {overall.bets_hit}/{overall.bets_resolved} resolved bets
          </div>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs text-zinc-500">Avg confidence</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1">
            {overall.avg_confidence != null ? overall.avg_confidence.toFixed(1) : "—"}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            confidence units (0–100)
          </div>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs text-zinc-500">Sample size</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1">
            {overall.bets_count}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            bets in window
            {overall.sample_size_warning && (
              <span className="ml-2 inline-flex items-center rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-900/60">
                low sample
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tier table */}
      {tierRows.length > 0 && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">By confidence tier (vs synthetic backtest reference)</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-zinc-500 border-b border-zinc-800">
                <tr>
                  <th className="text-left py-1 pr-3">Tier</th>
                  <th className="text-right py-1 pr-3">Bets</th>
                  <th className="text-right py-1 pr-3">Resolved</th>
                  <th className="text-right py-1 pr-3">Hit rate</th>
                  <th className="text-right py-1 pr-3" title="Reference #2 per §15.7.8 — synthetic backtest on unfiltered 12,497-row corpus (D-111 era).">Backtest #2</th>
                  <th className="text-right py-1 pr-3" title="Reference #4 per §15.7.8 — synthetic backtest on post-megadeploy organic-resolved corpus. Honest apples-to-apples comparison vs real-money.">Backtest #4</th>
                  <th className="text-right py-1 pr-3">Δ vs #4</th>
                  <th className="text-right py-1 pr-3">Δ vs implied</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {tierRows.map((r) => {
                  // Tier 1 #7: reference #4 is the honest apples-to-apples
                  // comparison. Computed inline above; falls back to "—"
                  // when the post-May-4 synthetic cohort has no rows in
                  // this tier. Δ vs #4 = real hit rate − reference #4 WR.
                  const ref4 = ref4ByTier.get(r.metric_key);
                  const ref4Wr = ref4?.wr ?? null;
                  const ref4N = ref4?.n ?? null;
                  const ref4LowSample = ref4N != null && ref4N < 30;
                  const ref4Delta =
                    r.hit_rate != null && ref4Wr != null
                      ? r.hit_rate - ref4Wr
                      : null;
                  return (
                    <tr key={r.id} className="border-b border-zinc-900">
                      <td className="py-1 pr-3 font-medium">
                        {r.metric_key}
                        {r.sample_size_warning && (
                          <span className="ml-2 inline-flex items-center rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-900/60">
                            low sample
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3 text-right">{r.bets_count}</td>
                      <td className="py-1 pr-3 text-right">{r.bets_resolved}</td>
                      <td className="py-1 pr-3 text-right">{pctFmt(r.hit_rate)}</td>
                      <td className="py-1 pr-3 text-right text-zinc-500">{pctFmt(r.backtest_hit_rate)}</td>
                      <td className="py-1 pr-3 text-right">
                        {pctFmt(ref4Wr)}
                        {ref4N != null && (
                          <span className="ml-1 text-[10px] text-zinc-500">(n={ref4N}{ref4LowSample ? "*" : ""})</span>
                        )}
                      </td>
                      <td className={
                        "py-1 pr-3 text-right " +
                        (ref4Delta == null ? "" : ref4Delta >= 0 ? "text-emerald-400" : "text-red-400")
                      }>
                        {deltaPctFmt(ref4Delta)}
                      </td>
                      <td className={
                        "py-1 pr-3 text-right " +
                        (r.calibration_delta == null ? "" : r.calibration_delta >= 0 ? "text-emerald-400" : "text-red-400")
                      }>
                        {deltaPctFmt(r.calibration_delta)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-zinc-500 mt-1">
            <span className="text-zinc-300">Backtest #2</span> (gray) = synthetic on unfiltered 12,497-row corpus (D-111). De-emphasized because §15.7.8 flagged it as apples-to-oranges vs real-money.
            <br />
            <span className="text-zinc-300">Backtest #4</span> = synthetic on post-megadeploy organic-resolved corpus. The honest reference. <span className="text-zinc-400">*</span> marks tiers with n &lt; 30 (below D-118 sample-size threshold).
            <br />
            <span className="text-zinc-300">Δ vs #4</span> = real hit rate − reference #4 WR. <span className="text-zinc-300">Δ vs implied</span> = real hit rate − (avg_confidence/100). Negative = algorithm overconfident.
          </p>
        </div>
      )}

      {/* Prop type breakdown */}
      {propRows.length > 0 && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">By prop type</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-zinc-500 border-b border-zinc-800">
                <tr>
                  <th className="text-left py-1 pr-3">Prop</th>
                  <th className="text-right py-1 pr-3">Resolved</th>
                  <th className="text-right py-1 pr-3">Hit rate</th>
                  <th className="text-right py-1 pr-3">Avg conf</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {propRows.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-900">
                    <td className="py-1 pr-3 font-medium">
                      {r.metric_key}
                      {r.sample_size_warning && (
                        <span className="ml-2 inline-flex items-center rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-900/60">
                          low
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3 text-right">{r.bets_resolved}</td>
                    <td className="py-1 pr-3 text-right">{pctFmt(r.hit_rate)}</td>
                    <td className="py-1 pr-3 text-right">
                      {r.avg_confidence != null ? r.avg_confidence.toFixed(1) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Factor presence */}
      {factorRows.length > 0 && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">By factor presence</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="text-zinc-500 border-b border-zinc-800">
                <tr>
                  <th className="text-left py-1 pr-3">Factor presence</th>
                  <th className="text-right py-1 pr-3">Resolved</th>
                  <th className="text-right py-1 pr-3">Hit rate</th>
                  <th className="text-right py-1 pr-3">Avg conf</th>
                </tr>
              </thead>
              <tbody className="text-zinc-200">
                {factorRows.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-900">
                    <td className="py-1 pr-3 font-medium">
                      {r.metric_key}
                      {r.sample_size_warning && (
                        <span className="ml-2 inline-flex items-center rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-900/60">
                          low
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3 text-right">{r.bets_resolved}</td>
                    <td className="py-1 pr-3 text-right">{pctFmt(r.hit_rate)}</td>
                    <td className="py-1 pr-3 text-right">
                      {r.avg_confidence != null ? r.avg_confidence.toFixed(1) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Trend chart */}
      {trendData.length > 1 && (
        <div>
          <div className="text-xs text-zinc-400 mb-1">Hit-rate trend ({activeWindow.replace("_", " ")})</div>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                <XAxis dataKey="date" tick={{ fill: "#a1a1aa", fontSize: 10 }} />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "#a1a1aa", fontSize: 10 }}
                  label={{ value: "%", angle: 0, position: "insideTopLeft", fill: "#71717a", fontSize: 10 }}
                />
                <Tooltip
                  contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 12 }}
                  labelStyle={{ color: "#a1a1aa" }}
                  formatter={((val: unknown, name: unknown) => {
                    if (name === "hit_rate_pct") {
                      const num = typeof val === "number" ? val : Number(val);
                      return [Number.isFinite(num) ? `${num.toFixed(1)}%` : String(val), "Hit rate"];
                    }
                    return [String(val ?? ""), String(name ?? "")];
                  }) as never}
                />
                <Line
                  type="monotone"
                  dataKey="hit_rate_pct"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={{ r: 3, fill: "#10b981" }}
                  name="hit_rate_pct"
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <p className="text-[11px] text-zinc-500">
        Snapshot written daily at 11:15 UTC by cron jobid 13. Bootstrap-populated May 7-11. Backtest #2 from 12,497-row synthetic corpus (D-111, May 8 era). Backtest #4 queried inline from pick_history filtered to post-megadeploy synthetic resolved (Tier 1 #7 shipped May 13). Sample-size warning fires below 30 resolved bets per bucket.
      </p>
    </section>
  );
}
