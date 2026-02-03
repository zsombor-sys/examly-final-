-- Profiles tied to auth.users and created by trigger

alter table public.profiles
  alter column id drop default;

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

alter table public.profiles
  drop column if exists user_id;

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
  on conflict (id) do update
    set
      email = excluded.email,
      full_name = excluded.full_name,
      phone = excluded.phone;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles: read own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;

create policy "profiles_select_own"
on public.profiles for select
using (auth.uid() = id);

create policy "profiles_update_own"
on public.profiles for update
using (auth.uid() = id);
