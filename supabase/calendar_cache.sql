-- Flight Plan — permanent memory for Travelpayouts answers.
--
-- Run this ONCE in your Supabase dashboard: SQL Editor -> New query -> paste
-- -> Run. The search-flights Edge Function then stores every calendar answer
-- it gets from Travelpayouts here and reuses it for 12 hours, so repeated and
-- similar searches cost no API calls (Travelpayouts rate-limits us otherwise).
--
-- Safe to run twice. If you skip it, everything still works — searches just
-- aren't remembered between runs.

create table if not exists public.calendar_cache (
  key        text primary key,            -- e.g. STO_LIS_usd_2026-10_7
  fares      jsonb not null,              -- the day-by-day fares we got back
  fetched_at timestamptz not null default now()
);

-- Lock it down: row level security ON with no policies means the public
-- (anon) key cannot read or write it. Only the Edge Function can, using the
-- server-side service key Supabase gives every Edge Function automatically.
alter table public.calendar_cache enable row level security;

create index if not exists calendar_cache_fetched_at_idx on public.calendar_cache (fetched_at);
