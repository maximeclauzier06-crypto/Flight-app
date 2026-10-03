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

A different problem is **failed calls**: Travelpayouts sometimes doesn't
answer a request. The function now limits parallel calls, retries failures,
and remembers answers for 30 minutes (while the function stays warm). If
some calls still fail, the page says so ("the flight-data service didn't
answer N of M requests") instead of pretending there are no flights. Add
`&debug=1` to a request to see the full report (`debug.travelpayouts`,
`debug.stages`, raw example fares).

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

**Whenever `index.ts` changes, redeploy it the same way** (paste the new code
into the dashboard's editor). If the page shows "the deployed function is
running older code", that is what it means.

## Ideas for later

- Exact flight times and prices with a live flight-search API.
- Accounts, a shared live dashboard, price alerts (Phase 2).
