// D-487 (2026-06-08) — Unified pick_history writer.
//
// Canonical pick_history writer. Used by every production scorer that writes
// to pick_history. Centralizes:
//   (a) client-side validation against the constraint set (D-204 + D-446 + D-481),
//   (b) the POST to upsert_pick_history RPC,
//   (c) best-effort structured error logging (does NOT block the write).
//
// CRITICAL: any constraint change to pick_history must update
// ALLOWED_MLB_MARKET_TYPES + REQUIRED_FIELDS here. The DB constraints are the
// authoritative source; this helper mirrors them client-side so we catch
// violations at HOUR 0 (the validate call) instead of at HOUR 1 via the
// D-481 rpc_failed_rate alert (which is the second-line server-side defense).
//
// Defense-in-depth:
//   - HOUR 0: this helper's validatePayload (catches bad market_type before
//     the RPC round-trip, returns CLIENT_VALIDATION error)
//   - ALWAYS: Postgres CHECK + ON CONFLICT constraints (D-204 / D-446 / D-481)
//     reject server-side as last-line defense
//   - HOUR 1: D-481 rpc_failed_rate check on `error_log WHERE error_type=rpc_failed`
//
// Migration scope (D-487 NBA-first staged rollout per d486_write_path_design.md):
//   STAGE 1 (D-487 SHIP 1): create this file + unit-test validatePayload
//   STAGE 2 (D-487 SHIP 2): migrate process-games (NBA cron) ← THIS BATCH
//   STAGE 3 (later, after 7d NBA-watch): migrate process-games-mlb
//   STAGE 4 (later): migrate analyze-pick
//   STAGE 5 (later): add D-459 sibling check `pick_history_validation_failed_rate`

// =====================================================================
// CANONICAL CONSTRAINT MIRROR — must match D-204 + D-481 server-side CHECK.
// =====================================================================
const ALLOWED_MLB_MARKET_TYPES: ReadonlySet<string> = new Set([
  // D-204 originals (2026-05-17):
  "pitcher_k", "batter_hits", "batter_hr", "batter_total_bases",
  "batter_rbis", "game_side", "game_total",
  // D-474 / D-475 / D-476 additions (2026-06-07):
  "batter_strikeouts", "batter_runs_scored", "pitcher_outs",
]);

// REQUIRED (NOT NULL) columns on pick_history that the writer is responsible
// for populating. Mirrors the table's NOT NULL constraints.
const REQUIRED_FIELDS: readonly (keyof PickHistoryPayload)[] = [
  "player_name", "prop_type", "line", "pick_side", "odds",
  "confidence", "verdict", "sport",
] as const;

// D-529 (T5 fix) — per-field runtime type expectation. The TS interface
// declares these types statically, but the writer is called from JS-like
// untyped paths (e.g., D-528 found NBA `process-games/index.ts:2580` uses
// `as unknown as` to defeat the type check). At runtime any of these could
// arrive as the wrong primitive (string for number, etc.) and the prior
// `typeof === "number" && range-check` short-circuited silently when the
// type was wrong. Now we LOUDLY reject wrong primitive types up-front so
// the bad value can't reach the RPC.
const REQUIRED_FIELD_TYPES: Record<string, "string" | "number"> = {
  player_name: "string",
  prop_type:   "string",
  line:        "number",
  pick_side:   "string",
  odds:        "number",
  confidence:  "number",
  verdict:     "string",
  sport:       "string",
};

// =====================================================================
// PAYLOAD + RESULT TYPES
// =====================================================================
export interface PickHistoryPayload {
  // REQUIRED (NOT NULL columns)
  player_name: string;
  // D-723: optional durable integer key. When set on the payload, gets written
  // by upsert_pick_history (D-723 RPC). When omitted on an MLB pick,
  // writePickHistory auto-resolves it from the prefetched
  // cache_mlb_player_metadata unique-map below (ambiguous names like Max Muncy
  // are left null by the HAVING COUNT(DISTINCT player_id)=1 guard).
  player_id?: number | null;
  prop_type: string;
  line: number;
  pick_side: string;
  odds: number;
  confidence: number;
  verdict: string;
  sport: "nba" | "mlb";

  // CONSTRAINED (mlb_market_type CHECK constraint per D-204 + D-481).
  // Permitted to be null/omitted (NBA picks have mlb_market_type=NULL).
  mlb_market_type?: string | null;
  is_mlb_beta?: boolean;

