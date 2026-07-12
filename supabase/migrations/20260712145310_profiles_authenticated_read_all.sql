create policy "Authenticated users can read profiles"
  on public.profiles
  for select
  to authenticated
  using (true);
