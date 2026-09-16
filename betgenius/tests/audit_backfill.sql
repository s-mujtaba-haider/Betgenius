-- Backfill Audit Query for v_market_training_features
-- This query checks for any instances where the 'historical' data used
-- actually occurred on or after the target event's commence_time.

WITH leaked_features AS (
    SELECT 
        target.id AS event_id,
        target.market_type,
        target.pick_side,
        target_event.commence_time AS target_time,
        hist_event.commence_time AS historical_time,
        hist.id AS historical_pick_id
    FROM pick_history target
    JOIN cache_mlb_historical_events target_event
        ON target_event.game_pk::text = target.game_id::text
    JOIN pick_history hist 
        ON hist.market_type = target.market_type 
        AND hist.pick_side = target.pick_side
        AND hist.is_graded = true
    JOIN cache_mlb_historical_events hist_event
        ON hist_event.game_pk::text = hist.game_id::text
    -- The core check: Are there any "historical" events that are NOT strictly before the target?
    WHERE hist_event.commence_time >= target_event.commence_time
      -- And we restrict to the intended 90-day window to emulate the view's data pull
      AND hist_event.commence_time >= (target_event.commence_time - INTERVAL '90 days')
)
SELECT 
    COUNT(*) as total_leaks,
    COUNT(DISTINCT event_id) as affected_target_events,
    MIN(historical_time - target_time) as worst_lookahead_delta
FROM leaked_features;
