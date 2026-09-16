// SelectionBiasSection — D-141 Tier 1 #6 H5 selection bias tracking.
// May 13, 2026.
//
// Compares hit rate between bets CEO placed vs algorithm picks CEO skipped,
// per confidence tier. Discoverable WR signal with zero algorithm changes:
//   - bet_set_wr < skip_set_wr  → negative selection (CEO picks worse than
//     algorithm's recommendations on average — stop overriding)
//   - bet_set_wr > skip_set_wr  → positive selection (CEO filters noise the
//     algorithm misses — keep selecting)
//   - bet_set_wr ≈ skip_set_wr  → no signal (algorithm-only is just as good)
//
// Pattern mirrors CalibrationSection's Tier 1 #7 reference #4 inline query
// (commit 48d5d38, D-134). Inline fetch, no calibration_snapshots write,
// no new DB artifact. Two PostgREST GETs aggregated client-side.
//
// RLS: bets table is per-user (user_id = auth.uid()). pick_history is
// readable by any authenticated user. The Authorization header carries
// session.access_token so RLS evaluates as the logged-in CEO — bet rows
// returned are only CEO's bets, naturally per-user-scoped.
//
// Sample-size threshold: 15 (smaller than calibration's 30 because
// selection-bias subsets are inherently smaller — bet_set per tier may
// only be a handful of bets while overall calibration counts include
// the full algorithm output).

import { useEffect, useMemo, useState } from "react";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { useAuthSession } from "@/lib/auth";

interface PickRow { id: string; confidence: number; hit: boolean }
interface BetRow  { pick_id: string }

interface TierStat {
  tier: string;
  bet_n: number;
  bet_hits: number;
  bet_wr: number | null;
  skip_n: number;
  skip_hits: number;
  skip_wr: number | null;
  delta: number | null;
}

const TIERS: Array<{ key: string; min: number; max: number }> = [
  { key: "90+",   min: 90, max: 101 },
  { key: "80-89", min: 80, max: 90 },
  { key: "70-79", min: 70, max: 80 },
  { key: "60-69", min: 60, max: 70 },
];

const LOW_SAMPLE_THRESHOLD = 15;

