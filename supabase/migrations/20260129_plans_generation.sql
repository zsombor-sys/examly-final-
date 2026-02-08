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

alter table public.plans add column if not exists result jsonb;
alter table public.plans add column if not exists notes_json jsonb;
alter table public.plans add column if not exists daily_json jsonb;
alter table public.plans add column if not exists practice_json jsonb;
alter table public.plans add column if not exists generation_status text;
alter table public.plans add column if not exists error text;
alter table public.plans add column if not exists raw_notes_output text;
