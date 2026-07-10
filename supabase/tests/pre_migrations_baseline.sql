-- Minimal representation of the schema that predates this repository's
-- migration history. CI loads it only to prove every tracked migration can be
-- applied in timestamp order; production remains the schema authority.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;

create table public.profiles (
  id uuid primary key,
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

