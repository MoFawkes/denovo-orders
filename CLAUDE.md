# Denovo Orders

Garment production order tracker for Denovo Apparel. Orders move through a
pipeline of stages; managers run operations from the website, packers track
work on the factory floor from the mobile app.

## Two separate frontends — keep them in sync

| | Website | Mobile app |
|---|---|---|
| Code | `web/index.html` (single-file, vanilla JS + Tailwind) | Expo / React Native (`app/`, `components/`) |
| Users | Managers (full edit: stages, cancel, booking, import, stickers, print) | Packers (can advance stage only, see below) and managers |
| Deploy | Cloudflare Pages (`denovo-orders.pages.dev`), auto-deploys on push to `main` | Expo build |

**They share no code.** Any change to stages, order fields, or business rules
must be applied to BOTH implementations, or they drift (this has happened).
When asked for a change, confirm whether it targets the website, the app, or
both.

## Backend: Supabase

- Client config: `lib/supabase.js` (app), inline in `web/index.html` (website)
- Tables: `orders`, `order_events` (stage-change audit log), `profiles` (role per user)
- Realtime subscriptions keep both frontends live
- **Schema changes require a migration file in `supabase/migrations/`** in the
  same PR as the code change. Migrations are applied from a local session with
  the Supabase MCP server authenticated (remote/cloud sessions cannot reach
  supabase.co — network policy blocks it)

## Order stage lifecycle

`Pending` (default for new orders) → `Cutting` → `Production` → `Packing` →
`Ready` → `Booked` (dark blue; pinned to the top of active lists until
completed) → `Completed`, plus `Cancelled` (terminal, reachable from any
non-completed stage, reversible).

Enforced by DB check constraint `stage_check` and `DEFAULT 'Pending'`
(see `supabase/migrations/`). Stage changes also insert an `order_events` row.
Cancelled orders are excluded from active lists, KPIs, print sheets, and the
booking flow in both frontends.

## Roles

`profiles.role`: `packer` | `manager` | `admin` | `designer`.

- **Website**: managers/admins have full edit. Designers (make buyer samples)
  can view everything, edit notes, and toggle Sample Approved — but not
  stages, CMT, or cancel; CMT/pricing is hidden from them. Packers get
  read-only screens (the website is not used on the factory floor).
- **Mobile app**: managers/admins have full edit (`canEdit`). Packers can
  advance an order's stage forward through `Cutting → Production → Packing →
  Ready` (`canAdvanceStage` in `app/opo.tsx`) — but cannot touch
  `Booked`/`Completed`/`Cancelled`, move a stage backward, or edit notes,
  packing list, or cancel. This is app-only; the website does not grant
  packers stage edits.

This is UI-level only for *which screens render as editable* — the real
authorization boundary is Supabase RLS plus a `BEFORE UPDATE` trigger
(`enforce_role_scoped_order_update`, see
`supabase/migrations/20260702212619_packer_stage_and_designer_write_grants.sql`)
that enforces exactly which columns and stage transitions each role may
write, independent of what the UI shows.

## Gotchas

- `ex_factory` dates are stored as **YYYY-DD-MM** (e.g. `2026-12-01` = 12 Jan
  2026). See `parseExFactory()` in both frontends. Do not "fix" parsing to
  ISO without migrating the data.
- The website badge colours come from `.stage-*` CSS classes +
  `stageClass()`; the app's from `StatusChip`, `getStageAccent()`,
  `stageColor()`, and the print `stageBadge()`. A new stage needs all of them.
- Deploys: Cloudflare Pages only. Netlify and Vercel were disconnected —
  don't re-add configs for them.
- Some `orders`/`profiles` RLS policies were applied directly to the live
  project without a matching migration file (predates this doc's migration
  convention) — before assuming a policy doesn't exist, check the live
  project (`select * from pg_policies where schemaname = 'public'` via the
  Supabase MCP), not just `supabase/migrations/`.

## Workflow

- CI (`.github/workflows/ci.yml`) runs `tsc --noEmit` + `expo lint` on every
  PR — wait for green before merging.
- PRs are squash-merged; reused branches must be synced with `main` (merge or
  reset) before new work to avoid conflicts.
- Verify web changes by syntax-checking the inline `<script>` blocks
  (`node --check`); there is no build step for the website.
