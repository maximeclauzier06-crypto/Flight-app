# Flight Plan (v1 — local prototype)

This is the very first working piece of the project: a page where you type in
two airports and get back a ranked list of destinations you could both fly
to, cheapest first.

## Running it

No installation needed yet. Just open `index.html` in your browser
(double-click the file, or right-click → Open With → your browser).

Try typing **Stockholm** and **Berlin** as the two airports — those are the
only two the example data currently knows about.

## What's real now

- The search form, the ranking logic, and the results display are real —
  this is the actual code the finished app will use.
- Flight prices come from Travelpayouts' real data, via a small Supabase
  Edge Function (`supabase/functions/search-flights`) that holds the API
  token safely and calls Travelpayouts on the browser's behalf — see
  "Setting up the flight data" below for why that extra piece exists.
- Airport/city search is real, live autocomplete (Travelpayouts' public
  places lookup — no token needed for this part).
- Dates are real: pick specific depart/return dates, or "flexible — lowest
  price" with a trip length (a weekend, a full week, or a custom number of
  nights). Either way, results show the actual matching dates and night
  count, not just a price — see "How date search works" below.

## How date search works

The Edge Function first asks Travelpayouts for each traveler's cheapest
cached fare to every destination (no dates yet) to find the destinations
you can both reach, then takes the cheapest handful of those and looks,
day by day, for a departure date **both** travelers have a cached fare
for — so the two of you are actually there together, not just each
independently cheap. "Flexible" scans the next two months for the best
matching day; "specific dates" checks only the exact dates you picked.

Because this runs on Travelpayouts' *cached* fare data (not a live
search), a very specific date or an unusual route can come back empty even
when the flights themselves exist — the app explains this in the results
rather than just saying "nothing found."

## Files

- `index.html` — the page structure and the search form
- `styles.css` — how it looks
- `app.js` — the search logic and what happens when you hit "Find destinations"
- `supabase/functions/search-flights/index.ts` — the server-side function
  that talks to Travelpayouts (deployed via the Supabase dashboard, not
  run from this folder directly)

## Setting up the flight data

Travelpayouts doesn't allow calling their API directly from browser
JavaScript — the token would be exposed to anyone who opens dev tools.
So the real request happens on a small server we control instead:

1. Create a free Supabase project.
2. On the project's **Edge Function Secrets** page, add a secret named
   `TRAVELPAYOUTS_TOKEN` with your token as the value.
3. On the **Edge Functions** page, deploy a new function named
   `search-flights` using the code in
   `supabase/functions/search-flights/index.ts` (paste it into the
   dashboard's editor).
4. Copy your project's function URL (shown on that page, looks like
   `https://abcdefgh.supabase.co/functions/v1/search-flights`) into
   `SEARCH_FUNCTION_URL` at the top of `app.js`.

Whenever `supabase/functions/search-flights/index.ts` changes, redeploy it
the same way — paste the updated code into the dashboard's editor for the
`search-flights` function.

## Next steps (Phase 1, continued)

Phase 1's original list is done. Everything past this (accounts, the
real-time shared dashboard, alerts) is Phase 2 onward — deliberately not
part of this first piece.
