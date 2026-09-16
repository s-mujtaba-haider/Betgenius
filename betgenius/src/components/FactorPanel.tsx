// D-655 SHIP 1 — Universal 3-bucket factor panel.
//
// One shared renderer for every market (props, sides, totals, all sports).
// Splits factors into firing / evaluated-no-tilt / not-in-breakdown so
// a 0 is information ("evaluated, no tilt") and a missing key is
// surfaced honestly ("not in breakdown" — pre-v3 cached pick or silent gap).
//
// D-676 — added optional `marketCols` filter so each market's card shows
// ONLY its own emitted factor cols. Pre-D-676 the panel iterated ALL global
// FACTOR_LABELS (~120 entries) against every pick, so a pitcher_outs card
// counted NBA + batter labels as "missing." When marketCols is provided,
// labels are filtered to only those present in the set before bucketing.
//
// Caller passes:
//   - labels: ordered list of { col, label }
//   - lookup: function (col) => unknown — returns the value from whatever
//     data source the caller has (rec.scores for Dashboard, breakdown JSONB
//     for Games, etc.).
//   - marketCols (D-676 optional): list of col names that THIS pick's market
//     actually emits. When provided, labels are pre-filtered to that set so
//     "missing" counts only the market's own gaps, never other markets' cols.

import { useState } from "react";

export interface FactorLabel { col: string; label: string }

export type FactorLookup = (col: string) => unknown;

interface BucketedFactor { label: string; value: number }
interface MissingFactor { label: string; value: null }

export function bucketFactors(
  labels: ReadonlyArray<FactorLabel>,
  lookup: FactorLookup,
): { firing: BucketedFactor[]; zero: BucketedFactor[]; missing: MissingFactor[] } {
  const firing: BucketedFactor[] = [];
  const zero: BucketedFactor[] = [];
  const missing: MissingFactor[] = [];
  for (const f of labels) {
    const raw = lookup(f.col);
    if (raw === null || raw === undefined) {
      missing.push({ label: f.label, value: null });
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) {
      missing.push({ label: f.label, value: null });
    } else if (n === 0) {
      zero.push({ label: f.label, value: 0 });
    } else {
      firing.push({ label: f.label, value: n });
    }
  }
  return { firing, zero, missing };
}

interface FactorPanelProps {
  labels: ReadonlyArray<FactorLabel>;
  lookup: FactorLookup;
  /** Top border style. Defaults to dashed separator. */
  className?: string;
  /** D-676 — optional per-market filter. When provided, only labels whose
   *  col is in this list are bucketed (filters out other markets' factors
   *  from the "missing" count). When omitted, all labels are bucketed
   *  (legacy NBA / unknown-market path). */
  marketCols?: ReadonlyArray<string>;
}

export function FactorPanel({ labels, lookup, className = "", marketCols }: FactorPanelProps) {
  const [open, setOpen] = useState(false);
  // D-676 — filter labels to the current market's emitted cols before bucketing.
  const filteredLabels = marketCols
    ? labels.filter((l) => marketCols.includes(l.col))
    : labels;
  const buckets = bucketFactors(filteredLabels, lookup);
  const hasAny = buckets.firing.length > 0 || buckets.zero.length > 0 || buckets.missing.length > 0;
  if (!hasAny) return null;

  return (
    <div className={className}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        <span>
          Show factors ({buckets.firing.length} firing
          {buckets.zero.length > 0 ? `, ${buckets.zero.length} at 0` : ""}
          {buckets.missing.length > 0 ? `, ${buckets.missing.length} missing` : ""}
          )
        </span>
        <span className="text-zinc-500">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-2.5 text-[11px]">
          {/* firing */}
          {buckets.firing.length > 0 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {buckets.firing.map((r) => {
                const color = r.value > 0 ? "text-emerald-400" : "text-red-400";
                return (
                  <div key={r.label} className="flex items-baseline justify-between gap-2">
                    <span className="text-zinc-400 truncate" title={r.label}>{r.label}</span>
                    <span className={`font-semibold tabular-nums ${color}`}>
                      {r.value > 0 ? "+" : ""}{r.value}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {/* evaluated, no tilt */}
          {buckets.zero.length > 0 && (
            <>
              <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide text-zinc-600">
                evaluated, no tilt
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 opacity-60">
                {buckets.zero.map((r) => (
                  <div key={r.label} className="flex items-baseline justify-between gap-2">
                    <span className="text-zinc-500 truncate" title={r.label}>{r.label}</span>
                    <span className="tabular-nums text-zinc-500">0</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {/* not in breakdown */}
          {buckets.missing.length > 0 && (
            <>
              <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide text-amber-600/70">
                not in breakdown (pre-v3 pick or silent gap)
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 opacity-50">
                {buckets.missing.map((r) => (
                  <div key={r.label} className="flex items-baseline justify-between gap-2">
                    <span className="text-zinc-500 truncate" title={r.label}>{r.label}</span>
                    <span className="tabular-nums text-zinc-600">—</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
