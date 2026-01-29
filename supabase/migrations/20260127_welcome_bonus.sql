alter table public.profiles
  add column if not exists welcome_bonus_claimed boolean not null default false;

drop trigger if exists tr_grant_starter_on_verify on auth.users;
drop function if exists public.grant_starter_credits_on_verify();

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_auth_user_created();
