-- Client-only signup support: enforce profiles schema, uniqueness, and safe RLS.

create extension if not exists citext;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  email text not null default '',
  credits integer not null default 0,
  created_at timestamptz not null default now()
);

-- Backfill nulls before tightening constraints.
update public.profiles
set
  full_name = coalesce(full_name, ''),
  phone = coalesce(phone, ''),
  email = coalesce(email, ''),
  credits = coalesce(credits, 0)
where
  full_name is null
  or phone is null
  or email is null
  or credits is null;

alter table public.profiles
  alter column full_name set not null,
  alter column phone set not null,
  alter column email set not null,
  alter column credits set not null,
  alter column credits set default 0;

-- Ensure id FK exists (id => auth.users.id).
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_id_fkey'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_id_fkey
      foreign key (id) references auth.users(id) on delete cascade;
  end if;
end $$;

-- Required uniqueness at DB level.
create unique index if not exists profiles_phone_unique_idx
  on public.profiles (phone);

create unique index if not exists profiles_email_unique_idx
  on public.profiles (lower(email));

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;

create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using (id = auth.uid());

create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy "profiles_insert_own"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

-- Anonymous-safe availability check for signup UI; returns booleans only.
create or replace function public.check_signup_availability(p_email text, p_phone text)
returns table (email_taken boolean, phone_taken boolean)
language sql
security definer
set search_path = public
as $$
  select
    exists(
      select 1 from public.profiles
      where lower(email) = lower(coalesce(p_email, ''))
    ) as email_taken,
    exists(
      select 1 from public.profiles
      where phone = coalesce(p_phone, '')
    ) as phone_taken;
$$;

revoke all on function public.check_signup_availability(text, text) from public;
grant execute on function public.check_signup_availability(text, text) to anon, authenticated;
