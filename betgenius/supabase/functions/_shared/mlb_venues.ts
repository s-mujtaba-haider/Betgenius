// D-347 SHIP 2 — MLB venue lat/lon table for travel_getaway factor.
// Source: MLB Stats API /v1/teams?sportId=1&hydrate=venue(location) on 2026-05-27.
// Stable reference data — venues do not move during a season.

export interface MlbVenue {
  teamId: number;
  abbreviation: string;
  teamName: string;
  venueName: string;
  lat: number;
  lon: number;
}

export const MLB_VENUES: ReadonlyArray<MlbVenue> = [
  { teamId: 133, abbreviation: "ATH", teamName: "Athletics",             venueName: "Sutter Health Park",         lat: 38.57994,    lon: -121.51246 },
  { teamId: 134, abbreviation: "PIT", teamName: "Pittsburgh Pirates",    venueName: "PNC Park",                   lat: 40.446904,   lon: -80.005753 },
  { teamId: 135, abbreviation: "SD",  teamName: "San Diego Padres",      venueName: "Petco Park",                 lat: 32.707861,   lon: -117.157278 },
  { teamId: 136, abbreviation: "SEA", teamName: "Seattle Mariners",      venueName: "T-Mobile Park",              lat: 47.591333,   lon: -122.33251 },
  { teamId: 137, abbreviation: "SF",  teamName: "San Francisco Giants",  venueName: "Oracle Park",                lat: 37.778383,   lon: -122.389448 },
  { teamId: 138, abbreviation: "STL", teamName: "St. Louis Cardinals",   venueName: "Busch Stadium",              lat: 38.62256667, lon: -90.19286667 },
  { teamId: 139, abbreviation: "TB",  teamName: "Tampa Bay Rays",        venueName: "Tropicana Field",            lat: 27.767778,   lon: -82.6525 },
  { teamId: 140, abbreviation: "TEX", teamName: "Texas Rangers",         venueName: "Globe Life Field",           lat: 32.747299,   lon: -97.081818 },
  { teamId: 141, abbreviation: "TOR", teamName: "Toronto Blue Jays",     venueName: "Rogers Centre",              lat: 43.64155,    lon: -79.38915 },
  { teamId: 142, abbreviation: "MIN", teamName: "Minnesota Twins",       venueName: "Target Field",               lat: 44.981829,   lon: -93.277891 },
  { teamId: 143, abbreviation: "PHI", teamName: "Philadelphia Phillies", venueName: "Citizens Bank Park",         lat: 39.90539086, lon: -75.16716957 },
  { teamId: 144, abbreviation: "ATL", teamName: "Atlanta Braves",        venueName: "Truist Park",                lat: 33.890672,   lon: -84.467641 },
  { teamId: 145, abbreviation: "CWS", teamName: "Chicago White Sox",     venueName: "Rate Field",                 lat: 41.83,       lon: -87.634167 },
  { teamId: 146, abbreviation: "MIA", teamName: "Miami Marlins",         venueName: "loanDepot park",             lat: 25.77796236, lon: -80.21951795 },
  { teamId: 147, abbreviation: "NYY", teamName: "New York Yankees",      venueName: "Yankee Stadium",             lat: 40.82919482, lon: -73.9264977 },
  { teamId: 158, abbreviation: "MIL", teamName: "Milwaukee Brewers",     venueName: "American Family Field",      lat: 43.02838,    lon: -87.97099 },
  { teamId: 108, abbreviation: "LAA", teamName: "Los Angeles Angels",    venueName: "Angel Stadium",              lat: 33.80019044, lon: -117.8823996 },
  { teamId: 109, abbreviation: "AZ",  teamName: "Arizona Diamondbacks",  venueName: "Chase Field",                lat: 33.445302,   lon: -112.066687 },
  { teamId: 110, abbreviation: "BAL", teamName: "Baltimore Orioles",     venueName: "Oriole Park at Camden Yards", lat: 39.283787,  lon: -76.621689 },
  { teamId: 111, abbreviation: "BOS", teamName: "Boston Red Sox",        venueName: "Fenway Park",                lat: 42.346456,   lon: -71.097441 },
  { teamId: 112, abbreviation: "CHC", teamName: "Chicago Cubs",          venueName: "Wrigley Field",              lat: 41.948171,   lon: -87.655503 },
  { teamId: 113, abbreviation: "CIN", teamName: "Cincinnati Reds",       venueName: "Great American Ball Park",   lat: 39.097389,   lon: -84.506611 },
  { teamId: 114, abbreviation: "CLE", teamName: "Cleveland Guardians",   venueName: "Progressive Field",          lat: 41.495861,   lon: -81.685255 },
  { teamId: 115, abbreviation: "COL", teamName: "Colorado Rockies",      venueName: "Coors Field",                lat: 39.756042,   lon: -104.994136 },
  { teamId: 116, abbreviation: "DET", teamName: "Detroit Tigers",        venueName: "Comerica Park",              lat: 42.3391151,  lon: -83.048695 },
  { teamId: 117, abbreviation: "HOU", teamName: "Houston Astros",        venueName: "Daikin Park",                lat: 29.756967,   lon: -95.355509 },
  { teamId: 118, abbreviation: "KC",  teamName: "Kansas City Royals",    venueName: "Kauffman Stadium",           lat: 39.051567,   lon: -94.480483 },
  { teamId: 119, abbreviation: "LAD", teamName: "Los Angeles Dodgers",   venueName: "UNIQLO Field at Dodger Stadium", lat: 34.07368, lon: -118.24053 },
  { teamId: 120, abbreviation: "WSH", teamName: "Washington Nationals",  venueName: "Nationals Park",             lat: 38.872861,   lon: -77.007501 },
  { teamId: 121, abbreviation: "NYM", teamName: "New York Mets",         venueName: "Citi Field",                 lat: 40.75753012, lon: -73.84559155 },
];

