-- Add missing columns to public.plans for plan generation pipeline.
alter table public.plans add column if not exists prompt text;
alter table public.plans add column if not exists generation_id uuid;
alter table public.plans add column if not exists credits_charged integer;
alter table public.plans add column if not exists language text;
alter table public.plans add column if not exists model text;
alter table public.plans add column if not exists materials jsonb;
alter table public.plans add column if not exists result jsonb;

-- Simple credits table for generation usage.
create table if not exists public.user_credits (
  user_id uuid primary key,
  credits integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Backfill from profiles if present.
insert into public.user_credits (user_id, credits)
select id, credits from public.profiles
on conflict (user_id) do nothing;

-- After applying, reload PostgREST schema:
-- notify pgrst, 'reload schema';
