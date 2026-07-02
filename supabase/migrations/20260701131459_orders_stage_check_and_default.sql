alter table public.orders
  drop constraint stage_check;

alter table public.orders
  add constraint stage_check
  check (stage = ANY (ARRAY['Pending'::text, 'Cutting'::text, 'Production'::text, 'Packing'::text, 'Ready'::text, 'Completed'::text, 'Cancelled'::text]));

alter table public.orders
  alter column stage set default 'Pending';
