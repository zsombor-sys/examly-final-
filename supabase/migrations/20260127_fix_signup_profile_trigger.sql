-- Fix profiles id default and ensure profile is created on auth.users insert

-- 1) Ensure profiles.id has a default
alter table public.profiles
  alter column id set default gen_random_uuid();

-- 2) Ensure user_id is unique
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_user_id_key'
  ) then
    alter table public.profiles
      add constraint profiles_user_id_key unique (user_id);
  end if;
end
$$;

-- 3) Create/replace trigger function
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, user_id, full_name, phone, credits)
  values (
    new.id,
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), ''),
    coalesce(nullif(trim(new.raw_user_meta_data->>'phone'), ''), ''),
    5
  )
  on conflict (user_id) do update
    set
      full_name = excluded.full_name,
      phone = excluded.phone;

  return new;
end;
$$;

-- 4) Replace trigger on auth.users
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();
