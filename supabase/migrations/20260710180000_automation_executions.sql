create table public.automation_executions (
  automation text not null,
  source_id text not null,
  step text not null,
  status text not null check (status in ('completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  result jsonb not null default '{}'::jsonb,
  last_error text,
  first_attempted_at timestamptz not null default now(),
  last_attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (automation, source_id, step)
);

comment on table public.automation_executions is
  'Durable checkpoints for retry-safe Gmail and Drive automations.';

alter table public.automation_executions enable row level security;

-- Deliberately no policies: browser/authenticated clients cannot see or
-- mutate operational state. The service role used by GitHub Actions bypasses
-- RLS and is the only caller.
revoke all on table public.automation_executions from anon, authenticated;

