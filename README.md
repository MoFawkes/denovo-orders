# Denovo Orders

Denovo Apparel's production order tracker. Managers work from the website,
factory staff use the Expo app, and scheduled Gmail/Drive automations move
orders through the booking and dispatch pipeline.

## System overview

| Area | Location | Purpose |
|---|---|---|
| Manager website | `web/index.html` | Import, edit, book, complete, export Portal cartons, print, and report on orders |
| Mobile app | `app/`, `components/` | Factory-floor stage tracking and operational views |
| Backend | `supabase/` | PostgreSQL schema, RLS, audit events, and edge functions |
| Mail/Drive automation | `scripts/gmail-automations/` | Dockets, sample approvals, bookings, and packing lists |
| CI and schedules | `.github/workflows/` | Pull-request checks and hourly production automation |

The website and mobile app share Supabase but do not share frontend code.
Changes to stages, fields, permissions, or business rules may need to be made
in both frontends.

## Order lifecycle

```text
Pending → Cutting → Production → Packing → Ready → Booked → Completed
    └──────────────────── Cancelled (terminal) ────────────────────┘
```

Database constraints, RLS, and `enforce_role_scoped_order_update` are the
authorization boundary. UI checks improve usability but are not security
controls.

## Local development

Requirements: Node.js 20+ for the Expo app and Node.js 22 for production
automation parity.

```bash
npm ci
npm run start
```

Useful checks:

```bash
npx tsc --noEmit
npm run lint
cd scripts/gmail-automations
npm ci
npm test
```

Local Supabase and Expo values belong in ignored environment files. Never put
OAuth refresh tokens, service-role keys, or automation secrets in the repo.

## Frontend deployment

- The website is deployed to Cloudflare Pages from `main`.
- Mobile builds and updates use the profiles in `eas.json`.
- Pull requests run type-checking, Expo lint, automation syntax checks, and
  automation regression tests.

## Database changes

Every schema, trigger, policy, or function change must have a timestamped SQL
migration in `supabase/migrations/`. Test the migration against a non-production
database before applying it to production. Service-role automation bypasses
RLS, so new service-role operations require extra review.

## Gmail and packing-list pipeline

The hourly workflow performs five operations:

1. Detect sample approvals and booking confirmations in Gmail.
2. Generate order dockets from sourcing emails.
3. Read photographed packing dockets and request a human-supplied invoice.
4. Generate the packing-list workbook in Drive; the manager then combines it
   with the current buyer PO reference on the Portal Carton Upload screen.
5. Complete the matching Booked order and close its Google Task.

Durable checkpoints in `automation_executions` make reply and upload retries
recoverable. Operational setup, labels, secrets, and recovery instructions are
in [`scripts/gmail-automations/README.md`](scripts/gmail-automations/README.md).

The Debenhams Group ISC Portal, not Denovo, generates SSCCs and the printable
BEL PDFs. Denovo's website exports only the Portal carton-upload CSV. Carton
type and the buyer's full per-size SKU/expected quantity are supplied per
shipment and are deliberately not persisted on the order.

## Production cautions

- `ex_factory` currently uses the historical `YYYY-DD-MM` representation.
  Do not treat it as ISO without a data migration.
- Packing-list matching requires both PO and SKU; filenames are not unique
  enough to identify an order.
- Do not manually remove automation labels without first checking the durable
  checkpoint for that Gmail thread or Drive file.
- Keep local agent state under `.claude/` untracked.

## Recovery

When an hourly run fails, inspect its GitHub Actions summary and the relevant
row in `automation_executions`. Fix the underlying credential, input, or API
problem and rerun the workflow manually. Completed checkpoints are reused, so
retries should not resend a recorded reply or re-upload a recorded workbook.