  // OPTIONAL canonical fields (any pick_history column).
  team?: string | null;
  opponent?: string | null;
  game_time?: string;
  game_date?: string;
  is_home?: boolean | null;

  // permit additional fields the RPC will accept via jsonb_populate_record
  [k: string]: unknown;
}

export type WriteResult =
  | { ok: true }
  | { ok: false; code: "CLIENT_VALIDATION"; errors: string[] }
  | { ok: false; code: "RPC_FAILED"; status: number; body: string; pgCode?: string };

// =====================================================================
// D-723 — IN-PROCESS MLB player_id RESOLVER
// =====================================================================
// One-shot bulk-load of cache_mlb_player_metadata at the start of a cron run
// (callers invoke prefetchMlbPlayerIds() before the scoring loop). Builds an
// unaccented-name → player_id map, skipping ambiguous-name collisions
// (HAVING COUNT(DISTINCT player_id) = 1). Mirrors the D-719b RPC's logic
// client-side so writePickHistory can auto-fill player_id on every new MLB
// pick without a per-pick REST roundtrip.
//
// Why this exists: the keystone (D-719/D-720) put player_id on 99.4% of
// player-prop rows, but only retroactively. New cron-created picks were
// born with NULL player_id, forcing the D-721/D-722/D-724 player_id-first
// readers to fall back to name-match. D-723 closes that gap permanently.

let _mlbPlayerIdMap: Map<string, number> | null = null;

