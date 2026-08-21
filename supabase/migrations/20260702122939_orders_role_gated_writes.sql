-- orders: replace role-blind policies with manager/admin-gated writes.
-- Packer read-only was previously only enforced client-side (canEdit in app/opo.tsx);
-- any authenticated user could insert/update orders directly via the API.
drop policy if exists "Authenticated users can insert orders" on public.orders;
drop policy if exists "Authenticated users can update orders" on public.orders;
drop policy if exists "authenticated can insert orders" on public.orders;
drop policy if exists "authenticated can update orders" on public.orders;
drop policy if exists "authenticated can read orders" on public.orders;

create policy "authenticated can read orders"
  on public.orders for select
  to authenticated
  using (true);

create policy "manager/admin can insert orders"
  on public.orders for insert
  to authenticated
  with check (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('manager', 'admin'))
  );

create policy "manager/admin can update orders"
  on public.orders for update
  to authenticated
  using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('manager', 'admin'))
  )
  with check (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('manager', 'admin'))
  );

-- profiles: block role self-escalation. No app code writes this column client-side;
-- without this, a packer could UPDATE profiles SET role='admin' on their own row and
-- defeat the orders policies above. The table-wide UPDATE grant implies all columns,
-- so revoke it and re-grant UPDATE only on the column the app actually lets users
-- edit (full_name); role (and everything else) stays out of reach regardless of RLS.
revoke update on public.profiles from authenticated, anon;
grant update (full_name) on public.profiles to authenticated;
