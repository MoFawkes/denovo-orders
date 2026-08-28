do $$
declare
  target_source text;
begin
  select source_id into target_source
  from public.automation_executions
  where automation = 'draft-packing-list'
    and step = 'portal-handoff-confirmation-sent:258'
    and result ->> 'po' = '0070065988'
  order by completed_at desc nulls last
  limit 1;

  if target_source is null then
    raise exception 'Could not find the INV 258 allocation for PO 0070065988';
  end if;
  if exists (select 1 from public.invoice_allocations where invoice_number > 258) then
    raise exception 'Later invoice allocations exist; reconcile manually before reclaiming 256/257';
  end if;

  delete from public.invoice_allocations where invoice_number in (256, 257);
  update public.invoice_allocations set invoice_number = 256 where source_id = target_source;
  update public.automation_counters set next_value = 257, updated_at = now() where name = 'invoice_number';
  update public.orders set invoice_no = '256' where po = '0070065988';
end
$$;