// D-640 — alternate venues that are NOT a team's primary home but still
// host MLB games (off-site series, neutral-site exhibitions). Added to
// BY_VENUE_NAME only so `venueByVenueName()` resolves; team-name lookup
// for the affiliated team still returns its primary venue.
const ALTERNATE_VENUES: ReadonlyArray<MlbVenue> = [
  // Athletics off-site series (Summerlin, NV; outdoor). 6 games observed
  // in 2026 cache_mlb_game_scoreboard. Athletics' venueByTeamName still
  // returns Sutter Health Park (primary 2026 home venue).
  { teamId: 133, abbreviation: "ATH", teamName: "Athletics (alt-LV)", venueName: "Las Vegas Ballpark", lat: 36.115, lon: -115.330 },
];

const BY_TEAM_NAME = new Map<string, MlbVenue>(MLB_VENUES.map((v) => [v.teamName, v]));
const BY_TEAM_ID = new Map<number, MlbVenue>(MLB_VENUES.map((v) => [v.teamId, v]));
// D-640 — primary + alternate venues for venueByVenueName resolution.
const BY_VENUE_NAME = new Map<string, MlbVenue>([
  ...MLB_VENUES.map<[string, MlbVenue]>((v) => [v.venueName, v]),
  ...ALTERNATE_VENUES.map<[string, MlbVenue]>((v) => [v.venueName, v]),
]);

export function venueByTeamName(name: string): MlbVenue | null {
  return BY_TEAM_NAME.get(name) ?? null;
}

export function venueByTeamId(id: number): MlbVenue | null {
  return BY_TEAM_ID.get(id) ?? null;
}

export function venueByVenueName(name: string): MlbVenue | null {
  return BY_VENUE_NAME.get(name) ?? null;
}

// Haversine great-circle distance in statute miles between two lat/lon points.
export function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => d * Math.PI / 180;
  const R_MILES = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R_MILES * c;
}

// Direction: "EW" = traveling east-to-west (today's lon < yesterday's lon by ≥10°),
// "WE" = west-to-east, null = neither (small longitude delta or N/S movement).
// East-to-west has larger circadian impact per industry research.
export function travelDirection(yLon: number, tLon: number): "EW" | "WE" | null {
  const delta = tLon - yLon;
  if (delta <= -10) return "EW";
  if (delta >= 10) return "WE";
  return null;
}
