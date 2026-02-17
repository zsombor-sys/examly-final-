create table if not exists public.plan_current (
  user_id uuid primary key,
  plan_id uuid,
  updated_at timestamptz not null default now()
);

create index if not exists plan_current_plan_id_idx on public.plan_current(plan_id);
