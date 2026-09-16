// D-636 — Sharp money signal (FREE RLM proxy + steam detection).
// ─────────────────────────────────────────────────────────────────────
// Source-agnostic: reads cache_odds_snapshots (D-634 normalized vocab),
// never references The Odds API or any provider. Same code works after
// a future OddsJam/Sportradar swap.
//
// Two signals:
//   1. RLM PROXY — without true bet-percentage data, we proxy "public
//      side" with "the side with the most-negative odds at OPEN."
//      That's the favorite, which historically attracts public money.
//      If the line moves AGAINST the favorite (= toward the underdog
//      / sharp side), that's the classic Reverse Line Movement
//      indicator — sharp money on the dog despite public on the fav.
//   2. STEAM — coordinated movement across ≥5 books of ≥5¢ within the
//      recent window. Snapshot writer cadence is 30 min; we treat the
//      LAST snapshot per book as "now" and the FIRST as "open," so
//      the window is effectively the day-of-game polling history.
//
// CONSERVATIVE SEED WEIGHT: 0 (D-636 CEO §2). Factor computes + writes
// breakdown so the D-549 harness can measure it; applied score is 0
// (confidence not perturbed). Promote to a real algorithm_weights row
// only after the harness proves the signal on 30+ days of data.

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────
interface SharpSnapshot {
  bookmaker: string;
  line: number;
  odds: number;
  snapshot_time: string;
}

interface SharpSideSeries {
  // Per-bookmaker snapshot list, sorted ASC by snapshot_time.
  byBook: Map<string, SharpSnapshot[]>;
}

export interface SharpInfo {
  // Both sides of the same (event_id, market, player, prop_type).
  // Keys are the LOWERCASE pick_side strings.
  sides: Map<string, SharpSideSeries>;
}

// Outer key intentionally OMITS pick_side + bookmaker — sharp signal
// needs cross-book + both-sides view.
// Key shape: `${event_id}|${market}|${player_name}|${prop_type}`.
export type SharpMoneyMap = Map<string, SharpInfo>;

// ─────────────────────────────────────────────────────────────────────
function sharpKey(
  event_id: string, market: string, player_name: string, prop_type: string,
): string {
  return `${event_id}|${market}|${player_name.toLowerCase()}|${prop_type}`;
}

