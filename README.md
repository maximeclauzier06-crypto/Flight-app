# Halfway Trips

Live at **https://halfwaytrips.com** (GitHub Pages; the old address
maximeclauzier06-crypto.github.io/Flight-app redirects there).

Add two or more departures (yours, a partner's, friends', family's — up to 8,
with how many people leave from each) and get a ranked list of places you could
all fly to **on the same dates**, cheapest first — with flight times for each
traveller and a light world map behind the page showing everyone's route to
the meeting point. On wide screens the map fills the window and stays put as
you scroll; you see and drag it in the open space right of the results (on
smaller screens it is a block under them). Every result is also a dot on the
map: hover it for the city and total price, click it to select that
destination. Zoom with + / −, a pinch, or Ctrl (⌘ on a Mac) + scroll;
"Recentre" brings back the view of every result.

Right above the results, **"Everyone lands within − 3 h +"** sets how far
apart everyone may land (and fly home). It appears with the first results.
A search that finds nothing within 3 h widens the limit by itself — 4 h,
5 h, 6 h, then any — so there is always something to show first ("widened
from 3 h · 4 trips found"); the − / + buttons then let you tighten or loosen
it (they never widen by themselves). The hint also offers a looser limit
when it would help ("Allow 4 h → +2 weekends, up to €23 less").

Already know where you're going? Pick it in **Going to** (left empty, it means
"Anywhere" — find the middle). The page then compares **dates** instead of
places: the coming weekends as a small price chart, and for the chosen
weekend the other ways to do it (Thu → Sun, Fri → Mon, ...) cheapest first,
each with how much it saves compared with the usual Fri → Sun.

The look is design 57, "Retro Travel Poster": a terracotta banner with sun rays, a cream page and map, and mustard on everything you click. All its colours are the variables at the top of `styles.css` (the map reads them too), so trying another palette is a single edit there.

## Running it

No installation needed. Open `index.html` in your browser (double-click it).
The page talks to the Supabase function below, so you need internet.

The live site is published by GitHub Pages from the `main` branch: every push
updates it within a few minutes. The `CNAME` file holds the domain
(`halfwaytrips.com`, bought separately); its DNS points to GitHub Pages.

## The files — and where to change things

