"""Phase 1 MLB — read-only market inventory behind PHASE1_SCOPE.md.

Every number in sections 2-4 of harness/PHASE1_SCOPE.md comes from this
script, so the client can re-run it and check the claims rather than trust
the write-up.

Read-only: SELECT statements only, one connection, sequential queries
(harness_readonly is connection-capped).

Usage:
    pip install psycopg2-binary
    export HARNESS_DATABASE_URL='postgresql://...'   # or harness/.env
    python harness/scripts/phase1_market_inventory.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2

HARNESS_DIR = Path(__file__).resolve().parents[1]


def load_conn() -> str:
    """Connection string from the environment, falling back to harness/.env."""
    url = os.environ.get("HARNESS_DATABASE_URL")
    if url:
        return url

    env_file = HARNESS_DIR / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("HARNESS_DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip("\"'")

    sys.exit(
        "Set HARNESS_DATABASE_URL, or copy harness/.env.example to "
        "harness/.env and fill it in."
    )


QUERIES: list[tuple[str, str]] = [
    (
        "Warehouse market inventory (cache_mlb_historical_odds)",
        """
        select market_key,
               count(*) as rows,
               count(distinct event_id) as events,
               min(commence_time)::date as first_game,
               max(commence_time)::date as last_game
        from public.cache_mlb_historical_odds
        group by market_key
        order by rows desc
        """,
    ),
    (
        "Game-market encoding — side lives in market_key, price in over_odds",
        """
        select market_key, line, over_odds, under_odds, home_team, away_team
        from public.cache_mlb_historical_odds
        where market_key in ('h2h__home','h2h__away','spreads__home',
                             'spreads__away','totals')
          and commence_time >= '2026-05-01'
          and bookmaker_key = 'fanduel'
        order by market_key
        limit 12
        """,
    ),
    (
        "Snapshot depth — determines whether harness CLV is computable",
        """
        select market_key,
               round(avg(snaps), 2) as avg_snapshots,
               max(snaps) as max_snapshots,
               count(*) as event_groups
        from (
          select market_key, event_id, count(distinct snapshot_timestamp) as snaps
          from public.cache_mlb_historical_odds
          where market_key in ('h2h__home','spreads__home','totals','batter_hits')
            and commence_time >= '2026-04-25'
          group by market_key, event_id
        ) s
        group by market_key
        order by market_key
        """,
    ),
    (
        "Game markets already firing in production (pick_history)",
        """
        select prop_type,
               count(*) as picks,
               count(*) filter (where hit is not null) as graded,
               min(game_date)::text as first_date,
               max(game_date)::text as last_date
        from public.pick_history
        where sport = 'mlb'
          and prop_type in ('h2h','spreads','totals','game_total','game_side')
        group by prop_type
        order by picks desc
        """,
    ),
    (
        "Tables harness_readonly can read",
        """
        select table_name
        from information_schema.table_privileges
        where grantee = 'harness_readonly'
          and privilege_type = 'SELECT'
        order by table_name
        """,
    ),
]


def run(cur, title: str, sql: str) -> None:
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)
    try:
        cur.execute(sql)
    except Exception as e:
        print("  ERROR:", str(e).splitlines()[0])
        return

    rows = cur.fetchall()
    if not rows:
        print("  (no rows)")
        return

    cols = [d[0] for d in cur.description]
    print("  " + " | ".join(cols))
    print("  " + "-" * 70)
    for row in rows:
        print("  " + " | ".join("" if v is None else str(v) for v in row))


def main() -> None:
    conn = psycopg2.connect(load_conn(), connect_timeout=25)
    conn.autocommit = True
    cur = conn.cursor()
    try:
        for title, sql in QUERIES:
            run(cur, title, sql)
    finally:
        cur.close()
        conn.close()
        print("\nconnection closed")


if __name__ == "__main__":
    main()
