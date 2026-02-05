create or replace function public.add_credits(p_user_id uuid, p_credits int)
returns void
language plpgsql
security definer
as $$
begin
  update public.profiles
  set credits = coalesce(credits, 0) + p_credits
  where id = p_user_id or user_id = p_user_id;
end;
$$;
