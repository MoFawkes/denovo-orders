alter table public.order_events
  add column if not exists metadata jsonb;

create index if not exists order_events_order_id_created_at_idx
  on public.order_events (order_id, created_at desc);