// ─────────────────────────────────────────────────────────────────────
// loadSharpMoneyMap — single paginated fetch + group into per-pick
// two-sided cross-book series.
// ─────────────────────────────────────────────────────────────────────
export async function loadSharpMoneyMap(
  sport: string,
  gameDate: string,        // YYYY-MM-DD ISO
): Promise<SharpMoneyMap> {
  const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const map: SharpMoneyMap = new Map();
  let pStart = 0;
  const PAGE = 10000;
  for (let i = 0; i < 10; i++) {
    const url = `${SUPA_URL}/rest/v1/cache_odds_snapshots?sport=eq.${sport}` +
      `&game_date=eq.${encodeURIComponent(gameDate)}` +
      `&select=event_id,market,player_name,prop_type,pick_side,bookmaker,line,odds,snapshot_time` +
      `&order=snapshot_time.asc`;
    const r = await fetch(url, {
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        Range: `${pStart}-${pStart + PAGE - 1}`, "Range-Unit": "items",
      },
    });
    if (!r.ok) break;
    const rows = await r.json() as Array<{
      event_id: string; market: string; player_name: string;
      prop_type: string; pick_side: string; bookmaker: string;
      line: number; odds: number; snapshot_time: string;
    }>;
    for (const row of rows) {
      const k = sharpKey(row.event_id, row.market, row.player_name, row.prop_type);
      let info = map.get(k);
      if (!info) {
        info = { sides: new Map() };
        map.set(k, info);
      }
      const sideKey = row.pick_side.toLowerCase();
      let series = info.sides.get(sideKey);
      if (!series) {
        series = { byBook: new Map() };
        info.sides.set(sideKey, series);
      }
      const bookKey = row.bookmaker.toLowerCase();
      let bookList = series.byBook.get(bookKey);
      if (!bookList) {
        bookList = [];
        series.byBook.set(bookKey, bookList);
      }
      bookList.push({
        bookmaker: bookKey,
        line: Number(row.line),
        odds: Number(row.odds),
        snapshot_time: row.snapshot_time,
      });
    }
    if (rows.length < PAGE) break;
    pStart += PAGE;
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────
// applySharpMoneyV2 — augment a scoring result with the RLM-proxy +
// steam signal. SEED_WEIGHT=0 (D-636): confidence is NOT perturbed.
// Writes breakdown fields for the harness + display + AI write-up.
// ─────────────────────────────────────────────────────────────────────
export function applySharpMoneyV2(
  ctx: {
    event_id: string;
    market: string;
    player_name: string;
    prop_type: string;
    pick_side: string;
  },
  scoreResult: { confidence: number; breakdown: Record<string, number | string | null | boolean> },
  sharpMoneyMap: SharpMoneyMap | null,
): { applied: boolean; factor_score: number } {
  // SEED_WEIGHT pinned at 0 — measure-only.
  const SEED_WEIGHT = 0;

  const writeEmpty = (status: string) => {
    scoreResult.breakdown.score_rlm_signal = 0;
    scoreResult.breakdown.rlm_raw_score = 0;
    scoreResult.breakdown.rlm_seed_weight = SEED_WEIGHT;
    scoreResult.breakdown.rlm_status = status;
    scoreResult.breakdown.rlm_n_books = 0;
    scoreResult.breakdown.rlm_n_books_toward = 0;
    scoreResult.breakdown.rlm_n_books_away = 0;
    scoreResult.breakdown.rlm_avg_odds_delta = 0;
    scoreResult.breakdown.rlm_public_side = null;
    scoreResult.breakdown.rlm_pick_is_sharp_side = null;
    scoreResult.breakdown.steam_detected = false;
    scoreResult.breakdown.steam_direction = null;
  };

  if (!sharpMoneyMap) { writeEmpty("no_data"); return { applied: false, factor_score: 0 }; }
  const k = sharpKey(ctx.event_id, ctx.market, ctx.player_name, ctx.prop_type);
  const info = sharpMoneyMap.get(k);
  if (!info) { writeEmpty("no_data"); return { applied: false, factor_score: 0 }; }

  const pickSide = ctx.pick_side.toLowerCase();
  const series = info.sides.get(pickSide);
  if (!series || series.byBook.size === 0) {
    writeEmpty("no_data_for_pick_side"); return { applied: false, factor_score: 0 };
  }

  // ── 1. Per-book deltas on the PICK side ───────────────────────────
  let nBooks = 0;
  let nToward = 0;
  let nAway = 0;
  let sumDelta = 0;
  let pickSideOpenSum = 0;
  for (const list of series.byBook.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    const last = list[list.length - 1];
    if (first.snapshot_time === last.snapshot_time) continue;
    nBooks++;
    const d = last.odds - first.odds;
    sumDelta += d;
    pickSideOpenSum += first.odds;
    if (d <= -5) nToward++;
    else if (d >= 5) nAway++;
  }

  if (nBooks === 0) { writeEmpty("no_movement"); return { applied: false, factor_score: 0 }; }
  const avgDelta = sumDelta / nBooks;
  const pickSideAvgOpen = pickSideOpenSum / nBooks;

  // ── 2. Identify the "public side" via opening favorite ────────────
  // For every OTHER side in the same key, compute its average opening
  // odds. The side with the MORE NEGATIVE average opening price is the
  // favorite (= our public-side proxy).
  let publicSideKey: string | null = null;
  let publicSideAvgOpen: number = Number.POSITIVE_INFINITY;
  for (const [sideKey, sideSeries] of info.sides.entries()) {
    let openSum = 0;
    let openCount = 0;
    for (const list of sideSeries.byBook.values()) {
      if (!list.length) continue;
      openSum += list[0].odds;
      openCount++;
    }
    if (openCount === 0) continue;
    const avgOpen = openSum / openCount;
    if (avgOpen < publicSideAvgOpen) {
      publicSideAvgOpen = avgOpen;
      publicSideKey = sideKey;
    }
  }

  // If both sides have positive odds (rare) or only one side exists
  // (props with no opposite side captured), fall back to "no public
  // side identified" — RLM signal is undefined.
  const haveBothSides = info.sides.size >= 2 && publicSideKey !== null;
  const pickIsSharpSide = haveBothSides && publicSideKey !== pickSide;

  // ── 3. RLM signal ─────────────────────────────────────────────────
  // Classic RLM: line moved AGAINST the public/favorite side (= toward
  // our side, when our side is the sharp side). Strongest signal:
  //   pick = sharp side  AND  avgDelta on pick side <= -5¢
  let rlmRaw = 0;
  if (haveBothSides) {
    if (pickIsSharpSide) {
      // Sharp side: avgDelta < 0 = market priced our side higher = positive.
      if (avgDelta <= -10) rlmRaw = 8;          // strong RLM toward us
      else if (avgDelta <= -5) rlmRaw = 5;       // moderate RLM toward us
      else if (avgDelta >= 10) rlmRaw = -5;      // anti-RLM (public crushing us)
    } else {
      // Pick is on public side: RLM signal is INVERTED — if avg delta on
      // OUR public side is positive (price lengthening, money on the dog),
      // that's classic sharp-on-the-other-side; bad for our pick.
      if (avgDelta >= 10) rlmRaw = -5;
      else if (avgDelta >= 5) rlmRaw = -3;
    }
  }

  // ── 4. Steam detection ────────────────────────────────────────────
  // ≥5 books showing ≥5¢ movement in the SAME direction → steam.
  let steamDetected = false;
  let steamDirection: "toward" | "away" | null = null;
  if (nToward >= 5) { steamDetected = true; steamDirection = "toward"; }
  else if (nAway >= 5) { steamDetected = true; steamDirection = "away"; }
  // Steam boost is folded into rlmRaw (still gated by SEED_WEIGHT=0).
  if (steamDetected && steamDirection === "toward") rlmRaw += 2;
  else if (steamDetected && steamDirection === "away") rlmRaw -= 2;

  // ── 5. Apply (weight 0) + write breakdown ─────────────────────────
  const factorScore = rlmRaw * SEED_WEIGHT;
  // D-636 — confidence NOT mutated; SEED_WEIGHT=0 forces 0. Skip the
  // assignment so the intent is explicit.
  scoreResult.breakdown.score_rlm_signal = factorScore;            // applied (0)
  scoreResult.breakdown.rlm_raw_score = rlmRaw;                    // measured
  scoreResult.breakdown.rlm_seed_weight = SEED_WEIGHT;
  scoreResult.breakdown.rlm_status = haveBothSides
    ? (rlmRaw === 0 ? "neutral" : (rlmRaw > 0 ? "rlm_toward_pick" : "rlm_away_from_pick"))
    : "single_side_only";
  scoreResult.breakdown.rlm_n_books = nBooks;
  scoreResult.breakdown.rlm_n_books_toward = nToward;
  scoreResult.breakdown.rlm_n_books_away = nAway;
  scoreResult.breakdown.rlm_avg_odds_delta = Math.round(avgDelta * 10) / 10;
  scoreResult.breakdown.rlm_pick_avg_open_odds = Math.round(pickSideAvgOpen * 10) / 10;
  scoreResult.breakdown.rlm_public_side = publicSideKey;
  scoreResult.breakdown.rlm_pick_is_sharp_side = pickIsSharpSide;
  scoreResult.breakdown.steam_detected = steamDetected;
  scoreResult.breakdown.steam_direction = steamDirection;

  return { applied: true, factor_score: factorScore };
}
