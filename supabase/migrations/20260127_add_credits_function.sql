create or replace function add_credits(p_user_id uuid, p_amount integer)
returns void
language plpgsql
security definer
as $$
begin
  update profiles
  set credits = coalesce(credits, 0) + p_amount
  where user_id = p_user_id;
end;
$$;