function unaccent(s: string): string {
  // Match Postgres unaccent + lower() exactly for the lookup paths.
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * D-723: bulk-load the unique-name → player_id map from cache_mlb_player_metadata.
 * Idempotent — subsequent calls return immediately if the map is already loaded.
 * Callers (e.g., process-games-mlb top of handler) should invoke this ONCE per
 * cron run BEFORE the scoring loop so per-pick writes don't pay a fetch.
 * Graceful — on any fetch failure, the map stays null and writePickHistory
 * leaves player_id null (status quo behavior).
 */
export async function prefetchMlbPlayerIds(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<number> {
  if (_mlbPlayerIdMap) return _mlbPlayerIdMap.size;
  try {
    const url = `${supabaseUrl}/rest/v1/cache_mlb_player_metadata?select=player_id,full_name&full_name=not.is.null&limit=10000`;
    const r = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!r.ok) {
      console.log(`[d723] prefetchMlbPlayerIds: HTTP ${r.status}; pid auto-fill disabled this run`);
      return 0;
    }
    const rows = await r.json() as Array<{ player_id: number; full_name: string }>;
    // Build unaccented-name → set of player_ids
    const byKey = new Map<string, Set<number>>();
    for (const row of rows) {
      if (!row.full_name) continue;
      const key = unaccent(row.full_name);
      let s = byKey.get(key);
      if (!s) { s = new Set(); byKey.set(key, s); }
      s.add(row.player_id);
    }
    // Keep only unique-name mappings; collisions stay null (e.g. Max Muncy → 2 pids)
    const m = new Map<string, number>();
    for (const [key, ids] of byKey) {
      if (ids.size === 1) m.set(key, ids.values().next().value as number);
    }
    _mlbPlayerIdMap = m;
    console.log(`[d723] prefetchMlbPlayerIds: loaded ${rows.length} metadata rows; ${m.size} unique-name maps`);
    return m.size;
  } catch (e) {
    console.log(`[d723] prefetchMlbPlayerIds error: ${e}; pid auto-fill disabled this run`);
    return 0;
  }
}

/**
 * D-723: resolve player_id for a given player_name via the prefetched map.
 * Returns null when:
 *   - the map isn't loaded (prefetch failed or wasn't called),
 *   - the name has no match,
 *   - the name is ambiguous (multiple real player_ids share the unaccented key —
 *     Max Muncy, José Fermín, Jacob Gonzalez, etc.; intentional null, never a guess),
 *   - the name is a team-string / matchup tag (no real player).
 */
export function resolveMlbPlayerId(playerName: string): number | null {
  if (!_mlbPlayerIdMap || !playerName) return null;
  return _mlbPlayerIdMap.get(unaccent(playerName)) ?? null;
}

/** D-723: test-only hook to reset the cache between unit tests. */
export function _resetMlbPlayerIdMap(): void { _mlbPlayerIdMap = null; }

export interface WriteOpts {
  /** When true, validate but DO NOT call the RPC. Mirrors existing dry-run guards. */
  dryRun?: boolean;
  /** Required: Supabase URL (no trailing slash). */
  supabaseUrl: string;
  /** Required: service-role key (used for both apikey and Bearer auth on the RPC). */
  supabaseKey: string;
  /**
   * Optional best-effort logger invoked on validation or RPC failure.
   * Wrapped in try/catch internally so a logger failure NEVER blocks the
   * write or the caller. Return type is intentionally void.
   */
  logFailure?: (event: WriterFailureEvent) => void | Promise<void>;
}

export interface WriterFailureEvent {
  kind: "validation_failed" | "rpc_failed";
  errors?: string[];           // populated when kind=validation_failed
  status?: number;             // populated when kind=rpc_failed
  pgCode?: string;             // extracted from body when kind=rpc_failed
  bodyExcerpt?: string;        // first 300 chars of RPC response body
  payloadSummary: {
    player_name?: string;
    prop_type?: string;
    line?: number;
    pick_side?: string;
    game_date?: string;
    sport?: string;
    mlb_market_type?: string | null;
  };
}

// =====================================================================
// VALIDATION
// =====================================================================
export function validatePayload(p: PickHistoryPayload): string[] {
  const errors: string[] = [];

  // 1. NOT NULL + TYPE check on required fields.
  //
  // D-529 (T5): the pre-D-529 check only verified null/empty/undefined and
  // accepted any non-empty primitive. The confidence range check at step 3
  // then short-circuited on `typeof === "number"` so a string `"85"` flowed
  // through both checks silently and landed in the RPC, where Postgres
  // coerced it. We now LOUDLY reject wrong primitive types here.
  for (const f of REQUIRED_FIELDS) {
    const v = (p as Record<string, unknown>)[f as string];
    if (v === undefined || v === null || v === "") {
      errors.push(`required field '${String(f)}' is null/empty/undefined`);
      continue;
    }
    const expected = REQUIRED_FIELD_TYPES[f as string];
    if (expected && typeof v !== expected) {
      // Truncate the printed value at 60 chars — payloads can carry long
      // strings, and the validation error flows into error_log + the
      // CLIENT_VALIDATION response body.
      const repr = JSON.stringify(v);
      const reprTruncated = repr.length > 60 ? repr.slice(0, 60) + "…" : repr;
      errors.push(
        `required field '${String(f)}' has type '${typeof v}' (value=${reprTruncated}), expected '${expected}'`,
      );
    }
  }

  // 2. mlb_market_type CHECK constraint mirror
  if (p.mlb_market_type !== undefined && p.mlb_market_type !== null
      && !ALLOWED_MLB_MARKET_TYPES.has(p.mlb_market_type)) {
    errors.push(
      `mlb_market_type='${p.mlb_market_type}' not in allowed set ` +
      `[${[...ALLOWED_MLB_MARKET_TYPES].join(", ")}]`,
    );
  }

  // 3. confidence range — only meaningful when type check above passed.
  // (If confidence arrived as a non-number string, step 1 already errored
  // and the range check would be a duplicate. Range check still uses the
  // typeof guard so it doesn't throw on a non-number value that survived.)
  if (typeof p.confidence === "number"
      && Number.isFinite(p.confidence)
      && (p.confidence < 0 || p.confidence > 100)) {
    errors.push(`confidence ${p.confidence} out of [0,100]`);
  }

  // 4. NaN / Infinity guards for the numeric required fields.
  // D-529: a `NaN` or `Infinity` would pass `typeof === "number"` but is
  // semantically invalid for a wager payload.
  for (const f of ["line", "odds", "confidence"] as const) {
    const v = (p as Record<string, unknown>)[f];
    if (typeof v === "number" && !Number.isFinite(v)) {
      errors.push(`required field '${f}' is non-finite (${v})`);
    }
  }

  // 5. sport enum (only validates when present — REQUIRED_FIELDS check above
  // already catches null/undefined/empty sport)
  if (p.sport && p.sport !== "nba" && p.sport !== "mlb") {
    errors.push(`sport='${p.sport}' not in {nba, mlb}`);
  }

  return errors;
}

// Best-effort logger wrapper. Never throws; never blocks the caller's flow.
async function safeLogFailure(
  logFailure: WriteOpts["logFailure"],
  event: WriterFailureEvent,
): Promise<void> {
  if (!logFailure) return;
  try {
    await Promise.resolve(logFailure(event));
  } catch {
    // swallow — logging must not block the write or the caller
  }
}

function payloadSummary(p: PickHistoryPayload): WriterFailureEvent["payloadSummary"] {
  return {
    player_name: typeof p.player_name === "string" ? p.player_name : undefined,
    prop_type: typeof p.prop_type === "string" ? p.prop_type : undefined,
    line: typeof p.line === "number" ? p.line : undefined,
    pick_side: typeof p.pick_side === "string" ? p.pick_side : undefined,
    game_date: typeof p.game_date === "string" ? p.game_date : undefined,
    sport: typeof p.sport === "string" ? p.sport : undefined,
    mlb_market_type: typeof p.mlb_market_type === "string" ? p.mlb_market_type : (p.mlb_market_type === null ? null : undefined),
  };
}

function extractPgCode(body: string): string | undefined {
  const m = body.match(/"code"\s*:\s*"(\w+)"/);
  return m ? m[1] : undefined;
}

// =====================================================================
// THE CANONICAL WRITER
// =====================================================================
export async function writePickHistory(
  payload: PickHistoryPayload,
  opts: WriteOpts,
): Promise<WriteResult> {
  // 1. CLIENT VALIDATION — catches D-480-class at hour 0, BEFORE the RPC.
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    await safeLogFailure(opts.logFailure, {
      kind: "validation_failed",
      errors,
      payloadSummary: payloadSummary(payload),
    });
    return { ok: false, code: "CLIENT_VALIDATION", errors };
  }

  // D-723 — auto-fill player_id for MLB picks from the prefetched
  // cache_mlb_player_metadata unique-map. Closes the writeback gap where
  // new cron-inserted picks lacked player_id (forcing D-721/D-722/D-724
  // player_id-first readers into the name-fallback path on every new row).
  // Only fires when the payload didn't already specify player_id, so callers
  // that already know the pid (e.g., scoring's internal lineup chain) can
  // pass it directly and skip the lookup. Ambiguous names stay null by the
  // unique-map guard.
  if (payload.sport === "mlb"
    && (payload.player_id == null)
    && typeof payload.player_name === "string"
    && payload.player_name.length > 0) {
    const pid = resolveMlbPlayerId(payload.player_name);
    if (pid != null) {
      // Mutate the payload object; the upstream caller passed it by reference
      // but our contract returns success/failure independent of the payload
      // shape, so this is a safe enrichment (the field was undefined).
      (payload as Record<string, unknown>).player_id = pid;
    }
  }

  // 2. DRY-RUN guard (preserves the existing process-games / process-games-mlb
  // / analyze-pick _dryRun behavior). When dry-run, we've already validated;
  // skip the RPC call and return success.
  if (opts.dryRun) {
    return { ok: true };
  }

  // 3. POST to upsert_pick_history RPC (the D-446 canonical RPC).
  const headers = {
    "Content-Type": "application/json",
    "apikey": opts.supabaseKey,
    "Authorization": `Bearer ${opts.supabaseKey}`,
    "Prefer": "return=minimal",
  };
  let res: Response;
  try {
    res = await fetch(`${opts.supabaseUrl}/rest/v1/rpc/upsert_pick_history`, {
      method: "POST",
      headers,
      body: JSON.stringify({ payload }),
    });
  } catch (e) {
    const body = e instanceof Error ? e.message : String(e);
    await safeLogFailure(opts.logFailure, {
      kind: "rpc_failed",
      status: 0,
      bodyExcerpt: body.slice(0, 300),
      payloadSummary: payloadSummary(payload),
    });
    return { ok: false, code: "RPC_FAILED", status: 0, body };
  }

  if (!res.ok) {
    const body = await res.text();
    const pgCode = extractPgCode(body);
    await safeLogFailure(opts.logFailure, {
      kind: "rpc_failed",
      status: res.status,
      pgCode,
      bodyExcerpt: body.slice(0, 300),
      payloadSummary: payloadSummary(payload),
    });
    return { ok: false, code: "RPC_FAILED", status: res.status, body, pgCode };
  }

  return { ok: true };
}

