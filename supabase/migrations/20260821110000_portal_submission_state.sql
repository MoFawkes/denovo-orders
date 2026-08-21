create table public.portal_submissions (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  execution_id uuid not null,
  po text not null check (po ~ '^\d{10}$'),
  gmail_thread_id text not null,
  invoice_id text not null,
  workbook_sha256 text not null check (workbook_sha256 ~ '^[0-9a-f]{64}$'),
  row_digest text not null check (row_digest ~ '^[0-9a-f]{64}$'),
  source_revision text not null,
  expected_carton_count integer not null check (expected_carton_count > 0),
  state text not null check (state in (
    'prepared', 'claimed', 'portal-submitted', 'bels-generated',
    'bels-downloaded', 'delivered', 'failed-before-submit', 'uncertain-after-submit'
  )),
  result jsonb not null default '{}'::jsonb,
  last_error text,
  claimed_by text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  delivered_at timestamptz
);

comment on table public.portal_submissions is
  'Durable transaction state for non-idempotent ISC Portal carton submissions.';

alter table public.portal_submissions enable row level security;
revoke all on table public.portal_submissions from anon, authenticated;
grant select, insert, update on table public.portal_submissions to service_role;

create or replace function public.claim_portal_submission(
  submission jsonb,
  runner_id text
) returns public.portal_submissions
language plpgsql
security definer
set search_path = public
as $$
declare claimed public.portal_submissions;
begin
  insert into public.portal_submissions (
    idempotency_key, execution_id, po, gmail_thread_id, invoice_id,
    workbook_sha256, row_digest, source_revision, expected_carton_count, state
  ) values (
    submission->>'idempotencyKey', (submission->>'executionId')::uuid,
    submission->>'po', submission->>'gmailThreadId', submission->>'invoiceId',
    submission->>'workbookSha256', submission->>'rowDigest',
    submission->>'sourceRevision', (submission->>'expectedCartonCount')::integer,
    'prepared'
  ) on conflict (idempotency_key) do nothing;

  update public.portal_submissions
  set state = 'claimed', claimed_by = runner_id, claimed_at = now(), updated_at = now(), last_error = null
  where idempotency_key = submission->>'idempotencyKey'
    and state in ('prepared', 'failed-before-submit')
  returning * into claimed;

  if claimed.id is null then
    select * into claimed from public.portal_submissions
    where idempotency_key = submission->>'idempotencyKey';
  end if;
  return claimed;
end;
$$;

revoke all on function public.claim_portal_submission(jsonb, text) from public;
grant execute on function public.claim_portal_submission(jsonb, text) to service_role;

create or replace function public.transition_portal_submission(
  submission_key text,
  expected_state text,
  next_state text,
  patch jsonb default '{}'::jsonb,
  error_text text default null
) returns public.portal_submissions
language plpgsql
security definer
set search_path = public
as $$
declare changed public.portal_submissions;
begin
  if not (
    (expected_state = 'claimed' and next_state in ('portal-submitted', 'failed-before-submit', 'uncertain-after-submit')) or
    (expected_state = 'portal-submitted' and next_state in ('bels-generated', 'uncertain-after-submit')) or
    (expected_state = 'bels-generated' and next_state in ('bels-downloaded', 'uncertain-after-submit')) or
    (expected_state = 'bels-downloaded' and next_state in ('delivered', 'uncertain-after-submit'))
  ) then raise exception 'invalid portal state transition: % -> %', expected_state, next_state;
  end if;

  update public.portal_submissions set
    state = next_state,
    result = result || coalesce(patch, '{}'::jsonb),
    last_error = error_text,
    updated_at = now(),
    submitted_at = case when next_state = 'portal-submitted' then now() else submitted_at end,
    delivered_at = case when next_state = 'delivered' then now() else delivered_at end
  where idempotency_key = submission_key and state = expected_state
  returning * into changed;
  if changed.id is null then raise exception 'portal submission state changed concurrently'; end if;
  return changed;
end;
$$;

revoke all on function public.transition_portal_submission(text, text, text, jsonb, text) from public;
grant execute on function public.transition_portal_submission(text, text, text, jsonb, text) to service_role;
