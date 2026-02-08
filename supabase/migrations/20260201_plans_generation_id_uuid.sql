create extension if not exists pgcrypto;

alter table public.plans
  add column if not exists generation_id uuid;

alter table public.plans
  alter column generation_id type uuid using generation_id::uuid;

update public.plans
set generation_id = id
where generation_id is null;

alter table public.plans
  alter column generation_id set default gen_random_uuid();

create index if not exists plans_generation_id_idx on public.plans (generation_id);

notify pgrst, 'reload schema';
