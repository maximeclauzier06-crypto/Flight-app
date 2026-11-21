-- ---------------------------------------------------------------------------
-- Halfway Trips — price alerts (the Account page's "New price alert")
--
-- Run this ONCE in Supabase: Dashboard → SQL Editor → New query → paste all of
-- this → Run. (Running it again is harmless.) Needs supabase/accounts.sql first.
--
--   price_alerts  what someone wants to hear about: everyone's airports, where
--                 (or anywhere), the kind of trip, the months, the highest
--                 total price... plus what the daily check found last time.
--
-- Every morning the price-alerts function (supabase/functions/price-alerts)
-- checks each alert with the same search as the site, and emails the person
-- when a trip is under their price. The rules below let each signed-in person
-- see, add, change and remove only their OWN alerts (at most 5).
-- ---------------------------------------------------------------------------

create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- What to look for
  origins jsonb not null check (jsonb_typeof(origins) = 'array' and jsonb_array_length(origins) between 2 and 8 and pg_column_size(origins) < 4000), -- [{ code, label, count }]
  destination text check (destination ~ '^[A-Z]{3}$'),       -- null = Anywhere
  destination_name text check (char_length(destination_name) <= 80),
  stay text not null check (stay in ('weekend', 'long', 'week', 'nights')),
  nights int not null check (nights between 1 and 30),
  month_from date not null,                                   -- the first day of the first month you'd leave in
  month_to date not null check (month_to >= month_from),      -- the first day of the last one
  max_total numeric not null check (max_total > 0),           -- in total, for everyone
  currency text not null check (currency ~ '^[a-z]{3}$'),
  max_gap_hours int not null default 3 check (max_gap_hours between 0 and 12), -- 0 = no limit
  direct_only boolean not null default false,
  frequency text not null default 'daily' check (frequency in ('daily', 'weekly')),
  active boolean not null default true,                       -- false = paused
  token uuid not null default gen_random_uuid(),              -- for the email's "Pause it" / "Stop this alert" links

  -- What the last check found (written by the price-alerts function)
  checked_at timestamptz,
  cheapest_total numeric,          -- the cheapest trip for these settings, even above your price
  matches jsonb,                   -- up to 3 trips under your price, cheapest first
  match_count int,
  emailed_at timestamptz,
  emailed_sig text,                -- which trip the last email was about (place + dates)
  emailed_total numeric,
  last_error text
);
create index if not exists price_alerts_user on public.price_alerts (user_id, created_at);
create index if not exists price_alerts_due on public.price_alerts (active, checked_at);

alter table public.price_alerts enable row level security;

drop policy if exists "Own price alerts" on public.price_alerts;
create policy "Own price alerts" on public.price_alerts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.price_alerts from anon;
grant select, insert, update, delete on public.price_alerts to authenticated;

-- At most 5 alerts each (keeps the daily check small).
create or replace function public.price_alerts_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.price_alerts where user_id = new.user_id) >= 5 then
    raise exception 'You can have up to 5 price alerts. Delete one to make a new one.';
  end if;
  return new;
end;
$$;
drop trigger if exists price_alerts_limit on public.price_alerts;
create trigger price_alerts_limit before insert on public.price_alerts
  for each row execute function public.price_alerts_limit();
