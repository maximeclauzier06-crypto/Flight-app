# Flight Plan (v1 — local prototype)

Type in two airports (yours and someone else's) and get a ranked list of
places you could both fly to **on the same dates**, cheapest first — with
flight times for each of you and a globe showing where you'd meet.

The look is the "Lilac Dusk" design.

## Running it

No installation needed. Open `index.html` in your browser (double-click it).
The page talks to the Supabase function below, so you need internet.

## The files — and where to change things

| File | What it is | Easy things to change |
|---|---|---|
| `index.html` | The page structure | Texts, headline, labels |
| `styles.css` | How it looks | **The colours are the variables at the very top** (`--hero-1`, `--accent`, `--peach`...). Change them and the whole site follows. |
| `app.js` | The behaviour: autocomplete, the "When" pop-up, the search, the table, the globe | Settings are in section 1 at the top |
| `supabase/calendar_cache.sql` | One-time SQL that creates the table where answers are remembered | Run once, then leave it |
| `geo.js` | Draws the dot-matrix globe (rough land outlines, no map library) | Rarely needs changes |
| `supabase/functions/search-flights/index.ts` | The server-side function that talks to Travelpayouts. Deployed on Supabase, not run from this folder. | `DEFAULT_MAX_GAP_HOURS`, `MAX_CANDIDATES`, `FLEXIBLE_SEARCH_MONTHS` at the top |

## How a search works

1. **Phase 1 (broad):** the function asks Travelpayouts for each person's
   cheapest cached fare to every destination and keeps the destinations
   you can both reach.
2. **Phase 2 (dates):** for the 15 cheapest of those, it looks day by day for
   a departure date **both** of you have a cached fare for ("Flexible" scans
   the next 4 months; "Specific dates" checks just your dates).
3. **The time rule:** among those days it keeps only the ones where your
   **arrival times** at the destination, and your **return-flight times**,
   are within **3 hours** of each other — so nobody waits alone for a day.
   Change the limit in the "When" pop-up (2h, 3h, 4h, 6h, or no limit), or
   the default in `DEFAULT_MAX_GAP_HOURS` (server) / the `selected` option
   of `#max-gap` (page).
4. **Widening (only if fewer than 6 matches):** it also tries a stay one night
   shorter/longer (the "±1 night" checkbox), then checks 25 more destinations.
   Rows show the real number of nights, so a "full week" search can return 6,
   7 or 8 nights.

### Why you can get few results (or none)

The free Travelpayouts data is a **cache of other people's past searches**.
For a given route, stay length and day, there is often simply no cached fare,
and you need one for *both* travelers on the *same* day. On top of that the
time rule removes more. With the rule off, a Stockholm–Brussels week search
typically has only a handful of usable days.

A different problem is **rate limiting**: Travelpayouts answers
`HTTP 429 – too many requests` when we ask for too much too fast (a wide
search can need hundreds of calls). The function protects itself:

- **It remembers every answer** — in memory, and permanently in a small
  database table (`supabase/calendar_cache.sql`) for 12 hours — so repeating
  or varying a search costs few or no new calls, and the memory fills up as
  more searches are made.
- **It caps one search at 260 new calls** and stops widening once it hits
  that, or runs out of time.
- **After a few 429s it stops immediately** and tells you ("the flight-data
  service is limiting our requests — wait about a minute"), instead of
  retrying for ages. If it is only partly blocked you get the options it
  found, plus a "Try again" notice.
- All lookups are made in **USD** and converted to your currency at the end
  (using the free open.er-api.com rates), so switching currency uses the
  same remembered answers and is quick.

Add `&debug=1` to a request to see the full report (`debug.travelpayouts`,
`debug.database`, `debug.stages`, raw example fares).

### Important: arrival times are estimates

The free price data only contains each flight's **departure** time (with its
UTC offset, e.g. `+02:00`) — no arrival time, no duration. So the function
**estimates** flight times from the distance between the airports (plus ~2h
per connection) and converts between time zones using Travelpayouts' free
airport list. It is accurate enough for a "within 3 hours" rule (checked:
Stockholm–Dubai ≈ 6h 40, Tokyo–Dubai ≈ 10h 45) but not exact, which is why
the page shows `≈` in front of arrival times and durations. A live
flight-search API would give exact times.

## Setting up the flight data

Travelpayouts doesn't allow calling their API directly from browser
JavaScript — the token would be exposed to anyone who opens dev tools.
So the real request happens on a small server we control instead:

1. Create a free Supabase project.
2. On the project's **Edge Function Secrets** page, add a secret named
   `TRAVELPAYOUTS_TOKEN` with your token as the value.
3. On the **Edge Functions** page, deploy a function named `search-flights`
   using the code in `supabase/functions/search-flights/index.ts` (paste it
   into the dashboard's editor).
4. Put the function URL (looks like
   `https://abcdefgh.supabase.co/functions/v1/search-flights`) into
   `SEARCH_FUNCTION_URL` at the top of `app.js`.
5. **Create the memory table (once):** in the Supabase dashboard open
   **SQL Editor → New query**, paste the contents of
   `supabase/calendar_cache.sql`, and press **Run**. Without it everything
   still works, but nothing is remembered between searches and you will hit
   Travelpayouts' rate limit much sooner. (The function reads the secret
   service key Supabase gives every Edge Function automatically — you don't
   add anything.)

**Whenever `index.ts` changes, redeploy it the same way** (paste the new code
into the dashboard's editor). If the page shows "the deployed function is
running older code", that is what it means.

## Ideas for later

- Exact flight times and prices with a live flight-search API.
- Accounts, a shared live dashboard, price alerts (Phase 2).
