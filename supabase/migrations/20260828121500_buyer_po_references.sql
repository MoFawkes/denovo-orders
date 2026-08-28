create table public.buyer_po_references (
  po text primary key check (po ~ '^\d{10}$'),
  csv_text text not null check (length(csv_text) > 0),
  source text not null default 'docket-email',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.buyer_po_references is
  'Private buyer PO CSV references retained during docket generation for later Portal carton CSV creation.';

alter table public.buyer_po_references enable row level security;
revoke all on table public.buyer_po_references from anon, authenticated;
