UPDATE public.home_pool_state
   SET current_mode = 'baseline',
       notes = 'cleared stale guest_heat (no active order)',
       last_synced_at = now()
 WHERE home_id = '2a55e76b-f9b4-4b21-ae9b-a9df3b112d92'
   AND current_mode = 'guest_heat';