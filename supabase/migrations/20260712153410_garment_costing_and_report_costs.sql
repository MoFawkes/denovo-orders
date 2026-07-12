-- Garment costing depth for the website weekly report (manager feature).
--
-- 1) style_costings gains fabric + trims inputs. Fabric cost per garment =
--    fabric_metres * fabric_price_per_metre. Trims are an itemised jsonb
--    array: [{"name":"Zip","cost":0.40,"qty":1}, ...] — cost is £ per unit,
--    qty is units per garment. NOTE: a bare `fabric text` column previously
--    existed and was dropped (20260708231132 / 20260708231953); these names
--    are deliberately different.
--    style_costings has no primary key and RLS is disabled (existing
--    convention) — the site updates rows via ilike on style_no/style.
--
-- 2) app_settings: tiny key/value store, seeded with the overhead-per-garment
--    default (£1.00). Readable by all authenticated users; writable only by
--    manager/admin (same profiles-role pattern as
--    packer_stage_and_designer_write_grants).
--
-- 3) weekly_reports gains the weekly cost totals so saved reports keep the
--    full breakdown. net for new saves = cmt - wages - fabric - trims -
--    overhead (computed client-side, as before).

alter table public.style_costings
  add column if not exists fabric_metres numeric,
  add column if not exists fabric_price_per_metre numeric,
  add column if not exists trims jsonb not null default '[]'::jsonb;

alter table public.weekly_reports
  add column if not exists fabric_cost numeric,
  add column if not exists trims_cost numeric,
  add column if not exists overhead_cost numeric;

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

create policy "authenticated can read app settings"
  on public.app_settings for select to authenticated
  using (true);

create policy "managers can insert app settings"
  on public.app_settings for insert to authenticated
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('manager', 'admin')
  ));

create policy "managers can update app settings"
  on public.app_settings for update to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('manager', 'admin')
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('manager', 'admin')
  ));

insert into public.app_settings (key, value)
values ('overhead_per_garment', '1'::jsonb)
on conflict (key) do nothing;
