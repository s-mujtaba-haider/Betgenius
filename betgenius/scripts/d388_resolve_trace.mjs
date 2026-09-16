#!/usr/bin/env node
// D-388 SHIP 1 (deep) — trace ONE queue-head pick through resolveMlbPicks
// logic by hand to see what's blocking it.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

async function main() {
  // (1) Pull the oldest 5 queue-head picks with ALL fields needed by resolveMlbPicks
  console.log("=== Oldest 5 queue-head MLB unresolved picks — full fields ===");
  const head = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.2026-05-18&select=id,player_name,team,opponent,is_home,prop_type,mlb_market_type,pick_side,line,game_date,game_time,created_at,resolved_at,hit,voided&order=created_at.asc&limit=5`);
  if (head.error) { console.error(head.error); return; }
  for (const r of head.data) {
    console.log(JSON.stringify(r, null, 2));
    console.log("---");
  }

  // (2) Manually run the resolveMlbPicks game-market match logic on row 1
  if (head.data.length > 0) {
    const pick = head.data[0];
    const isGameMarket =
      pick.mlb_market_type === "game_side" || pick.mlb_market_type === "game_total" ||
      pick.prop_type === "spreads" || pick.prop_type === "totals" || pick.prop_type === "h2h";
    console.log(`\n=== Manual trace for pick id=${pick.id} ===`);
    console.log(`  prop_type=${pick.prop_type}  mlb_market_type=${pick.mlb_market_type}`);
    console.log(`  isGameMarket=${isGameMarket}`);

    // Fetch the MLB schedule for that date
    const date = pick.game_date;
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
    const r = await fetch(url);
    const j = await r.json();
    const games = [];
    for (const d of (j.dates ?? [])) {
      for (const g of (d.games ?? [])) {
        games.push({
          gamePk: g.gamePk,
          status: g.status?.detailedState ?? "",
          homeTeam: g.teams?.home?.team?.name ?? "",
          awayTeam: g.teams?.away?.team?.name ?? "",
          homeScore: g.teams?.home?.score ?? 0,
          awayScore: g.teams?.away?.score ?? 0,
        });
      }
    }
    const finalGames = games.filter((g) => g.status === "Final" || g.status === "Game Over" || g.status === "Completed Early");
    console.log(`  date ${date}: total games=${games.length}  final games=${finalGames.length}`);

    // Try to match pick.team + pick.opponent in finalGames
    const pickTeam = (pick.team || "").toLowerCase();
    const pickOpp = (pick.opponent || "").toLowerCase();
    console.log(`  pick.team="${pick.team}"  pick.opponent="${pick.opponent}"`);
    const matchedGame = finalGames.find((g) => {
      const h = g.homeTeam.toLowerCase(), a = g.awayTeam.toLowerCase();
      return (h === pickTeam || a === pickTeam) && (h === pickOpp || a === pickOpp);
    });
    if (matchedGame) {
      console.log(`  MATCHED: ${matchedGame.awayTeam} @ ${matchedGame.homeTeam}  ${matchedGame.awayScore}-${matchedGame.homeScore}  status=${matchedGame.status}`);
    } else {
      console.log(`  NO MATCH — finalGames team names:`);
      for (const g of finalGames) console.log(`    "${g.awayTeam}" @ "${g.homeTeam}"`);
    }
  }

  // (3) Count picks with pick.team = NULL vs not-null (game-market only) — sanity check D-370 + game-market write path
  console.log("\n=== Game-market picks: pick.team NULL split (unresolved subset, 14d window) ===");
  const cutoff14 = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);
  const gm = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff14}&prop_type=in.%28spreads%2Ctotals%2Ch2h%29&select=team,opponent,prop_type&limit=3000`);
  if (!gm.error) {
    let nullTeam = 0, hasTeam = 0, nullOpp = 0, hasOpp = 0;
    for (const r of gm.data) {
      if (!r.team) nullTeam++; else hasTeam++;
      if (!r.opponent) nullOpp++; else hasOpp++;
    }
    console.log(`  total game-market unresolved (capped 3000): ${gm.data.length}`);
    console.log(`    team is NULL:     ${nullTeam}`);
    console.log(`    team is set:      ${hasTeam}`);
    console.log(`    opponent is NULL: ${nullOpp}`);
    console.log(`    opponent is set:  ${hasOpp}`);
  }

  // (4) Same for player-market picks: do they have player_name properly set?
  console.log("\n=== Player-market picks: player_name set check (unresolved subset, 14d window) ===");
  const pm = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff14}&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29&select=player_name,game_date&limit=3000`);
  if (!pm.error) {
    let nullName = 0, hasName = 0;
    for (const r of pm.data) {
      if (!r.player_name) nullName++; else hasName++;
    }
    console.log(`  total player-market unresolved (capped 3000): ${pm.data.length}`);
    console.log(`    player_name NULL: ${nullName}`);
    console.log(`    player_name set:  ${hasName}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
