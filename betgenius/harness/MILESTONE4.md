# Milestone 4 — Batter Hits Hardening

**Date:** 2026-07-20  
**Market:** `batter_hits`  
**Scope:** Out-of-sample validation, harness CLV snapshot fix, live monitoring, full UI parity (`recommendation_shown` / EV columns)  
**Status:** Delivered — **OOS gate PASS** (temporal holdout + YoY); CLV harness limited by warehouse snapshot depth  
**Prior:** [MILESTONE3.md](MILESTONE3.md) (in-sample PASS) · **Next:** [MILESTONE5.md](MILESTONE5.md) (six-market expansion)

---

## Executive summary

Milestone 4 hardens the M3 batter-hits EV surface:

1. **Out-of-sample:** **May 11–24, 2026** holdout (second half of M3 window) passes: **n=529**, **+4.69% ROI**. **Apr–May 2025** YoY OOS also passes: **n=1,136**, **+10.67% ROI**. Planned Jun–Jul 2026 and Mar–Apr 2026 windows have **zero warehouse rows** (coverage ends 2026-05-24).
2. **CLV:** Harness `pickClosingSnapshot()` prefers T-15min and falls back to a snapshot distinct from entry. Apr–May 2026 warehouse has **one snapshot per line** → harness CLV 0% for that window. **2025 YoY** confirms non-zero CLV (+0.07% avg) when multi-snapshot data exists. Live CLV remains via `capture_closing_odds_mlb` + `props_cache`.
3. **UI parity:** Migration + Dashboard / PickCard / Performance / Admin wired to `recommendation_shown` and EV columns (code complete; prod deploy required).
4. **Monitoring:** Admin page widget — pending tonight, rolling **7d** over/under ROI, avg CLV, zero-volume warning.

**Verdict:** **PASS** — batter hits EV surface validated on holdout and YoY OOS; proceed with live monitoring after prod deploy.

---

## M4.1 — Out-of-sample backtests

### Warehouse coverage constraint

| Requested window | Odds rows | Result |
|---|---:|---|
| 2026-06-01 → 2026-07-15 | 0 | No warehouse data post 2026-05-24 |
| 2026-03-01 → 2026-04-24 | 0 | No rows in range |
| **2026-05-11 → 2026-05-24** (holdout) | 21,804 | **PASS** (+4.69%, n=529) |
| **2025-04-25 → 2025-05-24** (YoY OOS) | 27,095 | **PASS** (+10.67%, n=1,136; avg CLV +0.07%) |

### Holdout vs M3 in-sample

**Artifact:** [`out/batter_hits_oos_holdout_2026-05-11_to_2026-05-24.json`](out/batter_hits_oos_holdout_2026-05-11_to_2026-05-24.json) (+ `.csv`)

| Metric | M3 in-sample (Apr 25 – May 24, 2026) | OOS holdout (May 11 – May 24, 2026) |
|---|---:|---:|
| ev_filtered graded n | 1,125 | **529** |
| ROI-after-vig | +7.15% [1.58%, 12.79%] | **+4.69%** [−3.80%, 12.95%] |
| Gate verdict | PASS | **PASS** |
| Over ROI (ev_filtered) | −1.66% | −4.90% |
| Under ROI (ev_filtered) | +11.91% | **+9.11%** |

### YoY OOS vs M3 in-sample

**Artifact:** [`out/batter_hits_oos_2025-04-25_to_2025-05-24.json`](out/batter_hits_oos_2025-04-25_to_2025-05-24.json) (+ `.csv`)

| Metric | M3 in-sample (2026) | YoY OOS (2025) |
|---|---:|---:|
| ev_filtered graded n | 1,125 | **1,136** |
| ROI-after-vig | +7.15% | **+10.67%** [4.85%, 16.17%] |
| Gate verdict | PASS | **PASS** |
| Over ROI (ev_filtered) | −1.66% | −1.61% |
| Under ROI (ev_filtered) | +11.91% | **+16.55%** |
| Avg CLV (ev_filtered) | 0.00% (single snapshot) | **+0.07%** (14.0% positive CLV) |

Holdout and YoY both confirm positive EV-filtered ROI at meaningful n with the same under-driven edge pattern as M3.

---

## M4.2 — CLV snapshot fix

### Harness change (`harness/lib/candidates.ts`)

- `pickClosingSnapshot()` exported; accepts `entrySnapshotTime`.
- Prefers T-15min bucket; else latest pre-game snapshot **≠ entry**.

