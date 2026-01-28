alter table public.profiles
  add column if not exists has_received_starter boolean not null default false;

create or replace function public.grant_starter_credits_on_verify()
returns trigger
language plpgsql
security definer
as $$
declare
  was_verified boolean;
  now_verified boolean;
begin
  was_verified := (old.email_confirmed_at is not null) or (old.confirmed_at is not null);
  now_verified := (new.email_confirmed_at is not null) or (new.confirmed_at is not null);

  if now_verified and not was_verified then
    insert into public.profiles (user_id, credits, has_received_starter)
    values (new.id, 5, true)
    on conflict (user_id) do nothing;

    update public.profiles
    set
      credits = case
        when has_received_starter then credits
        else coalesce(credits, 0) + 5
      end,
      has_received_starter = true
    where user_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists tr_grant_starter_on_verify on auth.users;
create trigger tr_grant_starter_on_verify
after update on auth.users
for each row
execute function public.grant_starter_credits_on_verify();
