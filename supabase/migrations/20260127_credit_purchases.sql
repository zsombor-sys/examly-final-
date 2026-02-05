create table if not exists public.credit_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_session_id text not null unique,
  credits int not null,
  amount_total int,
  currency text,
  created_at timestamptz not null default now()
);