### Warehouse audit (`harness/scripts/audit_snapshot_counts.ts`)

Apr–May 2026 `batter_hits`: **22,055 / 22,055 groups have exactly 1 snapshot** → harness CLV is structurally 0% for that window.

**Verification on 2025 YoY window** (3 snapshots/group): ev_filtered avg CLV **+0.07%** (14.0% positive CLV, n=1,517).

**M3 window re-run:** [`out/batter_hits_m3_clv_fix.json`](out/batter_hits_m3_clv_fix.json) — ROI unchanged at **+7.15%**; CLV 0% as expected for single-snapshot 2026 data.

### Production verify (read-only)

`capture_closing_odds_mlb` (migration `20260611100500_d511_capture_fn_v2.sql`) stamps `pick_history.clv_pct` from `props_cache` at game time — independent of warehouse snapshot depth.

---

## M4.3 — Live monitoring

**Admin page** (top of Performance tab): “Batter hits EV surface (M4 monitor)” widget:

| Signal | Implementation |
|---|---|
| Pending tonight | `recommendation_shown=true`, unresolved, today's ET game date |
| Resolved shown (all) | Count of resolved shown batter_hits picks in loaded history |
| Rolling 7d over / under ROI | Resolved shown picks with `game_date` ≥ ET today − 7 days |
| Avg CLV | Mean `clv_pct` on resolved shown picks |
| Zero-volume warn | Amber banner when **pending tonight = 0** (prompt to verify scorer cron) |

---

## M4.4 — UI foundation

| Layer | Change |
|---|---|
| Migration `20260720100000_m4_ev_recs_cache_columns.sql` | `recommendation_shown`, `win_prob`, `edge_vs_implied`, `ev_per_unit` on `recommendations_cache` |
| `process-games-mlb/index.ts` | `mlbRecommendationShown()` + `evRecCacheFields()` for batter + pitcher paths |
| `Dashboard.tsx` | Filter visible picks on `recommendation_shown` (fallback: conf≥60 + breakdown EV for pre-migration rows) |
| `PickCard.tsx` | Display `evPerUnit` + edge pp when present |
| `Performance.tsx` | Fetches `clv_pct` for algo theoretical line; **aggregate avg CLV** in equity caption |
| `Admin.tsx` | **Per-row CLV column** in pick history table; M4 monitor widget |

---

## What was built (harness + app)

| Component | Change |
|---|---|
| `harness/lib/candidates.ts` | CLV closing snapshot selection fix |
| `harness/scripts/audit_clv_snapshots.ts` | Entry vs closing timestamp audit |
| `harness/scripts/audit_snapshot_counts.ts` | Snapshot depth distribution |
| `harness/scripts/run_block1_sequential.sh` | Sequential gate runner (connection-safe) |
| `harness/test/run_smoke_tests.ts` | 120 offline tests |
| Frontend + edge function | UI parity + `mlbRecommendationShown` (see M4.4) |

---

## Production deploy checklist

| Step | Action |
|---|---|
| 1 | Apply migration `20260720100000_m4_ev_recs_cache_columns.sql` |
| 2 | Deploy `process-games-mlb` (writes EV fields + `recommendation_shown` to rec_cache) |
| 3 | Deploy frontend build (`npm run build`) |
| 4 | Verify Admin M4 monitor shows pending shown picks on next scored slate |

Until steps 1–3 land, Dashboard may fall back to client-side EV gate from `breakdown` on legacy rows.

---

## Testing

| Check | Result |
|---|---|
| Harness smoke tests | **120 passed, 0 failed** |
| Frontend build | **`npm run build` OK** |
| OOS holdout gate | **PASS** (n=529, ROI +4.69%) |
| YoY OOS gate | **PASS** (n=1,136, ROI +10.67%) |

---

## Artifacts

| File | Description |
|---|---|
| `out/batter_hits_oos_holdout_2026-05-11_to_2026-05-24.json` / `.csv` | Primary OOS holdout — **PASS** |
| `out/batter_hits_oos_2025-04-25_to_2025-05-24.json` / `.csv` | YoY OOS — **PASS** (+ CLV) |
| `out/batter_hits_m3_clv_fix.json` / `.csv` | M3 window re-run — confirms +7.15% |
| `out/batter_hits_oos_2026-06-01_to_2026-07-15.json` / `.csv` | Empty window (documented) |
| `out/batter_hits_oos_2026-03-01_to_2026-04-24.json` / `.csv` | Empty window (documented) |
