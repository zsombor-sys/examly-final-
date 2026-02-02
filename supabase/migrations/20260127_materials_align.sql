-- Align materials schema with app usage
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  plan_id uuid,
  file_path text not null,
  mime_type text,
  original_name text,
  status text not null default 'uploaded',
  extracted_text text,
  error text,
  created_at timestamptz not null default now()
);

alter table public.materials
  add column if not exists user_id uuid,
  add column if not exists plan_id uuid,
  add column if not exists file_path text,
  add column if not exists mime_type text,
  add column if not exists original_name text,
  add column if not exists status text,
  add column if not exists extracted_text text,
  add column if not exists error text,
  add column if not exists created_at timestamptz;

-- Ensure defaults
alter table public.materials
  alter column status set default 'uploaded';