// =====================================================================
// D-529 SHIP 2 (X10) — mlb_market_type drift detector.
//
// The ALLOWED_MLB_MARKET_TYPES Set above is a manual mirror of the
// `pick_history_mlb_market_type_check` Postgres CHECK constraint. The
// D-481 incident proved the manual sync can drift: D-474/475/476 added
// 3 new market types to the scorers but the CHECK constraint wasn't
// updated for 24 hours, and ~560 picks were rejected silently.
//
// This module provides a loud-fail drift detector that compares the
// in-code Set against the live constraint definition. The path:
//   1. parseAllowedFromConstraintDef — pure-function parser; extracts
//      `'value'::text` literals from a `pg_get_constraintdef()` output
//      like `CHECK (... = ANY (ARRAY['pitcher_k'::text, ...])))`.
//   2. compareMlbMarketTypeSet — compares the parsed values to the
//      in-code Set; returns missing/extra.
//   3. assertMlbMarketTypeSetSynced — DB-query path. Fetches the live
//      constraint def via a thin RPC and runs the comparator.
//
// The detector is hooked into sonnet-health-monitor's hourly tick as
// the new check `mlb_market_type_constraint_drift` so any drift fires
// a health_status fail row + notify escalation (D-481 sibling pattern).
// =====================================================================

