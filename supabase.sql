-- Examly (clean reset) - run this in a NEW Supabase project.

-- 1) PROFILES
create table if not exists public.profiles (
  id uuid primary key,
  email text,
  full_name text,
  phone text,
  phone_normalized text unique,
  credits integer not null default 0,
  starter_granted boolean not null default false,

  stripe_customer_id text,
  stripe_payment_method_id text,
  auto_recharge boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_phone_norm_idx on public.profiles(phone_normalized);

-- Updated timestamp helper
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tr_profiles_touch on public.profiles;
create trigger tr_profiles_touch
before update on public.profiles
for each row execute function public.touch_updated_at();

-- 1b) PLANS
create table if not exists public.plans (
  id uuid primary key,
  user_id uuid not null,
  title text,
  created_at timestamptz not null default now(),
  result jsonb,
  notes_json jsonb,
  daily_json jsonb,
  practice_json jsonb,
  generation_status text,
  error text,
  raw_notes_output text
);

create index if not exists plans_user_created_idx on public.plans(user_id, created_at desc);

-- 2) STRIPE EVENT IDEMPOTENCY
create table if not exists public.stripe_events (
  id bigserial primary key,
  event_id text not null unique,
  type text,
  created_at timestamptz not null default now()
);

-- 3) CREDIT CONSUMPTION (atomic)
-- Raises: NO_CREDITS
create or replace function public.consume_generation(p_user_id uuid)
returns json language plpgsql as $$
declare
  p public.profiles;
begin
  select * into p from public.profiles where id = p_user_id for update;

  if not found then
    insert into public.profiles(id, credits, starter_granted) values (p_user_id, 0, false)
    returning * into p;
  end if;

  if coalesce(p.credits, 0) <= 0 then
    raise exception 'NO_CREDITS' using errcode = 'P0001';
  end if;

  update public.profiles
    set credits = p.credits - 1
  where id = p_user_id;

  select * into p from public.profiles where id = p_user_id;
  return json_build_object('mode','credits','profile',row_to_json(p));
end;
$$;

-- 4) STARTER CREDITS (atomic, phone-unique)
-- Gives starter credits once per profile AND once per phone number.
-- Raises: PHONE_USED
create or replace function public.grant_starter_credits(p_user_id uuid, p_phone_norm text, p_amount int)
returns json language plpgsql as $$
declare
  p public.profiles;
  used boolean;
begin
  select * into p from public.profiles where id = p_user_id for update;
  if not found then
    insert into public.profiles(id, credits, starter_granted, phone_normalized)
    values (p_user_id, 0, false, p_phone_norm)
    returning * into p;
  end if;

  if p.starter_granted then
    return json_build_object('ok', true, 'skipped', true, 'reason', 'already_granted', 'profile', row_to_json(p));
  end if;

  if p_phone_norm is null or length(trim(p_phone_norm)) = 0 then
    return json_build_object('ok', false, 'skipped', true, 'reason', 'missing_phone');
  end if;

  select exists(select 1 from public.profiles where phone_normalized = p_phone_norm and id <> p_user_id) into used;
  if used then
    raise exception 'PHONE_USED' using errcode = 'P0001';
  end if;

  update public.profiles
    set
      phone_normalized = p_phone_norm,
      starter_granted = true,
      credits = coalesce(credits,0) + p_amount
  where id = p_user_id
  returning * into p;

  return json_build_object('ok', true, 'profile', row_to_json(p));
end;
$$;

-- 5) STORAGE
-- Create a private bucket named "uploads".
-- In Supabase Dashboard > Storage > Buckets.
-- Suggested policies (authenticated only, own folder):
-- bucket: uploads (private)
-- Policy (insert):
--   (bucket_id = 'uploads' AND auth.role() = 'authenticated' AND (storage.foldername(name))[1] = auth.uid()::text)
-- Policy (select):
--   (bucket_id = 'uploads' AND auth.role() = 'authenticated' AND (storage.foldername(name))[1] = auth.uid()::text)

-- 6) RLS
alter table public.profiles enable row level security;
alter table public.plans enable row level security;

drop policy if exists "profiles: read own" on public.profiles;
create policy "profiles: read own" on public.profiles
for select
using (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
for update
using (auth.uid() = id);

drop policy if exists "plans: read own" on public.plans;
create policy "plans: read own" on public.plans
for select
using (auth.uid() = user_id);

drop policy if exists "plans: update own" on public.plans;
create policy "plans: update own" on public.plans
for update
using (auth.uid() = user_id);

-- Inserts are done by service role (server) via SUPABASE_SERVICE_ROLE_KEY.
