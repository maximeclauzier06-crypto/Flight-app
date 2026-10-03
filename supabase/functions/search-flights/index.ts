// Flight Plan — search-flights Edge Function
//
// Why this exists: Travelpayouts' own rules say their API token can't be
// used from browser JavaScript (the request would expose the token to
// anyone who opens dev tools). This function runs on Supabase's servers
// instead, holds the token as a secret, and the browser talks to THIS
// function rather than to Travelpayouts directly.
//
// What it does, in two phases:
//   1. Asks Travelpayouts for each origin's cheapest cached fare to every
//      destination (no dates yet) and intersects the two lists to find
//      candidate shared destinations, then keeps the cheapest handful.
//   2. For each candidate, calls Travelpayouts' day-by-day calendar endpoint
//      for both origins with the requested stay length (or exact dates),
//      and looks for a departure day BOTH origins have a cached fare for —
//      AND where the two travelers' arrival times (and their return-flight
//      times) are no more than `maxGapHours` apart, so nobody waits alone
//      for a day. That time rule is the MAX_GAP_HOURS setting below.
//
// IMPORTANT about times: the free Travelpayouts price data only contains the
// DEPARTURE time of each flight — no arrival time and no duration. So
// arrival times here are ESTIMATES (distance-based flight time + time-zone
// conversion). Good enough for a "within 3 hours" rule, not for booking.
// A live flight-search API would give exact times (see README).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // fine while testing; can be narrowed to your real domain later
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// How many of the cheapest shared destinations get a deeper, date-aware
// look in phase 2. More = better odds of a match, but more API calls.
const MAX_CANDIDATES = 15;

// How many months ahead (including the current month) a "flexible dates"
// search scans.
const FLEXIBLE_SEARCH_MONTHS = 4;

// The rule you asked for: the two travelers' ARRIVAL times at the
// destination, and their RETURN-flight departure times, may differ by at
// most this many hours. The page can override it per search (`maxGapHours`
// query parameter); 0 (or negative) means "no limit".
const DEFAULT_MAX_GAP_HOURS = 3;

// Travelpayouts' docs say departure_at / return_at are UTC (the trailing
// "Z"). If real data turns out to be local clock time with a misleading "Z",
// flip this to false and the code will treat them as local time instead.
// (Add ?debug=1 to a request to see raw examples and check.)
const TIMES_ARE_UTC = true;

type Fare = { price: number; departureAt: string | null; returnAt: string | null; transfers: number };
type Place = { code: string; name: string; country: string; lat: number; lon: number; tz: string };

/* ---------------------------------------------------------------------------
   Reference data (names, coordinates, time zones) — free public files from
   Travelpayouts, downloaded once and cached while this function stays warm.
--------------------------------------------------------------------------- */

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
let citiesCache: Map<string, Place> | null = null;
let airportsCache: Map<string, Place> | null = null;

async function loadPlaces(kind: "cities" | "airports"): Promise<Map<string, Place>> {
  const response = await fetch(`https://api.travelpayouts.com/data/en/${kind}.json`);
  const list = (await response.json()) as Array<{
    code: string;
    name: string;
    country_code: string;
    time_zone: string;
    coordinates?: { lat: number; lon: number };
  }>;
  const map = new Map<string, Place>();
  for (const p of list) {
    if (!p.coordinates || !p.time_zone) continue;
    let country = p.country_code;
    try {
      country = regionNames.of(p.country_code) ?? p.country_code;
    } catch {
      // keep the raw country code
    }
    map.set(p.code, { code: p.code, name: p.name, country, lat: p.coordinates.lat, lon: p.coordinates.lon, tz: p.time_zone });
  }
  return map;
}

async function resolvePlaces(codes: string[]): Promise<Record<string, Place | null>> {
  citiesCache ??= await loadPlaces("cities");
  const found: Record<string, Place | null> = {};
  const missing: string[] = [];
  for (const code of codes) {
    const place = citiesCache.get(code);
    if (place) found[code] = place;
    else missing.push(code);
  }
  if (missing.length > 0) {
    airportsCache ??= await loadPlaces("airports");
    for (const code of missing) found[code] = airportsCache.get(code) ?? null;
  }
  return found;
}

/* ---------------------------------------------------------------------------
   Time helpers
--------------------------------------------------------------------------- */

