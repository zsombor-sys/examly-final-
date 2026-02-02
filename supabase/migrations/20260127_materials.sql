-- Materials table for async processing
create table if not exists public.materials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  plan_id uuid,
  storage_path text not null,
  mime_type text,
  status text not null default 'uploaded',
  extracted_text text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Updated timestamp helper (safe if already exists)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tr_materials_touch on public.materials;
create trigger tr_materials_touch
before update on public.materials
for each row execute function public.touch_updated_at();

alter table public.materials enable row level security;

drop policy if exists "materials_select_own" on public.materials;
drop policy if exists "materials_insert_own" on public.materials;
drop policy if exists "materials_update_own" on public.materials;

create policy "materials_select_own"
on public.materials for select
using (auth.uid() = user_id);

create policy "materials_insert_own"
on public.materials for insert
with check (auth.uid() = user_id);

create policy "materials_update_own"
on public.materials for update
using (auth.uid() = user_id);
