create table if not exists public.billing_events (
  id bigserial primary key,
  stripe_session_id text not null unique,
  user_id uuid not null,
  created_at timestamptz not null default now()
);