// How many minutes `tz` is ahead of UTC at the given instant.
function offsetMinutes(tz: string, atMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(atMs))
      .map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - atMs) / 60000);
}

// "2026-10-22T21:30:00" read as a clock time in `tz`  ->  UTC milliseconds.
function localToUtcMs(isoLocal: string, tz: string): number {
  const guess = Date.parse(isoLocal.slice(0, 19) + "Z");
  let utc = guess - offsetMinutes(tz, guess) * 60000;
  utc = guess - offsetMinutes(tz, utc) * 60000; // second pass settles DST edges
  return utc;
}

// UTC milliseconds -> "2026-10-22T21:30" clock time in `tz`.
function utcToLocalIso(ms: number, tz: string): string {
  return new Date(ms + offsetMinutes(tz, ms) * 60000).toISOString().slice(0, 16);
}

// A fare timestamp from Travelpayouts -> UTC milliseconds.
function fareTimeToUtcMs(iso: string, clockTz: string): number {
  return TIMES_ARE_UTC ? Date.parse(iso) : localToUtcMs(iso, clockTz);
}

function haversineKm(a: Place, b: Place): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Rough gate-to-gate minutes: ~35 min of taxi/climb/descent plus cruising at
// ~780 km/h, plus about two hours and a 12% detour per connection.
function estimateMinutes(km: number, transfers: number): number {
  const direct = 35 + (km / 780) * 60;
  return Math.round(direct * (1 + 0.12 * transfers) + 110 * transfers);
}

/* ---------------------------------------------------------------------------
   Travelpayouts calls
--------------------------------------------------------------------------- */

// Travelpayouts sometimes returns { DEST: { price, ... } } and sometimes
// { DEST: { "0": { price, ... }, "1": { price, ... } } } for the same
// endpoint depending on the route. This picks the cheapest price either way.
function extractPrices(data: Record<string, unknown>): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const [destination, value] of Object.entries(data ?? {})) {
    if (!value || typeof value !== "object") continue;
    if ("price" in (value as Record<string, unknown>)) {
      prices[destination] = (value as { price: number }).price;
    } else {
      const variants = Object.values(value as Record<string, { price: number }>);
      if (variants.length > 0) {
        prices[destination] = variants.reduce((min, v) => (v.price < min.price ? v : min)).price;
      }
    }
  }
  return prices;
}

// Phase 1: cheapest cached fare from `origin` to every destination, no date
// filtering — used only to discover which destinations are worth a closer look.
async function fetchCheapestByDestination(origin: string, currency: string, token: string) {
  const params = new URLSearchParams({ origin, destination: "-", currency, token });
  const response = await fetch(`https://api.travelpayouts.com/v1/prices/cheap?${params}`);
  const json = await response.json();

  return {
    prices: extractPrices(json.data ?? {}),
    // If success is false, the token or request was rejected, and any "0
    // destinations found" result is actually THIS, not a lack of overlap.
    success: json.success !== false,
    rawError: json.error ?? null,
  };
}

// Phase 2: day-by-day cached fares for one origin/destination pair, all with
// the same fixed stay length. `departDateParam` is either an exact
// "YYYY-MM-DD" (specific-dates mode) or a "YYYY-MM" month (flexible mode).
async function fetchCalendarFares(
  origin: string,
  destination: string,
  currency: string,
  departDateParam: string,
  lengthOfStay: number,
  token: string
): Promise<Record<string, Fare>> {
  const params = new URLSearchParams({
    origin,
    destination,
    currency,
    depart_date: departDateParam,
    calendar_type: "departure_date",
    length: String(lengthOfStay),
    token,
  });

  try {
    const response = await fetch(`https://api.travelpayouts.com/v1/prices/calendar?${params}`);
    if (!response.ok) return {};
    const json = await response.json();
    if (json.success === false || !json.data) return {};

    const fares: Record<string, Fare> = {};
    for (const [date, entry] of Object.entries(json.data as Record<string, Record<string, unknown>>)) {
      if (!entry || typeof entry.price !== "number") continue;
      fares[date] = {
        price: entry.price,
        departureAt: typeof entry.departure_at === "string" ? entry.departure_at : null,
        returnAt: typeof entry.return_at === "string" ? entry.return_at : null,
        transfers: typeof entry.transfers === "number" ? entry.transfers : 0,
      };
    }
    return fares;
  } catch {
    // A single failed calendar call shouldn't take down the whole search.
    return {};
  }
}