export interface MlbMarketTypeDriftReport {
  /** true iff the in-code Set matches the live CHECK constraint exactly. */
  ok: boolean;
  /** Market types in the CHECK constraint but NOT in the in-code Set.
   *  These would cause the writer to LOUDLY reject valid payloads
   *  (the D-481 incident shape). */
  missingInCode: string[];
  /** Market types in the in-code Set but NOT in the CHECK constraint.
   *  These would pass the writer's mirror but fail the server CHECK. */
  extraInCode: string[];
  /** The list of values parsed from the live CHECK constraint. */
  parsedFromConstraint: string[];
}

/** Parse `'value'::text` literals out of a `pg_get_constraintdef()` output.
 *  Pure function — no I/O. Exported for unit-testing the parser shape. */
export function parseAllowedFromConstraintDef(consrc: string): string[] {
  const out: string[] = [];
  const re = /'([^']+)'::text/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(consrc)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/** Compare a list-from-DB against the in-code Set; produce a structured
 *  drift report. Pure function. */
export function compareMlbMarketTypeSet(
  fromConstraint: string[],
  fromCode: ReadonlySet<string> = ALLOWED_MLB_MARKET_TYPES,
): MlbMarketTypeDriftReport {
  const codeSet = new Set(fromCode);
  const constraintSet = new Set(fromConstraint);
  const missingInCode: string[] = [];
  const extraInCode: string[] = [];
  for (const v of constraintSet) if (!codeSet.has(v)) missingInCode.push(v);
  for (const v of codeSet) if (!constraintSet.has(v)) extraInCode.push(v);
  return {
    ok: missingInCode.length === 0 && extraInCode.length === 0,
    missingInCode: missingInCode.sort(),
    extraInCode: extraInCode.sort(),
    parsedFromConstraint: [...constraintSet].sort(),
  };
}

/** Query the live CHECK constraint via PostgREST RPC and compare against
 *  the in-code Set. Returns the drift report. Never throws — network/RPC
 *  errors yield a report with `ok=false` and an empty `parsedFromConstraint`
 *  so callers can decide whether to alert. */
export async function assertMlbMarketTypeSetSynced(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<MlbMarketTypeDriftReport & { rpcError?: string }> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/rpc/d529_get_mlb_market_type_constraint_def`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        missingInCode: [],
        extraInCode: [],
        parsedFromConstraint: [],
        rpcError: `RPC HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    const consrc = (await res.json()) as string;
    const parsed = parseAllowedFromConstraintDef(consrc);
    return compareMlbMarketTypeSet(parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      missingInCode: [],
      extraInCode: [],
      parsedFromConstraint: [],
      rpcError: msg,
    };
  }
}

// =====================================================================
// TEST HELPERS (exported for SHIP 1 unit-validation in d487_helper_built.md)
// =====================================================================
export const _internal_for_tests = {
  ALLOWED_MLB_MARKET_TYPES,
  REQUIRED_FIELDS,
  REQUIRED_FIELD_TYPES,
  extractPgCode,
  parseAllowedFromConstraintDef,
  compareMlbMarketTypeSet,
};
