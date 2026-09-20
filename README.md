# Flight Plan (v1 — local prototype)

This is the very first working piece of the project: a page where you type in
two airports and get back a ranked list of destinations you could both fly
to, cheapest first.

## Running it

No installation needed yet. Just open `index.html` in your browser
(double-click the file, or right-click → Open With → your browser).

Try typing **Stockholm** and **Berlin** as the two airports — those are the
only two the example data currently knows about.

## What's real and what's a placeholder right now

- The search form, the ranking logic, and the results display are real —
  this is the actual code the finished app will use.
- The flight prices are **example data** hardcoded in `app.js`
  (`exampleFlightData`), not real fares. Swapping in a real flight API
  (Travelpayouts or Duffel, per the Flight Plan roadmap) only means
  rewriting the `searchFlights` function — everything else stays the same.

## Files

- `index.html` — the page structure and the search form
- `styles.css` — how it looks
- `app.js` — the search logic and what happens when you hit "Find destinations"

## Next steps (matches Phase 1 of the roadmap)

1. Sign up for a flight data source (Travelpayouts is the easiest free
   starting point) and get an API key.
2. Replace the example data in `searchFlights` with a real network request.
3. Push this repo to GitHub.

Everything past this (accounts, the real-time shared dashboard, alerts) is
Phase 2 onward — deliberately not part of this first piece.
