-- D-643 cleanup — drop the throwaway invoke / fire / read RPCs.
-- Test bets were DELETEd via REST after verification (3 rows; user_id
-- = system seed; identifiable via D-643 doc).

DROP FUNCTION IF EXISTS public.d643_fire_resolve_picks(BOOLEAN);
DROP FUNCTION IF EXISTS public.d643_net_response(BIGINT);
DROP FUNCTION IF EXISTS public.d643_insert_test_bets();
DROP FUNCTION IF EXISTS public.d643_cleanup_test_bets(TEXT[]);
DROP FUNCTION IF EXISTS public.d643_read_bets(TEXT[]);
