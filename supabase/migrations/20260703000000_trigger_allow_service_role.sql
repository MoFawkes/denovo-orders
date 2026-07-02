-- enforce_role_scoped_order_update looks up the caller's profiles.role via
-- auth.uid(), but service-role callers (e.g. the mark-sample-approved edge
-- function used by the Gmail automation) have no auth.uid() at all, so they
-- fell through to the trigger's final "not authorized" branch. Service-role
-- already bypasses RLS by design — this makes the trigger consistent with
-- that instead of silently rejecting every service-role write.

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
  if auth.role() = 'service_role' then
    return new;
  end if;

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
