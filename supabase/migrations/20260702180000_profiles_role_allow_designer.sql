-- Allow the new 'designer' role in profiles.role.
-- Drops whatever check constraint currently guards the role column (name may
-- vary since the original schema wasn't created via migrations), then
-- recreates it with the full role list.

do $$
declare c record;
begin
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'profiles'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_check
  check (role = ANY (ARRAY['packer'::text, 'manager'::text, 'admin'::text, 'designer'::text]));
