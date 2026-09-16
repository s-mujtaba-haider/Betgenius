-- D-737f-A SHIP 0 — Delete duplicate rows in pitcher_k_rescore_results
-- (D-737f-C's determinism rerun produced 211 picks × 2 = 422 rows).
-- Keep only the most-recent rescore per pick_id.

DELETE FROM pitcher_k_rescore_results
WHERE id NOT IN (
  SELECT DISTINCT ON (pick_id) id
  FROM pitcher_k_rescore_results
  ORDER BY pick_id, rescored_at DESC
);
