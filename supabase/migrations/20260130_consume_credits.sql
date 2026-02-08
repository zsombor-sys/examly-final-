create or replace function public.consume_credits(user_id uuid, cost int)
returns void
language plpgsql
security definer
as $$
begin
  if cost is null or cost <= 0 then
    return;
  end if;

  update public.profiles
  set credits = coalesce(credits, 0) - cost,
      updated_at = now()
  where id = user_id
    and coalesce(credits, 0) >= cost;

  if not found then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;
end;
$$;
