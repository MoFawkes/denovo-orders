-- Packers can advance orders through the working stages from the mobile app
-- (Cutting/Production/Packing/Ready), and designers can actually save the
-- notes/sample_approved edits the UI already exposes to them (the designer
-- role was added to profiles.role but never granted to the orders RLS
-- policy, so those writes were silently rejected).
--
-- Row-level security only grants packer/designer the *attempt* to UPDATE;
-- this trigger enforces which columns and stage transitions are actually
-- allowed for each role. manager/admin keep unrestricted update access.

create or replace function public.enforce_role_scoped_order_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_forward_stages text[] := array['Pending', 'Cutting', 'Production', 'Packing', 'Ready'];
  v_rank_old int;
  v_rank_new int;
begin
  select role into v_role from public.profiles where id = auth.uid();

  if v_role in ('manager', 'admin') then
    return new;
  end if;

  if v_role = 'packer' then
    if (to_jsonb(old) - array['stage', 'updated_at', 'updated_by'])
       is distinct from (to_jsonb(new) - array['stage', 'updated_at', 'updated_by']) then
      raise exception 'packers may only update order stage';
    end if;

    if old.stage in ('Booked', 'Completed', 'Cancelled') then
      raise exception 'cannot change stage of a booked, completed, or cancelled order';
    end if;

    if new.stage is null or not (new.stage = any (v_forward_stages)) or new.stage = 'Pending' then
      raise exception 'packers may only advance orders to Cutting, Production, Packing, or Ready';
    end if;

    v_rank_old := array_position(v_forward_stages, old.stage);
    v_rank_new := array_position(v_forward_stages, new.stage);
    if v_rank_old is null or v_rank_new is null or v_rank_new <= v_rank_old then
      raise exception 'packers may only move orders forward';
    end if;

    return new;
  end if;

  if v_role = 'designer' then
    if (to_jsonb(old) - array['notes', 'sample_approved', 'updated_at', 'updated_by'])
       is distinct from (to_jsonb(new) - array['notes', 'sample_approved', 'updated_at', 'updated_by']) then
      raise exception 'designers may only edit notes and sample approval';
    end if;

    return new;
  end if;

  raise exception 'not authorized to update orders';
end;
$$;

drop trigger if exists orders_role_scoped_update on public.orders;
create trigger orders_role_scoped_update
  before update on public.orders
  for each row execute function public.enforce_role_scoped_order_update();

create policy "packer can update order stage" on public.orders
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'packer'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'packer'));

create policy "designer can update orders" on public.orders
  for update to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'designer'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'designer'));
