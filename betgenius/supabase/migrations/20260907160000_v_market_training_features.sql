CREATE OR REPLACE VIEW v_market_training_features AS
SELECT 
    target.id AS event_id,
    target.market_type,
    target.pick_side,
    AVG(CASE WHEN hist.is_hit = true THEN 1.0 ELSE 0.0 END) as historical_win_rate,
    STDDEV(hist.confidence) as confidence_variance,
    COUNT(hist.id) as sample_size,
    AVG(hist.odds_decimal) as avg_closing_line
FROM pick_history target
LEFT JOIN cache_mlb_historical_events target_event
    ON target_event.game_pk::text = target.game_id::text
LEFT JOIN pick_history hist 
    ON hist.market_type = target.market_type 
    AND hist.pick_side = target.pick_side
    AND hist.is_graded = true
LEFT JOIN cache_mlb_historical_events hist_event
    ON hist_event.game_pk::text = hist.game_id::text
    AND hist_event.commence_time >= (target_event.commence_time - INTERVAL '90 days')
    AND hist_event.commence_time < target_event.commence_time
WHERE hist_event.commence_time IS NOT NULL
GROUP BY target.id, target.market_type, target.pick_side;
