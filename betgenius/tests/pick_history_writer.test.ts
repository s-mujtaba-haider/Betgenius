// D-529 — verification of the T5 fix (validatePayload loud-rejects wrong
// primitive types) and the T2 fix (process-games NBA writer no longer
// hides primitive-type drift behind a double-cast).
//
// These tests are the documented PROOF that:
//   - confidence: "85" (string) is now LOUDLY rejected (the D-528 trivial-
//     penalty class) instead of silently coerced.
//   - A valid PickHistoryPayload still passes.
//   - NaN / Infinity numeric values are caught.
//   - Out-of-range confidence still produces its own error.
//   - mlb_market_type CHECK mirror still works.
import { describe, expect, it } from "vitest";
import {
  validatePayload,
  parseAllowedFromConstraintDef,
  compareMlbMarketTypeSet,
  _internal_for_tests,
  type PickHistoryPayload,
} from "../supabase/functions/_shared/pick_history_writer.ts";

function basePayload(): PickHistoryPayload {
  return {
    player_name: "Test Player",
    prop_type: "points",
    line: 21.5,
    pick_side: "over",
    odds: -110,
    confidence: 85,
    verdict: "STRONG",
    sport: "nba",
  };
}

describe("D-529 T5 — validatePayload rejects wrong primitive types loudly", () => {
  it("accepts a valid payload (smoke)", () => {
    expect(validatePayload(basePayload())).toEqual([]);
  });

  it("REJECTS confidence as string (the D-528 trivial-penalty class)", () => {
    // Build a payload where confidence is the string "85" — exactly the
    // shape D-528 T5 found pre-D-529 was silently passing because the
    // range-check short-circuited on the typeof guard.
    const p = { ...basePayload(), confidence: "85" as unknown as number };
    const errors = validatePayload(p);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toMatch(/confidence/);
    expect(errors.join(" ")).toMatch(/type 'string'/);
    expect(errors.join(" ")).toMatch(/expected 'number'/);
  });

  it("REJECTS line as string", () => {
    const p = { ...basePayload(), line: "21.5" as unknown as number };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/line.*type 'string'.*expected 'number'/);
  });

  it("REJECTS odds as string", () => {
    const p = { ...basePayload(), odds: "-110" as unknown as number };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/odds.*type 'string'.*expected 'number'/);
  });

  it("REJECTS player_name as number", () => {
    const p = { ...basePayload(), player_name: 12345 as unknown as string };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/player_name.*type 'number'.*expected 'string'/);
  });

  it("REJECTS pick_side as boolean", () => {
    const p = { ...basePayload(), pick_side: true as unknown as string };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/pick_side.*type 'boolean'.*expected 'string'/);
  });

  it("REJECTS confidence as NaN (finite-number guard)", () => {
    const p = { ...basePayload(), confidence: NaN };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/confidence.*non-finite/);
  });

  it("REJECTS odds as Infinity", () => {
    const p = { ...basePayload(), odds: Infinity };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/odds.*non-finite/);
  });

  it("STILL rejects confidence out of [0,100]", () => {
    const p = { ...basePayload(), confidence: 150 };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/confidence 150 out of \[0,100\]/);
  });

  it("STILL catches NULL required field", () => {
    const p = { ...basePayload(), player_name: null as unknown as string };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/player_name.*null\/empty\/undefined/);
  });

  it("STILL catches mlb_market_type CHECK constraint mirror", () => {
    const p: PickHistoryPayload = {
      ...basePayload(),
      sport: "mlb",
      mlb_market_type: "batter_homers", // not in the allowed Set
    };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/mlb_market_type='batter_homers' not in allowed set/);
  });

  it("STILL allows mlb_market_type=null for NBA picks", () => {
    const p: PickHistoryPayload = {
      ...basePayload(),
      mlb_market_type: null,
    };
    expect(validatePayload(p)).toEqual([]);
  });

  it("STILL rejects sport not in {nba, mlb}", () => {
    const p = { ...basePayload(), sport: "nfl" as unknown as "nba" | "mlb" };
    const errors = validatePayload(p);
    expect(errors.join(" ")).toMatch(/sport='nfl' not in \{nba, mlb\}/);
  });

  // The compound case: multiple bad types in one payload — all must be
  // surfaced, not just the first.
  it("REPORTS all bad-type errors in one pass (no short-circuit)", () => {
    const p = {
      ...basePayload(),
      confidence: "85" as unknown as number,
      line: "21" as unknown as number,
      odds: true as unknown as number,
    };
    const errors = validatePayload(p);
    // Three separate type errors expected.
    const typeErrors = errors.filter((e) => /type '\w+'.*expected '\w+'/.test(e));
    expect(typeErrors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("D-529 SHIP 2 (X10) — mlb_market_type drift detector", () => {
  // The LIVE constraint definition string captured from pg_get_constraintdef
  // via the d529_get_mlb_market_type_constraint_def RPC (2026-06-14):
  const LIVE_CHECK_DEF =
    "CHECK (((mlb_market_type IS NULL) OR (mlb_market_type = ANY (ARRAY[" +
    "'pitcher_k'::text, 'batter_hits'::text, 'batter_hr'::text, " +
    "'batter_total_bases'::text, 'batter_rbis'::text, 'game_side'::text, " +
    "'game_total'::text, 'batter_strikeouts'::text, " +
    "'batter_runs_scored'::text, 'pitcher_outs'::text]))))";

  it("parseAllowedFromConstraintDef extracts all 10 values from the live constraint", () => {
    const vals = parseAllowedFromConstraintDef(LIVE_CHECK_DEF);
    expect(vals).toEqual([
      "pitcher_k", "batter_hits", "batter_hr", "batter_total_bases",
      "batter_rbis", "game_side", "game_total", "batter_strikeouts",
      "batter_runs_scored", "pitcher_outs",
    ]);
  });

  it("parser handles edge cases (empty string, no matches)", () => {
    expect(parseAllowedFromConstraintDef("")).toEqual([]);
    expect(parseAllowedFromConstraintDef("CHECK ((sport IS NULL))")).toEqual([]);
  });

  it("comparator: ok=true when in-code Set matches live constraint", () => {
    const parsed = parseAllowedFromConstraintDef(LIVE_CHECK_DEF);
    const report = compareMlbMarketTypeSet(parsed);
    expect(report.ok).toBe(true);
    expect(report.missingInCode).toEqual([]);
    expect(report.extraInCode).toEqual([]);
    expect(report.parsedFromConstraint.length).toBe(10);
  });

  it("comparator: detects missingInCode when DB adds a market and code lags (the D-481 shape)", () => {
    // Simulate the D-481 incident: the DB constraint gains a new market
    // type (e.g., a hypothetical 'batter_walks') but the code's
    // ALLOWED_MLB_MARKET_TYPES Set hasn't been updated yet. The detector
    // must surface this loudly so the gap is closed before silent
    // pick rejection accumulates.
    const fromConstraint = [
      ...parseAllowedFromConstraintDef(LIVE_CHECK_DEF),
      "batter_walks", // hypothetical D-525-era new market
    ];
    const report = compareMlbMarketTypeSet(fromConstraint);
    expect(report.ok).toBe(false);
    expect(report.missingInCode).toEqual(["batter_walks"]);
    expect(report.extraInCode).toEqual([]);
  });

  it("comparator: detects extraInCode when code adds a market and DB CHECK lags", () => {
    // The opposite drift: code has a market type that the DB CHECK
    // wouldn't accept. Less likely (writes would fail server-side and
    // alert via rpc_failed_rate) but still a bug to surface.
    const fromConstraint = parseAllowedFromConstraintDef(LIVE_CHECK_DEF)
      .filter((v) => v !== "pitcher_outs"); // simulate constraint missing one
    const report = compareMlbMarketTypeSet(fromConstraint);
    expect(report.ok).toBe(false);
    expect(report.extraInCode).toEqual(["pitcher_outs"]);
  });

  it("comparator: detects both-sides drift simultaneously", () => {
    const fromConstraint = [
      ...parseAllowedFromConstraintDef(LIVE_CHECK_DEF),
      "batter_walks",
    ].filter((v) => v !== "pitcher_outs");
    const report = compareMlbMarketTypeSet(fromConstraint);
    expect(report.ok).toBe(false);
    expect(report.missingInCode).toEqual(["batter_walks"]);
    expect(report.extraInCode).toEqual(["pitcher_outs"]);
  });

  it("ALLOWED_MLB_MARKET_TYPES (in-code) currently contains exactly the live constraint set", () => {
    // This is the "baseline assertion": at the moment this test was
    // written, the in-code Set and the live DB CHECK constraint matched.
    // If a future PR alters one but not the other, this test fails first.
    const parsed = parseAllowedFromConstraintDef(LIVE_CHECK_DEF);
    const inCode = [..._internal_for_tests.ALLOWED_MLB_MARKET_TYPES];
    expect(inCode.sort()).toEqual(parsed.sort());
  });
});
