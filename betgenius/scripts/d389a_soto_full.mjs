#!/usr/bin/env node
const box = await fetch('https://statsapi.mlb.com/api/v1/game/823625/boxscore').then(r => r.json());
const metsSide = box.teams.home?.team?.name === 'New York Mets' ? 'home' : 'away';
const metsPlayers = box.teams[metsSide]?.players || {};
for (const k of Object.keys(metsPlayers)) {
  const p = metsPlayers[k];
  if ((p.person?.fullName || '').toLowerCase().includes('soto')) {
    console.log("FULL SOTO RECORD:");
    console.log(JSON.stringify(p, null, 2));
  }
}
// Also check what's listed in 'batters' index for the Mets team
console.log("\n=== Mets batters lineup (from team.batters array) ===");
const batters = box.teams[metsSide]?.batters || [];
console.log("batters array length:", batters.length);
for (const id of batters.slice(0, 12)) {
  const p = metsPlayers[`ID${id}`];
  if (p) console.log(`  ${p.person?.fullName}  pos=${p.position?.code}  AB=${p.stats?.batting?.atBats} H=${p.stats?.batting?.hits}`);
}
