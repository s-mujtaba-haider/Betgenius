"""Pull the warehouse tables the uplift pipeline never read, read-only.

Round 3 found five tables in the warehouse that `dump_box.ts` and `dump_odds.ts`
do not touch. Three of them are usable and two are not; this file pulls the
usable ones and records why the others were left.

  cache_mlb_player_metadata          bats / throws / position / birth date.
                                     STATIC player attributes -- handedness does
                                     not change, so there is no as-of question
                                     to get wrong. features.py has no handedness
                                     of any kind today, which is the gap this
                                     closes.
  cache_mlb_historical_opposing_pitcher
                                     the announced starter for each side, with
                                     his throwing hand. Probable starters are
                                     published a day or more ahead, which is the
                                     same assumption features.starters() already
                                     makes about starter identity.
  cache_mlb_historical_weather       temperature, wind, humidity and a dome flag
                                     at the venue. open-meteo reanalysis, so it
                                     is the weather that HAPPENED, not the
                                     forecast a bettor would have had. Pulled so
                                     the question can be measured, and handled
                                     carefully downstream: see FORECAST NOTE.

NOT pulled, and why:

  cache_mlb_historical_lineups       every one of its 135,324 rows was written
                                     AFTER first pitch (minimum +87.5 hours,
                                     mean +600 days). It is the game's own
                                     lineup, backfilled. Using it would be
                                     exactly the leak check_asof.py exists to
                                     catch, and the as-of batting-order slot
                                     features.lineup_slot() already builds from
                                     earlier box scores is the honest version.
  cache_statcast_*                   a genuine daily series -- 117 distinct
                                     snapshot_dates, each written the same day --
                                     but it starts 2026-05-20, three months into
                                     a 29-month evaluation. There is no way to
                                     build a feature for 2024 out of it.
  cache_mlb_historical_bullpen       ends 2025-10-31, and features.bullpen()
                                     already rebuilds the same quantities from
                                     relief box-score lines across the full
                                     range.

FORECAST NOTE. Weather here is the realised value at first pitch. Production
would have a forecast instead. Realised weather is not caused by the game, so it
is not outcome leakage, but it is sharper than what a bettor could have had. Any
experiment that uses it must (a) be labelled as requiring a forecast feed in
production and (b) be re-run with forecast-scale noise added before it is
believed. `is_dome` and the venue coordinates are exempt: they are static.

    python harness/uplift/dump_aux.py
"""
import os
import re
import sys

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
ENV = os.path.join(HERE, "..", ".env")

QUERIES = {
    "player_metadata": """
        select player_id, full_name, primary_position, bats, throws,
               birth_date, mlb_debut_date
          from cache_mlb_player_metadata""",
    "opposing_pitcher": """
        select o.event_id, o.game_pk,
               o.home_starter_id, o.home_starter_name, o.home_starter_hand,
               o.away_starter_id, o.away_starter_name, o.away_starter_hand
          from cache_mlb_historical_opposing_pitcher o""",
    "weather": """
        select w.event_id, w.commence_time, w.venue_name, w.lat, w.lon,
               w.temperature_f, w.wind_speed_mph, w.wind_direction_degrees,
               w.precipitation_mm, w.humidity_pct, w.is_dome, w.source
          from cache_mlb_historical_weather w""",
}


def main():
    import psycopg

    url = re.search(r"HARNESS_DATABASE_URL=(\S+)", open(ENV).read()).group(1).strip("\"'")
    os.makedirs(DATA, exist_ok=True)
    with psycopg.connect(url, connect_timeout=30) as cn:
        cn.read_only = True
        for name, sql in QUERIES.items():
            d = pd.read_sql(sql, cn)
            out = os.path.join(DATA, f"aux_{name}.csv")
            d.to_csv(out, index=False)
            print(f"  aux_{name}.csv  {len(d):,} rows  {d.shape[1]} cols")
    print("\ndone. Nothing was written to the database.")


if __name__ == "__main__":
    main()
