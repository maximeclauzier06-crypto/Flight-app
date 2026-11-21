-- ---------------------------------------------------------------------------
-- Halfway Trips — the accounts' two small tables
--
-- Run this ONCE in Supabase: Dashboard → SQL Editor → New query → paste all of
-- this → Run. (Running it again is harmless.)
--
--   saved_trips  the trips and good places someone saved with ♡
--   profiles     their 5 latest searches (the Account page) and the airports of
--                the newest one, to fill in the search bar
--
-- The rules ("row level security") let each signed-in person read, add and
-- remove only their OWN rows: the page sends their sign-in token, and the
-- database checks it. With only the public anon key, nobody can read anything.
-- delete_my_account() lets someone delete their account themselves (the
-- "Delete my account" button); their rows go with it.
-- ---------------------------------------------------------------------------

create table if not exists public.saved_trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('trip', 'place')),     -- an exact match, or a good place
  destination text not null check (char_length(destination) between 2 and 8), -- city code, e.g. LIS
  destination_name text not null check (char_length(destination_name) <= 80),
  country text check (char_length(country) <= 80),
  origins jsonb not null check (jsonb_typeof(origins) = 'array' and pg_column_size(origins) < 4000), -- [{ code, label, count }]
  depart_date date,                                          -- (a good place has no dates)
  return_date date,
  nights int check (nights between 1 and 60),
  total numeric check (total >= 0),                          -- the price when it was saved
  currency text check (char_length(currency) <= 3)
);
create index if not exists saved_trips_user on public.saved_trips (user_id, created_at desc);

create table if not exists public.profiles (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  airports jsonb not null default '[]' check (jsonb_typeof(airports) = 'array' and pg_column_size(airports) < 4000), -- [{ code, label, count }]
  updated_at timestamptz not null default now()
);
-- Added 2026-11-21: the 5 latest searches, for the Account page, newest first:
-- [{ origins: [{ code, label, count }], to, toName, stay, nights, depart, return, at }]
-- (Already set up before? Running just this line adds it.)
alter table public.profiles add column if not exists searches jsonb not null default '[]'
  check (jsonb_typeof(searches) = 'array' and pg_column_size(searches) < 16000);

alter table public.saved_trips enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "Own saved trips" on public.saved_trips;
create policy "Own saved trips" on public.saved_trips
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Own profile" on public.profiles;
create policy "Own profile" on public.profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Only signed-in people can touch the tables at all (the rules above then
-- narrow it to their own rows).
revoke all on public.saved_trips, public.profiles from anon;
grant select, insert, update, delete on public.saved_trips, public.profiles to authenticated;

-- "Delete my account": removes the signed-in person from Supabase Auth; their
-- saved trips and profile are deleted with them (on delete cascade).
create or replace function public.delete_my_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = (select auth.uid());
$$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
