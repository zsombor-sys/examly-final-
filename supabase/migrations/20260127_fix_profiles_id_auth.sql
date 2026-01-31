-- Ensure profiles.id links to auth.users.id and prevent ghost profiles

-- 1) Remove default from profiles.id
alter table public.profiles
  alter column id drop default;

-- 2) FK to auth.users
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end
$$;

-- 3) Clean ghost rows
delete from public.profiles
where email is null and full_name is null and phone is null;

-- 4) Defaults
alter table public.profiles
  alter column credits set default 0,
  alter column starter_granted set default false;

-- 5) Trigger to create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email, full_name, phone, credits, starter_granted)
  values (
    new.id,
    new.email,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), ''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), ''),
    5,
    true
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 6) RLS policies: only auth.uid() = id
alter table public.profiles enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;

create policy "profiles_select_own"
on public.profiles for select
using (auth.uid() = id);

create policy "profiles_update_own"
on public.profiles for update
using (auth.uid() = id);

create policy "profiles_insert_own"
on public.profiles for insert
with check (auth.uid() = id);
