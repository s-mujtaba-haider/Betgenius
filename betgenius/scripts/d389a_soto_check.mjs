#!/usr/bin/env node
// Direct check: did Juan Soto play for the Mets on 2026-05-25?

const sched = await fetch('https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-05-25').then(r => r.json());
const games = sched.dates?.[0]?.games || [];
const metsGame = games.find(g => g.teams?.home?.team?.name === 'New York Mets' || g.teams?.away?.team?.name === 'New York Mets');
if (!metsGame) { console.log('No Mets game on 5/25'); process.exit(0); }
console.log(`Mets game: ${metsGame.teams.away.team.name} @ ${metsGame.teams.home.team.name}  status: ${metsGame.status?.detailedState}  score: ${metsGame.teams.away.score}-${metsGame.teams.home.score}`);
console.log(`gamePk: ${metsGame.gamePk}`);

const box = await fetch(`https://statsapi.mlb.com/api/v1/game/${metsGame.gamePk}/boxscore`).then(r => r.json());
console.log('\nLooking for Soto in both rosters...');
for (const side of ['home', 'away']) {
  const t = box.teams?.[side];
  const players = t?.players || {};
  console.log(`\n--- ${t?.team?.name} (${side}) — ${Object.keys(players).length} player records ---`);
  for (const k of Object.keys(players)) {
    const p = players[k];
    const name = p.person?.fullName || '';
    if (name.toLowerCase().includes('soto')) {
      const bat = p.stats?.batting || {};
      const pos = p.position?.code || '-';
      console.log(`  FOUND: "${name}"  pos=${pos}  stats: AB=${bat.atBats} H=${bat.hits} HR=${bat.homeRuns} RBI=${bat.rbi}`);
    }
  }
}

// Also list all players whose name starts with 'J' on the Mets
console.log("\n\n--- All Mets J* players (sanity) ---");
const metsSide = box.teams.home?.team?.name === 'New York Mets' ? 'home' : 'away';
const metsPlayers = box.teams[metsSide]?.players || {};
for (const k of Object.keys(metsPlayers)) {
  const p = metsPlayers[k];
  const name = p.person?.fullName || '';
  if (name.startsWith('J')) console.log(`  "${name}"  pos=${p.position?.code}`);
}
