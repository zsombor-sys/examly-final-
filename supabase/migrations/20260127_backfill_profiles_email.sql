-- Backfill missing profile emails from auth.users (safe)
update public.profiles p
set email = u.email
from auth.users u
where p.email is null and p.id = u.id and u.email is not null;
