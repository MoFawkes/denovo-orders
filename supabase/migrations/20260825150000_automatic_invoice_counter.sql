create table public.automation_counters (
  name text primary key,
  next_value bigint not null check (next_value > 0),
  updated_at timestamptz not null default now()
);

comment on table public.automation_counters is
  'Atomic counters reserved for server-side automations; invoice_number stores the next invoice to allocate.';

alter table public.automation_counters enable row level security;
revoke all on table public.automation_counters from anon, authenticated;
grant select, insert, update on table public.automation_counters to service_role;

insert into public.automation_counters (name, next_value)
values ('invoice_number', 256)
on conflict (name) do nothing;

create table public.invoice_allocations (
  source_id text primary key,
  invoice_number bigint not null unique check (invoice_number > 0),
  created_at timestamptz not null default now()
);

comment on table public.invoice_allocations is
  'Idempotent invoice assignment per Gmail thread.';

alter table public.invoice_allocations enable row level security;
revoke all on table public.invoice_allocations from anon, authenticated;
grant select, insert on table public.invoice_allocations to service_role;

create or replace function public.allocate_invoice_number(
  allocation_source_id text,
  floor_value bigint default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare allocated bigint;
begin
  if allocation_source_id is null or btrim(allocation_source_id) = '' then
    raise exception 'allocation_source_id is required';
  end if;
  if floor_value is not null and floor_value < 1 then
    raise exception 'floor_value must be positive';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('invoice_number', 0));

  select invoice_number into allocated
  from public.invoice_allocations
  where source_id = allocation_source_id;
  if allocated is not null then return allocated; end if;

  update public.automation_counters
  set next_value = greatest(next_value, coalesce(floor_value, next_value)) + 1,
      updated_at = now()
  where name = 'invoice_number'
  returning next_value - 1 into allocated;

  insert into public.invoice_allocations (source_id, invoice_number)
  values (allocation_source_id, allocated);
  return allocated;
end;
$;

revoke all on function public.allocate_invoice_number(text, bigint) from public;
grant execute on function public.allocate_invoice_number(text, bigint) to service_role;