/* ---------------------------------------------------------------------------
   Dates
--------------------------------------------------------------------------- */

function isFridayOrSaturday(dateStr: string): boolean {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// "YYYY-MM" for the current month and the next `count - 1` months.
function upcomingMonths(count: number): string[] {
  const now = new Date();
  const months: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

type SearchOptions =
  | { mode: "specific"; departDate: string; nights: number }
  | { mode: "flexible"; nights: number; weekendOnly: boolean };

// All cached departure-day fares for one origin/destination pair, given the
// search mode (narrowed to Fri/Sat departures for weekend trips).
async function faresForOriginDestination(
  origin: string,
  destination: string,
  currency: string,
  token: string,
  options: SearchOptions
): Promise<Record<string, Fare>> {
  if (options.mode === "specific") {
    return await fetchCalendarFares(origin, destination, currency, options.departDate, options.nights, token);
  }
  const perMonth = await Promise.all(
    upcomingMonths(FLEXIBLE_SEARCH_MONTHS).map((month) =>
      fetchCalendarFares(origin, destination, currency, month, options.nights, token)
    )
  );
  let fares: Record<string, Fare> = Object.assign({}, ...perMonth);
  if (options.weekendOnly) {
    fares = Object.fromEntries(Object.entries(fares).filter(([date]) => isFridayOrSaturday(date)));
  }
  return fares;
}

/* ---------------------------------------------------------------------------
   Matching two travelers
--------------------------------------------------------------------------- */

type Leg = {
  origin: string;
  price: number;
  transfers: number;
  timesKnown: boolean;
  outDepart: string | null; // local time at the origin
  outArrive: string | null; // local time at the destination (estimated)
  outMinutes: number;
  retDepart: string | null; // local time at the destination
  retArrive: string | null; // local time back home (estimated)
  retMinutes: number;
};

// Everything we can say about one traveler's trip on a given day.
function describeLeg(fare: Fare, origin: Place, dest: Place) {
  const minutes = estimateMinutes(haversineKm(origin, dest), fare.transfers);
  if (!fare.departureAt || !fare.returnAt) {
    return { timesKnown: false, minutes, outArriveMs: 0, retDepartMs: 0, leg: null as Partial<Leg> | null };
  }
  const outDepartMs = fareTimeToUtcMs(fare.departureAt, origin.tz);
  const outArriveMs = outDepartMs + minutes * 60000;
  const retDepartMs = fareTimeToUtcMs(fare.returnAt, dest.tz);
  const retArriveMs = retDepartMs + minutes * 60000;
  return {
    timesKnown: true,
    minutes,
    outArriveMs,
    retDepartMs,
    leg: {
      outDepart: utcToLocalIso(outDepartMs, origin.tz),
      outArrive: utcToLocalIso(outArriveMs, dest.tz),
      retDepart: utcToLocalIso(retDepartMs, dest.tz),
      retArrive: utcToLocalIso(retArriveMs, origin.tz),
    } as Partial<Leg>,
  };
}

// The cheapest departure day that BOTH origins have a cached fare for AND
// where the arrival / return times are close enough (maxGapHours).
function bestPairing(
  faresA: Record<string, Fare>,
  faresB: Record<string, Fare>,
  placeA: Place,
  placeB: Place,
  dest: Place,
  maxGapHours: number
) {
  const stats = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
  let best: null | {
    date: string;
    total: number;
    gapScore: number;
    a: ReturnType<typeof describeLeg>;
    b: ReturnType<typeof describeLeg>;
    fareA: Fare;
    fareB: Fare;
    arrivalGapH: number | null;
    returnGapH: number | null;
  } = null;

  for (const date in faresA) {
    if (!(date in faresB)) continue;
    stats.sameDayPairs++;
    const fareA = faresA[date];
    const fareB = faresB[date];
    const a = describeLeg(fareA, placeA, dest);
    const b = describeLeg(fareB, placeB, dest);

    let arrivalGapH: number | null = null;
    let returnGapH: number | null = null;
    if (a.timesKnown && b.timesKnown) {
      arrivalGapH = Math.abs(a.outArriveMs - b.outArriveMs) / 3_600_000;
      returnGapH = Math.abs(a.retDepartMs - b.retDepartMs) / 3_600_000;
      if (maxGapHours > 0 && (arrivalGapH > maxGapHours || returnGapH > maxGapHours)) {
        stats.rejectedByGap++;
        continue;
      }
    } else {
      stats.withoutTimes++; // can't check the rule, so it is allowed through
    }

    const total = fareA.price + fareB.price;
    const gapScore = (arrivalGapH ?? 0) + (returnGapH ?? 0);
    if (!best || total < best.total || (total === best.total && gapScore < best.gapScore)) {
      best = { date, total, gapScore, a, b, fareA, fareB, arrivalGapH, returnGapH };
    }
  }
  return { best, stats };
}

/* ---------------------------------------------------------------------------
   The request handler
--------------------------------------------------------------------------- */

Deno.serve(async (req) => {
  // Browsers send a preflight OPTIONS request before the real one — answer it.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const jsonHeaders = { ...CORS_HEADERS, "Content-Type": "application/json" };

  try {
    const url = new URL(req.url);
    const originA = url.searchParams.get("originA");
    const originB = url.searchParams.get("originB");
    const currency = url.searchParams.get("currency") ?? "usd";
    const mode = url.searchParams.get("mode") === "specific" ? "specific" : "flexible";
    const debugOn = url.searchParams.get("debug") === "1";
    const gapParam = url.searchParams.get("maxGapHours");
    const maxGapHours = gapParam === null ? DEFAULT_MAX_GAP_HOURS : Number(gapParam);

    if (!originA || !originB) {
      return new Response(JSON.stringify({ error: "originA and originB query parameters are required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }
    if (!Number.isFinite(maxGapHours)) {
      return new Response(JSON.stringify({ error: "maxGapHours must be a number (0 = no limit)" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const token = Deno.env.get("TRAVELPAYOUTS_TOKEN");
    if (!token) {
      return new Response(
        JSON.stringify({ error: "Server is missing TRAVELPAYOUTS_TOKEN — add it under Edge Function Secrets" }),
        { status: 500, headers: jsonHeaders }
      );
    }

    let searchOptions: SearchOptions;
    if (mode === "specific") {
      const departDate = url.searchParams.get("departDate");
      const returnDate = url.searchParams.get("returnDate");
      if (!departDate || !returnDate) {
        return new Response(JSON.stringify({ error: "departDate and returnDate are required when mode=specific" }), {
          status: 400,
          headers: jsonHeaders,
        });
      }
      const nights = Math.round((Date.parse(returnDate) - Date.parse(departDate)) / 86_400_000);
      if (!Number.isFinite(nights) || nights < 1) {
        return new Response(JSON.stringify({ error: "returnDate must be at least one day after departDate" }), {
          status: 400,
          headers: jsonHeaders,
        });
      }
      searchOptions = { mode: "specific", departDate, nights };
    } else {
      const nights = Number(url.searchParams.get("nights") ?? "7");
      if (!Number.isInteger(nights) || nights < 1 || nights > 30) {
        return new Response(JSON.stringify({ error: "nights must be a whole number between 1 and 30" }), {
          status: 400,
          headers: jsonHeaders,
        });
      }
      searchOptions = { mode: "flexible", nights, weekendOnly: url.searchParams.get("weekendOnly") === "true" };
    }

    // Phase 1: broad, dateless candidate discovery (cheap — 2 calls total).
    const [a, b] = await Promise.all([
      fetchCheapestByDestination(originA, currency, token),
      fetchCheapestByDestination(originB, currency, token),
    ]);

    const candidates = Object.keys(a.prices)
      .filter((destination) => destination in b.prices)
      .map((destination) => ({ destination, baseline: a.prices[destination] + b.prices[destination] }))
      .sort((x, y) => x.baseline - y.baseline)
      .slice(0, MAX_CANDIDATES);

    // Names / coordinates / time zones for both origins and every candidate.
    const places = await resolvePlaces([originA, originB, ...candidates.map((c) => c.destination)]);
    const placeA = places[originA];
    const placeB = places[originB];

    // Phase 2: date-aware lookup, only for the cheapest candidates.
    const totals = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
    let candidatesWithOriginAData = 0;
    let candidatesWithOriginBData = 0;
    const samples: unknown[] = [];

    const matched = await Promise.all(
      candidates.map(async ({ destination }) => {
        const dest = places[destination];
        const [faresA, faresB] = await Promise.all([
          faresForOriginDestination(originA, destination, currency, token, searchOptions),
          faresForOriginDestination(originB, destination, currency, token, searchOptions),
        ]);
        if (Object.keys(faresA).length > 0) candidatesWithOriginAData++;
        if (Object.keys(faresB).length > 0) candidatesWithOriginBData++;

        if (debugOn && samples.length < 8) {
          for (const [who, fares] of [["A", faresA], ["B", faresB]] as const) {
            const first = Object.entries(fares).slice(0, 2);
            for (const [date, f] of first) samples.push({ who, destination, date, ...f });
          }
        }

        // Without coordinates / time zones we can't estimate times; fall back
        // to the old behaviour (same day only, no time rule).
        if (!placeA || !placeB || !dest) {
          let cheapest: { date: string; total: number; priceA: number; priceB: number } | null = null;
          for (const date in faresA) {
            if (!(date in faresB)) continue;
            const total = faresA[date].price + faresB[date].price;
            if (!cheapest || total < cheapest.total) {
              cheapest = { date, total, priceA: faresA[date].price, priceB: faresB[date].price };
            }
          }
          if (!cheapest) return null;
          return {
            destination,
            destinationName: destination,
            country: "",
            lat: null,
            lon: null,
            priceA: cheapest.priceA,
            priceB: cheapest.priceB,
            total: cheapest.total,
            departDate: cheapest.date,
            returnDate: addDays(cheapest.date, searchOptions.nights),
            nights: searchOptions.nights,
            a: null,
            b: null,
            arrivalGapHours: null,
            returnGapHours: null,
          };
        }

        const { best, stats } = bestPairing(faresA, faresB, placeA, placeB, dest, maxGapHours);
        totals.sameDayPairs += stats.sameDayPairs;
        totals.rejectedByGap += stats.rejectedByGap;
        totals.withoutTimes += stats.withoutTimes;
        if (!best) return null;

        const leg = (origin: string, fare: Fare, d: ReturnType<typeof describeLeg>): Leg => ({
          origin,
          price: fare.price,
          transfers: fare.transfers,
          timesKnown: d.timesKnown,
          outDepart: d.leg?.outDepart ?? null,
          outArrive: d.leg?.outArrive ?? null,
          outMinutes: d.minutes,
          retDepart: d.leg?.retDepart ?? null,
          retArrive: d.leg?.retArrive ?? null,
          retMinutes: d.minutes,
        });

        return {
          destination,
          destinationName: dest.name,
          country: dest.country,
          lat: dest.lat,
          lon: dest.lon,
          priceA: best.fareA.price,
          priceB: best.fareB.price,
          total: best.total,
          departDate: best.date,
          returnDate: addDays(best.date, searchOptions.nights),
          nights: searchOptions.nights,
          a: leg(originA, best.fareA, best.a),
          b: leg(originB, best.fareB, best.b),
          arrivalGapHours: best.arrivalGapH,
          returnGapHours: best.returnGapH,
        };
      })
    );

    const results = matched
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .sort((x, y) => x.total - y.total);

    const placeOut = (p: Place | null | undefined) => (p ? { code: p.code, name: p.name, country: p.country, lat: p.lat, lon: p.lon } : null);

    return new Response(
      JSON.stringify({
        results,
        origins: { a: placeOut(placeA), b: placeOut(placeB) },
        debug: {
          originA,
          originAOk: a.success,
          originAError: a.rawError,
          originADestinationsFound: Object.keys(a.prices).length,
          originB,
          originBOk: b.success,
          originBError: b.rawError,
          originBDestinationsFound: Object.keys(b.prices).length,
          candidatesConsidered: candidates.length,
          candidatesWithDateMatch: results.length,
          candidatesWithOriginAData,
          candidatesWithOriginBData,
          maxGapHours,
          sameDayPairs: totals.sameDayPairs,
          rejectedByTimeGap: totals.rejectedByGap,
          pairsWithoutTimes: totals.withoutTimes,
          timesAreUtcAssumed: TIMES_ARE_UTC,
          ...(debugOn ? { samples } : {}),
        },
      }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
  }
});