function tierFor(c: number): string | null {
  for (const t of TIERS) {
    if (c >= t.min && c < t.max) return t.key;
  }
  return null;
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

export default function SelectionBiasSection() {
  const { session } = useAuthSession();
  const [stats, setStats] = useState<TierStat[]>([]);
  const [totals, setTotals] = useState<{ bet_n: number; skip_n: number; bet_wr: number | null; skip_wr: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const headers = {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        };

        // (1) Algorithm picks: post-megadeploy organic resolved.
        // Matches reference #4 filter (D-134 / Tier 1 #7) but on the
        // process-games organic corpus rather than synthetic backfill.
        // D-149 (May 13, 2026): added &order=game_date.desc + &limit=5000
        // to prevent PostgREST default 1000-row cap from silently
        // truncating selection-bias math once post-May-4 organic pick
        // volume exceeds 1000. Surfaced by D-148 v2 audit Finding #4.
        // 5000 cap chosen for headroom through season end (~150/day ×
        // 21 days remaining Finals = ~3150 + buffer).
        const picksUrl =
          `${SUPABASE_URL}/rest/v1/pick_history` +
          `?source=eq.process-games&is_synthetic=eq.false` +
          `&game_date=gte.2026-05-04` +
          `&hit=not.is.null&voided=eq.false` +
          `&select=id,confidence,hit` +
          `&order=game_date.desc&limit=5000`;

        // (2) Bets: post-May-7 (CEO's H5 window), settled, with pick_id linkage.
        // RLS filters to CEO's own bets via session.access_token.
        // D-149 (May 13, 2026): added &order=placed_at.desc + &limit=5000
        // for the same reason as picksUrl above. Bet volume is much lower
        // than pick volume (CEO bets ~5-20/day, not all algorithm picks),
        // so truncation risk here is lower — but the discipline applies
        // uniformly to both queries to prevent future regression.
        const betsUrl =
          `${SUPABASE_URL}/rest/v1/bets` +
          `?placed_at=gte.2026-05-07` +
          `&status=in.(won,lost)` +
          `&pick_id=not.is.null` +
          `&select=pick_id` +
          `&order=placed_at.desc&limit=5000`;

        const [picksRes, betsRes] = await Promise.all([
          fetch(picksUrl, { headers }),
          fetch(betsUrl, { headers }),
        ]);
        if (!picksRes.ok) throw new Error(`pick_history HTTP ${picksRes.status}`);
        if (!betsRes.ok)  throw new Error(`bets HTTP ${betsRes.status}`);

        const picks = (await picksRes.json()) as PickRow[];
        const bets  = (await betsRes.json()) as BetRow[];

        const betPickIds = new Set(bets.map(b => b.pick_id));

        type Bucket = { hits: number; total: number };
        const empty = (): Bucket => ({ hits: 0, total: 0 });
        const betBuckets:  Record<string, Bucket> = Object.fromEntries(TIERS.map(t => [t.key, empty()]));
        const skipBuckets: Record<string, Bucket> = Object.fromEntries(TIERS.map(t => [t.key, empty()]));
        let totalBet: Bucket = empty();
        let totalSkip: Bucket = empty();

        for (const p of picks) {
          const t = tierFor(p.confidence);
          if (!t) continue;
          const isBet = betPickIds.has(p.id);
          const bucket = isBet ? betBuckets[t] : skipBuckets[t];
          const totalBucket = isBet ? totalBet : totalSkip;
          bucket.total += 1;
          totalBucket.total += 1;
          if (p.hit) {
            bucket.hits += 1;
            totalBucket.hits += 1;
          }
        }

        const tierStats: TierStat[] = TIERS.map(t => {
          const b = betBuckets[t.key];
          const s = skipBuckets[t.key];
          const bWr = b.total > 0 ? b.hits / b.total : null;
          const sWr = s.total > 0 ? s.hits / s.total : null;
          const delta = bWr != null && sWr != null ? bWr - sWr : null;
          return {
            tier: t.key,
            bet_n: b.total, bet_hits: b.hits, bet_wr: bWr,
            skip_n: s.total, skip_hits: s.hits, skip_wr: sWr,
            delta,
          };
        });

        if (!cancelled) {
          setStats(tierStats);
          setTotals({
            bet_n: totalBet.total,
            skip_n: totalSkip.total,
            bet_wr: totalBet.total > 0 ? totalBet.hits / totalBet.total : null,
            skip_wr: totalSkip.total > 0 ? totalSkip.hits / totalSkip.total : null,
          });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [session?.access_token]);

  const overallDelta = useMemo(() => {
    if (!totals || totals.bet_wr == null || totals.skip_wr == null) return null;
    return totals.bet_wr - totals.skip_wr;
  }, [totals]);

  if (loading) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Selection Bias (Tier 1 #6)</h2>
        <p className="text-sm text-zinc-500 mt-2">Loading…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Selection Bias (Tier 1 #6)</h2>
        <p className="text-sm text-red-400 mt-2">Error loading selection-bias data: {error}</p>
      </section>
    );
  }

  if (!totals || totals.bet_n === 0) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="text-base font-semibold text-zinc-100">Selection Bias (Tier 1 #6)</h2>
        <p className="text-sm text-zinc-500 mt-2">
          No post-May-7 bets with pick_id linkage yet. Section will populate
          automatically once bets accumulate (~30 settled bets recommended
          for meaningful tier-level signal).
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">Selection Bias (Tier 1 #6)</h2>
        <p className="text-xs text-zinc-500 mt-1">
          Hit rate of bets you placed vs algorithm picks you skipped, per
          confidence tier. Post-megadeploy organic resolved (game_date ≥
          May 4). Bets filtered to placed_at ≥ May 7.
        </p>
      </div>

      {/* Headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs text-zinc-500">Bets you placed</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1">
            {pctFmt(totals.bet_wr)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {totals.bet_n} picks
            {totals.bet_n < LOW_SAMPLE_THRESHOLD && (
              <span className="ml-2 inline-flex items-center rounded bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-900/60">
                low sample
              </span>
            )}
          </div>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs text-zinc-500">Picks you skipped</div>
          <div className="text-2xl font-semibold text-zinc-100 mt-1">
            {pctFmt(totals.skip_wr)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {totals.skip_n} picks
          </div>
        </div>
        <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="text-xs text-zinc-500">Δ (bet − skip)</div>
          <div className={
            "text-2xl font-semibold mt-1 " +
            (overallDelta == null ? "text-zinc-100" : overallDelta >= 0 ? "text-emerald-400" : "text-red-400")
          }>
            {deltaPctFmt(overallDelta)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">
            {overallDelta == null
              ? "insufficient data"
              : overallDelta >= 0 ? "positive selection" : "negative selection"}
          </div>
        </div>
      </div>

      {/* Per-tier table */}
      <div>
        <div className="text-xs text-zinc-400 mb-1">By confidence tier</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="text-zinc-500 border-b border-zinc-800">
              <tr>
                <th className="text-left py-1 pr-3">Tier</th>
                <th className="text-right py-1 pr-3" title="Bets you placed in this tier (settled, pick_id linked).">Bet-set WR</th>
                <th className="text-right py-1 pr-3" title="Algorithm picks in this tier that you did NOT bet.">Skip-set WR</th>
                <th className="text-right py-1 pr-3" title="Bet-set WR minus skip-set WR. Positive = good selection; negative = bad selection.">Δ</th>
              </tr>
            </thead>
            <tbody className="text-zinc-200">
              {stats.map((s) => {
                const betLow  = s.bet_n  > 0 && s.bet_n  < LOW_SAMPLE_THRESHOLD;
                const skipLow = s.skip_n > 0 && s.skip_n < LOW_SAMPLE_THRESHOLD;
                return (
                  <tr key={s.tier} className="border-b border-zinc-900">
                    <td className="py-1 pr-3 font-medium">{s.tier}</td>
                    <td className="py-1 pr-3 text-right">
                      {pctFmt(s.bet_wr)}
                      <span className="ml-1 text-[10px] text-zinc-500">
                        (n={s.bet_n}{betLow ? "*" : ""})
                      </span>
                    </td>
                    <td className="py-1 pr-3 text-right">
                      {pctFmt(s.skip_wr)}
                      <span className="ml-1 text-[10px] text-zinc-500">
                        (n={s.skip_n}{skipLow ? "*" : ""})
                      </span>
                    </td>
                    <td className={
                      "py-1 pr-3 text-right " +
                      (s.delta == null ? "" : s.delta >= 0 ? "text-emerald-400" : "text-red-400")
                    }>
                      {deltaPctFmt(s.delta)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-zinc-500 mt-1">
          <span className="text-zinc-300">Bet-set WR</span> = hit rate on the algorithm picks you chose to bet.
          <span className="text-zinc-300"> Skip-set WR</span> = hit rate on algorithm picks you did NOT bet.
          <span className="text-zinc-300"> Δ</span> = bet − skip. <span className="text-emerald-400">Positive</span> means your selection beats the algorithm's recommendations on average (positive selection — keep selecting); <span className="text-red-400">negative</span> means you're picking worse than random within the algorithm's output (negative selection — stop overriding). <span className="text-zinc-400">*</span> marks tiers with n &lt; {LOW_SAMPLE_THRESHOLD}.
        </p>
      </div>
    </section>
  );
}
