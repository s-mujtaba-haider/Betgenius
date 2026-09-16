-- D-719b — RPC for chunked accent-insensitive recovery
-- Server-side unaccent. Bounded transactions. Skips collisions (HAVING COUNT(DISTINCT player_id)=1).
-- Skips team-strings (player_name LIKE '% vs %').
-- Will not touch already-populated player_id rows.

CREATE OR REPLACE FUNCTION public.d719b_recover_chunk(batch_size INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INT;
BEGIN
  WITH unaccent_unique_map AS (
    SELECT unaccent(lower(full_name)) AS key, MIN(player_id) AS player_id
    FROM cache_mlb_player_metadata
    WHERE full_name IS NOT NULL
    GROUP BY unaccent(lower(full_name))
    HAVING COUNT(DISTINCT player_id) = 1
  ),
  target AS (
    SELECT ph.id, m.player_id
    FROM pick_history ph
    JOIN unaccent_unique_map m
      ON m.key = unaccent(lower(ph.player_name))
    WHERE ph.sport = 'mlb'
      AND ph.player_id IS NULL
      AND ph.player_name IS NOT NULL
      AND ph.player_name NOT LIKE '% vs %'
    LIMIT batch_size
  ),
  upd AS (
    UPDATE pick_history ph
    SET player_id = t.player_id
    FROM target t
    WHERE ph.id = t.id
    RETURNING ph.id
  )
  SELECT count(*) INTO updated_count FROM upd;
  RETURN updated_count;
END
$$;

GRANT EXECUTE ON FUNCTION public.d719b_recover_chunk(INT) TO service_role;
