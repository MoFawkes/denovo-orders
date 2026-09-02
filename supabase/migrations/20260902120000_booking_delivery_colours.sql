alter table public.orders
  add column if not exists booking_delivery_date date,
  add column if not exists booking_colour_index smallint,
  add column if not exists booking_sequence bigint,
  add column if not exists completed_at timestamptz;

-- Migration sessions have no auth.uid(), so the app's role-scoped trigger
-- must be bypassed only for this one administrative backfill.
alter table public.orders disable trigger orders_role_scoped_update;

update public.orders o
   set completed_at = latest.completed_at
  from (
    select order_id, max(created_at) as completed_at
      from public.order_events
     where new_stage = 'Completed'
     group by order_id
  ) latest
 where o.id = latest.order_id
   and o.stage = 'Completed'
   and o.completed_at is null;

alter table public.orders enable trigger orders_role_scoped_update;

create or replace function public.set_order_completed_at()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.stage = 'Completed' and old.stage is distinct from 'Completed' then
    new.completed_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists orders_set_completed_at on public.orders;
create trigger orders_set_completed_at
  before update on public.orders
  for each row execute function public.set_order_completed_at();

alter table public.orders drop constraint if exists orders_booking_colour_index_check;
alter table public.orders add constraint orders_booking_colour_index_check
  check (booking_colour_index is null or booking_colour_index between 0 and 3);

create table if not exists public.booking_delivery_days (
  delivery_date date primary key,
  colour_index smallint not null check (colour_index between 0 and 3),
  sequence bigint not null unique,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.booking_delivery_days enable row level security;
create policy "authenticated can read booking delivery days"
  on public.booking_delivery_days for select to authenticated using (true);

create or replace function public.assign_booking_delivery(p_order_ids uuid[], p_delivery_date date)
returns table(delivery_date date, colour_index smallint, sequence bigint)
language plpgsql security definer set search_path = public
as $$
declare
  v_role text;
  v_colour_index smallint;
  v_sequence bigint;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role not in ('manager', 'admin') then
    raise exception 'only managers and admins may assign booking deliveries';
  end if;

  perform pg_advisory_xact_lock(hashtext('booking_delivery_colour_sequence'));
  select b.colour_index, b.sequence into v_colour_index, v_sequence
    from public.booking_delivery_days b where b.delivery_date = p_delivery_date;

  if not found then
    select coalesce(max(b.sequence), 0) + 1 into v_sequence from public.booking_delivery_days b;
    v_colour_index := ((v_sequence - 1) % 4)::smallint;
    insert into public.booking_delivery_days(delivery_date, colour_index, sequence, created_by)
    values (p_delivery_date, v_colour_index, v_sequence, auth.uid());
  end if;

  update public.orders
     set booking_delivery_date = p_delivery_date,
         booking_colour_index = v_colour_index,
         booking_sequence = v_sequence,
         updated_by = auth.uid()
   where id = any(p_order_ids);

  return query select p_delivery_date, v_colour_index, v_sequence;
end;
$$;

revoke all on function public.assign_booking_delivery(uuid[], date) from public;
grant execute on function public.assign_booking_delivery(uuid[], date) to authenticated;
