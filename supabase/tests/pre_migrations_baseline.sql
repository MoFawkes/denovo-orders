-- Minimal representation of the schema that predates this repository's
-- migration history. CI loads it only to prove every tracked migration can be
-- applied in timestamp order; production remains the schema authority.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;
create table auth.users (
  id uuid primary key
);
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;

create table public.profiles (
  id uuid primary key,
  full_name text,
  role text not null check (role in ('packer', 'manager', 'admin'))
);

create table public.orders (
  id uuid primary key,
  stage text default 'Pending' constraint stage_check
    check (stage in ('Pending', 'Cutting', 'Production', 'Packing', 'Ready', 'Completed', 'Cancelled')),
  notes text,
  updated_at timestamptz,
  updated_by uuid
);
alter table public.orders enable row level security;

create table public.style_costings (id uuid primary key);

create table public.order_events (
  id uuid primary key,
  order_id uuid references public.orders (id) on delete cascade,
  old_stage text,
  new_stage text,
  changed_by uuid references public.profiles (id),
  created_at timestamptz default now()
);

create table public.weekly_reports (
  id uuid primary key,
  week_start date,
  week_end date,
  total_qty integer,
  total_cmt numeric,
  hours_worked numeric,
  wage_cost numeric,
  net numeric,
  created_at timestamptz default now()
);

