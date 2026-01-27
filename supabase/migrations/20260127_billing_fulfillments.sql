create table if not exists public.billing_fulfillments (
  id bigserial primary key,
  user_id uuid not null,
  stripe_session_id text not null unique,
  credits_added integer not null,
  created_at timestamptz not null default now()
);
