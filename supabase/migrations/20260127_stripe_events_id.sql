create table if not exists public.stripe_events (
  id text primary key,
  created_at timestamptz not null default now()
);