| File | What it is | Easy things to change |
|---|---|---|
| `index.html` | The page structure, including the logo (the "meeting point": two dotted routes meeting in the middle) | Texts, headline, labels |
| `favicon.svg` | The browser-tab icon (the logo on cream, with thicker dots) | Its colours are written in the file itself |
| `CNAME` | The site's domain for GitHub Pages | Only if the domain changes |
| `styles.css` | How it looks | **The colours are the variables at the very top** (`--hero-bg`, `--action`, `--accent`...). Change them and the whole site follows. |
| `app.js` | The behaviour: autocomplete, the departures (add/remove, people counter), the "When" pop-up, the search, the "Everyone lands within" stepper, the table, the trip page after "Select" (with the "Book on Aviasales" buttons), the map | Settings are in section 1 at the top (map zoom limits, the stepper's steps `GAP_STEPS`); the trip page is section 7d |
| `supabase/calendar_cache.sql` | One-time SQL that creates the table where answers are remembered | Run once, then leave it |
| `geo.js` | The flat world map: real countries and borders (free Natural Earth data via the `world-atlas` package, drawn with the small `d3-geo` and `topojson-client` libraries loaded in `index.html` from a CDN) | Rarely needs changes. The map colours are `--map-sea`, `--map-land`, `--map-borders`, `--map-grid` in `styles.css` |
| `supabase/functions/search-flights/index.ts` | The server-side function that talks to Travelpayouts. Deployed on Supabase, not run from this folder. | `DEFAULT_MAX_GAP_HOURS`, `FIRST_PASS_CANDIDATES`, `FLEXIBLE_SEARCH_MONTHS` at the top; `TRIP_TYPES`, `TRIP_WEEKS`, `TRIP_VARIATIONS` for the one-destination search |

## How a search works

1. **Phase 1 (broad):** the function asks Travelpayouts for each departure's
   cheapest cached fare to every destination and keeps the destinations
   **everyone** can reach.
2. **Phase 2 (dates):** for the 15 cheapest of those, it looks day by day for
   a departure date **all** of you have a cached fare for ("Flexible" scans
   the next 4 months; "Specific dates" checks just your dates).
3. **The time rule:** among those days it keeps only the ones where everyone's
   **arrival times** at the destination, and everyone's **return-flight
   times**, are within **3 hours** of each other (latest minus earliest) — so nobody waits alone for a day.
   If nothing fits, the page itself asks again with 4h, 5h, 6h, then no limit
   (`widerGap` in `app.js`; the server remembers its answers, so this costs
   few or no extra flight-data calls). Change the limit with the − / + next to
   "Everyone lands within", above the results (1h to 6h, or any), or the default in
   `DEFAULT_MAX_GAP_HOURS` (server) / `maxGapHours` in the page's `state`
   (`app.js`).
4. **Widening (only if fewer than 6 matches):** it also tries a stay one night
   shorter/longer (the "±1 night" checkbox), then checks 25 more destinations.
   Rows show the real number of nights, so a "full week" search can return 6,
   7 or 8 nights.

### Searching towards one destination ("Going to")

With a destination, the function skips phase 1 and prices **dates**:

- **Which dates:** the next 10 weekends (Fri → Sun), long weekends
  (Fri → Mon) or weeks (Sat → Sat), following the chips above the results
  (or the "Trip length" in the When pop-up). With "Specific dates" it prices
  your dates instead.
- **Around each one** it also prices leaving a day earlier, coming back a day
  later, and the whole trip a day earlier or later (`TRIP_VARIATIONS`). Each
  weekend's options come back **cheapest first**; options whose arrival or
  return times break the time rule are shown greyed with the reason, and
  combinations without a cached fare say "No fare yet".
- **It's cheap on the data:** one calendar call per departure × month × stay
  length — about 12 calls for two people — so it's fast and rarely hits the
  rate limit. Results are still only as complete as the cached data.

### Searching from more than two places

Press **+ Add a departure** (the small box under the search bar, up to 8); use
the **− / +** next to the little avatars on a departure when several people
leave from the same place (prices are
multiplied by it). Every extra departure needs a cached fare on the *same
day*, so with the free data results get rare quickly beyond 3 departures
(the page says so when that happens). A live flight-search API would remove
that limit — this is the main reason to move to one later. The function also
checks fewer destinations when there are many departures, to stay within
Travelpayouts' rate limit.

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

6. **Booking links (how the site earns):** pressing **Select** on a result
   opens the trip page (everyone's flights, "where to stay", and room for
   more), where every traveller gets a **Book on Aviasales** button. When
   pressed, the function turns that
   Aviasales search into your Travelpayouts **partner link**, so a booking
   made after the click is credited to you (Travelpayouts requires this step;
   just adding your ID to an Aviasales address isn't enough). For that, add
   two more **Edge Function Secrets**, next to the token:
   - `TRAVELPAYOUTS_MARKER` — your Travelpayouts partner ID (a number, shown
     in your Travelpayouts account/profile).
   - `TRAVELPAYOUTS_TRS` — the ID of your Travelpayouts **project** (in the
     project list). That project must be connected to the **Aviasales**
     program.

   To check: press a Book button. The new tab should pass through a
   Travelpayouts address (e.g. `tp.media`) before landing on Aviasales. If it
   goes straight to `aviasales.com/search/...`, the booking would NOT be
   credited; open the browser console (F12) on the Halfway Trips page — it says
   why (missing secret, wrong token, project not connected to Aviasales...).
   Bookings show up in your Travelpayouts statistics with the sub ID
   `book-button`.

**Whenever `index.ts` changes, redeploy it the same way** (paste the new code
into the dashboard's editor). If the page shows "the deployed function is
running older code", that is what it means.

## Visitor statistics (Umami)

The live site counts its visitors with [Umami Cloud](https://cloud.umami.is)
(free plan: 100,000 events a month, 6 months of history). It uses no cookies
and nothing personal, so no cookie banner is needed. The script is in the
`<head>` of `index.html`; `data-domains` makes it count only the live site
(`halfwaytrips.com`, plus the old GitHub address), so testing on your
computer is never counted.

Besides visits (pages, countries, devices, where people came from), `app.js`
sends three events through its small `track()` helper:

| Event | When | Details sent |
|---|---|---|
| `search` | a search finishes | `source` (bar, gap, stay, currency, retry), `kind` (anywhere / destination), `from`, `to` (airport codes), `departures`, `travellers`, `when`, `gap` (the limit the results are for), `startGap` (the limit it started from, before widening), `found`, `outcome` (results / none / error) |
| `select` | "Select" opens a trip page | `kind`, `to`, `nights`, `travellers`, `total`, `currency` |
| `book-click` | a "Book on Aviasales" press | `from`, `to`, `seats`, `nights` |

Compare `book-click` with the clicks and sales in Travelpayouts. To keep your
own visits out, open the console (F12) on the live site once per browser and
run `localStorage.setItem('umami.disabled', 1)`.

## Ideas for later

- Exact flight times and prices with a live flight-search API.
- Accounts, a shared live dashboard, price alerts (Phase 2).
