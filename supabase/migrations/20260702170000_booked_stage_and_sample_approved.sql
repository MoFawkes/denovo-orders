alter table public.orders
  drop constraint stage_check;

alter table public.orders
  add constraint stage_check
  check (stage = ANY (ARRAY['Pending'::text, 'Cutting'::text, 'Production'::text, 'Packing'::text, 'Ready'::text, 'Booked'::text, 'Completed'::text, 'Cancelled'::text]));

alter table public.orders
  add column if not exists sample_approved boolean not null default false;
