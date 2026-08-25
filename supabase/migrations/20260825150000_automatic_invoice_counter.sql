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

create or replace function public.allocate_automation_counter(
  counter_name text,
  floor_value bigint default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare allocated bigint;
begin
  if counter_name is null or btrim(counter_name) = '' then
    raise exception 'counter_name is required';
  end if;
  if floor_value is not null and floor_value < 1 then
    raise exception 'floor_value must be positive';
  end if;

  insert into public.automation_counters (name, next_value)
  values (counter_name, coalesce(floor_value, 1) + 1)
  on conflict (name) do update set
    next_value = greatest(
      public.automation_counters.next_value,
      coalesce(floor_value, public.automation_counters.next_value)
    ) + 1,
    updated_at = now()
  returning next_value - 1 into allocated;

  return allocated;
end;
$$;

revoke all on function public.allocate_automation_counter(text, bigint) from public;
grant execute on function public.allocate_automation_counter(text, bigint) to service_role;
