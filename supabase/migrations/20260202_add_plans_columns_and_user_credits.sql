-- Add missing columns to public.plans for plan generation pipeline.
create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  prompt text not null,
  language text not null,
  model text not null default 'gpt-4.1',
  plan_json jsonb not null,
  notes_json jsonb not null,
  daily_json jsonb not null,
  practice_json jsonb not null,
  credits_charged int not null default 1,
  input_chars int,
  images_count int,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.plans add column if not exists prompt text;
alter table public.plans add column if not exists language text;
alter table public.plans add column if not exists model text;
alter table public.plans add column if not exists plan_json jsonb;
alter table public.plans add column if not exists notes_json jsonb;
alter table public.plans add column if not exists daily_json jsonb;
alter table public.plans add column if not exists practice_json jsonb;
alter table public.plans add column if not exists credits_charged int;
alter table public.plans add column if not exists input_chars int;
alter table public.plans add column if not exists images_count int;
alter table public.plans add column if not exists updated_at timestamptz;

-- After applying, reload PostgREST schema:
-- notify pgrst, 'reload schema';
