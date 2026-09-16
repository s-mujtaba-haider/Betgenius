#!/usr/bin/env node
// D-389a void ground-truth — verify the 12 voided picks from SHIP 2 controlled
// are LEGITIMATE DNP/missing-player voids, not D-277-class mis-voids.

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

async function fetchMlbScheduleAndBoxscores(date) {
  // Return Map: gamePk → { homeTeam, awayTeam, players: Map<lowercased_name, stats> }
  const out = new Map();
  const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
  const sched = await fetch(schedUrl);
  if (!sched.ok) return out;
  const sj = await sched.json();
  for (const d of (sj.dates ?? [])) {
    for (const g of (d.games ?? [])) {
      if (!(g.status?.detailedState === "Final" || g.status?.detailedState === "Game Over" || g.status?.detailedState === "Completed Early")) continue;
      const gamePk = g.gamePk;
      const boxUrl = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
      try {
        const box = await fetch(boxUrl);
        if (!box.ok) continue;
        const bj = await box.json();
        const players = new Map();
        const allNames = [];
        for (const side of ["home", "away"]) {
          const team = bj?.teams?.[side];
          for (const k of Object.keys(team?.players ?? {})) {
            const p = team.players[k];
            const fullName = p?.person?.fullName ?? "";
            allNames.push(fullName);
            const bat = p?.stats?.batting ?? {};
            const pit = p?.stats?.pitching ?? {};
            players.set(fullName.toLowerCase(), {
              fullName,
              hits: bat.hits ?? null,
              homeRuns: bat.homeRuns ?? null,
              totalBases: bat.totalBases ?? null,
              rbi: bat.rbi ?? null,
              atBats: bat.atBats ?? null,
              strikeOuts: pit.strikeOuts ?? null,
              didPlay: (bat.atBats ?? 0) > 0 || (bat.plateAppearances ?? 0) > 0 || (pit.inningsPitched != null && pit.inningsPitched !== "0.0"),
            });
          }
        }
        out.set(gamePk, {
          homeTeam: bj?.teams?.home?.team?.name ?? "",
          awayTeam: bj?.teams?.away?.team?.name ?? "",
          players,
          allNames,
        });
      } catch {}
    }
  }
  return out;
}

async function main() {
  // Pull voided picks from the SHIP 2 run (voided in last hour, game_date in 14d window)
  const sinceRun = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const voided = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&voided=eq.true&resolved_at=gte.${sinceRun}&select=id,player_name,team,opponent,prop_type,mlb_market_type,pick_side,line,game_date,resolved_at&order=resolved_at.desc&limit=30`);
  if (voided.error) { console.error(voided.error); return; }

  console.log(`=== Voided picks from SHIP 2 controlled run (last 30 min): ${voided.data.length} ===`);
  for (const v of voided.data) {
    console.log(`  ${v.player_name?.padEnd(30).slice(0, 30)}  team=${v.team?.slice(0, 20).padEnd(20)} ${v.prop_type}/${v.pick_side}/${v.line}  gd=${v.game_date}  resolved_at=${v.resolved_at?.slice(11, 19)}`);
  }

  // Ground-truth each: was the player in any boxscore for their game_date?
  // Group by game_date to reuse boxscores
  const byDate = new Map();
  for (const v of voided.data) {
    if (!byDate.has(v.game_date)) byDate.set(v.game_date, []);
    byDate.get(v.game_date).push(v);
  }

  console.log(`\n=== Ground-truth check ===`);
  let legitDnp = 0, dPotentialMisvoid = 0;
  const findings = [];

  for (const [date, picks] of byDate) {
    console.log(`\n${date}: ${picks.length} voided pick(s) to verify`);
    const boxes = await fetchMlbScheduleAndBoxscores(date);
    console.log(`  ${boxes.size} final games with boxscores fetched`);

    for (const v of picks) {
      // Look up the player by name across ALL games' boxscores
      const lowered = v.player_name.toLowerCase();
      let foundInGame = null;
      let didPlay = false;
      let stats = null;
      for (const [gamePk, box] of boxes) {
        const player = box.players.get(lowered);
        if (player) {
          foundInGame = gamePk;
          didPlay = player.didPlay;
          stats = player;
          break;
        }
      }

      // Also check name-with-accent stripped (the Julio Rodríguez case)
      let matchedByNormalization = null;
      if (!foundInGame) {
        const normalize = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
        const target = normalize(v.player_name);
        outer: for (const [gamePk, box] of boxes) {
          for (const name of box.allNames) {
            if (normalize(name) === target) {
              matchedByNormalization = { gamePk, name };
              const player = box.players.get(name.toLowerCase());
              if (player) {
                didPlay = player.didPlay;
                stats = player;
              }
              break outer;
            }
          }
        }
      }

      const verdict = foundInGame ? (didPlay ? "PLAYED (potential mis-void)" : "NOT IN BOXSCORE = legit DNP") :
                      matchedByNormalization ? `MATCHED via normalization (D-277-class — name "${matchedByNormalization.name}" vs stored "${v.player_name}") — potential mis-void if PLAYED` :
                      "NOT FOUND in any boxscore = legit (player not on roster / inactive / wrong game)";

      if (matchedByNormalization && stats?.didPlay) dPotentialMisvoid++;
      else if (foundInGame && didPlay) dPotentialMisvoid++;
      else legitDnp++;

      findings.push({ pick: v, foundInGame, matchedByNormalization, didPlay, stats, verdict });
      console.log(`  ${v.player_name?.padEnd(30).slice(0, 30)}  verdict: ${verdict}`);
      if (stats) console.log(`    boxscore stats: hits=${stats.hits} HR=${stats.homeRuns} TB=${stats.totalBases} RBI=${stats.rbi} AB=${stats.atBats} K(P)=${stats.strikeOuts}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  legit DNP/not-on-roster voids:    ${legitDnp}`);
  console.log(`  POTENTIAL D-277-class mis-voids:  ${dPotentialMisvoid}`);

  writeFileSync(resolve(projectRoot, "docs", "loop", "reports", "d389a_void_groundtruth.json"), JSON.stringify({ findings, legit_dnp: legitDnp, potential_misvoid: dPotentialMisvoid }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
