-- Ensure profiles.user_id is unique + FK to auth.users
alter table public.profiles add column if not exists user_id uuid;

update public.profiles
set user_id = id
where user_id is null
  and id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_user_id_fkey'
  ) then
    alter table public.profiles
      add constraint profiles_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end
$$;

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

-- Unique phone (allows multiple NULLs)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_phone_key'
  ) then
    alter table public.profiles
      add constraint profiles_phone_key unique (phone);
  end if;
end
$$;

-- Create profile row on auth.users insert
create or replace function public.handle_auth_user_created()
returns trigger language plpgsql as $$
declare
  has_id boolean;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'id'
  ) into has_id;

  if has_id then
    execute '
      insert into public.profiles (id, user_id, full_name, phone, credits)
      values ($1, $1, $2, $3, $4)
      on conflict (user_id) do nothing'
    using
      new.id,
      nullif(trim(new.raw_user_meta_data->>''full_name''), ''''),
      nullif(trim(new.raw_user_meta_data->>''phone''), ''''),
      5;
  else
    execute '
      insert into public.profiles (user_id, full_name, phone, credits)
      values ($1, $2, $3, $4)
      on conflict (user_id) do nothing'
    using
      new.id,
      nullif(trim(new.raw_user_meta_data->>''full_name''), ''''),
      nullif(trim(new.raw_user_meta_data->>''phone''), ''''),
      5;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_auth_user_created();
