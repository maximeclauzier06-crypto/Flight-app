// Flight Plan — search-flights Edge Function
//
// Why this exists: Travelpayouts' own rules say their API token can't be
// used from browser JavaScript (the request would expose the token to
// anyone who opens dev tools). This function runs on Supabase's servers
// instead, holds the token as a secret, and the browser talks to THIS
// function rather than to Travelpayouts directly.
//
// What it does:
//   1. Asks Travelpayouts for each origin's cheapest cached fare to every
//      destination (no dates yet) and intersects the two lists to find
//      destinations you can both reach.
//   2. For the cheapest of those, calls Travelpayouts' day-by-day calendar
//      endpoint for both origins with the requested stay length, and looks
//      for a departure day BOTH origins have a cached fare for — AND where
//      the two travelers' arrival times (and their return-flight times) are
//      no more than `maxGapHours` apart, so nobody waits alone for a day.
//   3. If that finds only a few matches, it widens the search in stages
//      (stay length +/- 1 night, then more destinations) until it has enough
//      or runs out of time.
//
// IMPORTANT about times: the free Travelpayouts price data only contains the
// DEPARTURE time of each flight (with its real UTC offset, e.g. +02:00) —
// no arrival time and no duration. So arrival times here are ESTIMATES
// (distance-based flight time + time-zone conversion). Good enough for a
// "within 3 hours" rule, not for booking. A live flight-search API would
// give exact times (see README).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // fine while testing; can be narrowed to your real domain later
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Search size ------------------------------------------------------------

// Destinations checked in the first pass (the cheapest ones both can reach).
const FIRST_PASS_CANDIDATES = 15;

// If the first passes find fewer than MIN_RESULTS matches, this many MORE
// destinations are checked (only if there is still time left).
const EXTRA_CANDIDATES = 25;
const MIN_RESULTS = 6;

// How many months ahead (including the current month) a "flexible dates"
// search scans.
const FLEXIBLE_SEARCH_MONTHS = 4;

// Stop starting new search stages after this long (milliseconds).
const TIME_BUDGET_MS = 20_000;

// --- The time rule ------------------------------------------------------------

// The two travelers' ARRIVAL times at the destination, and their RETURN-flight
// departure times, may differ by at most this many hours. The page can
// override it per search (`maxGapHours` query parameter); 0 = no limit.
const DEFAULT_MAX_GAP_HOURS = 3;

// --- Being gentle with Travelpayouts -------------------------------------------

// Calendar calls running at the same time (a search can need hundreds).
const CALL_CONCURRENCY = 12;
// Failed calls (network error, 429, 5xx) are retried this many times.
const CALL_RETRIES = 2;
// Identical calendar lookups are remembered for this long while the function
// stays warm, so repeating a search is fast and doesn't use up API calls.
const CACHE_TTL_MS = 30 * 60_000;

type Fare = { price: number; departureAt: string | null; returnAt: string | null; transfers: number };
type Place = { code: string; name: string; country: string; lat: number; lon: number; tz: string };
type CallStats = { calls: number; cached: number; failed: number; retried: number; statuses: Record<string, number>; firstError: string | null };

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

// A fare timestamp from Travelpayouts -> UTC milliseconds. Real examples look
// like "2026-10-06T06:25:00+02:00" (local time + its UTC offset) or "...Z",
// which Date.parse understands. If a timestamp ever arrives with no offset at
// all, it is read as local time at `clockTz` instead.
function fareTimeToUtcMs(iso: string, clockTz: string): number {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? Date.parse(iso) : localToUtcMs(iso, clockTz);
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
   Travelpayouts calls — limited, retried, cached, and counted
--------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A tiny gate so only CALL_CONCURRENCY calls are in flight at once.
let inFlight = 0;
const waiting: Array<() => void> = [];
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= CALL_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await task();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

// GET a Travelpayouts URL as JSON. Retries network errors, 429 and 5xx. Returns
// null (and counts it in `stats`) if it still fails — so callers can tell
// "no data" apart from "the call failed".
async function getJson(url: string, stats: CallStats): Promise<Record<string, unknown> | null> {
  stats.calls++;
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    try {
      const response = await limited(() => fetch(url));
      if (response.ok) return (await response.json()) as Record<string, unknown>;
      const key = String(response.status);
      stats.statuses[key] = (stats.statuses[key] ?? 0) + 1;
      stats.firstError ??= `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break; // not worth retrying
    } catch (error) {
      stats.statuses.network = (stats.statuses.network ?? 0) + 1;
      stats.firstError ??= String(error).slice(0, 120);
    }
    if (attempt < CALL_RETRIES) {
      stats.retried++;
      await sleep(250 * (attempt + 1) + Math.random() * 200);
    }
  }
  stats.failed++;
  return null;
}

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
async function fetchCheapestByDestination(origin: string, currency: string, token: string, stats: CallStats) {
  const params = new URLSearchParams({ origin, destination: "-", currency, token });
  const json = await getJson(`https://api.travelpayouts.com/v1/prices/cheap?${params}`, stats);
  if (!json) return { prices: {} as Record<string, number>, success: false, rawError: stats.firstError ?? "request failed" };
  return {
    prices: extractPrices((json.data ?? {}) as Record<string, unknown>),
    // If success is false, the token or request was rejected, and any "0
    // destinations found" result is actually THIS, not a lack of overlap.
    success: json.success !== false,
    rawError: (json.error as string | undefined) ?? null,
  };
}

// Remembered calendar lookups (see CACHE_TTL_MS).
const calendarCache = new Map<string, { at: number; fares: Record<string, Fare> }>();

// Phase 2: day-by-day cached fares for one origin/destination pair, all with
// the same fixed stay length. `departDateParam` is either an exact
// "YYYY-MM-DD" (specific-dates mode) or a "YYYY-MM" month (flexible mode).
async function fetchCalendarFares(
  origin: string,
  destination: string,
  currency: string,
  departDateParam: string,
  lengthOfStay: number,
  token: string,
  stats: CallStats
): Promise<Record<string, Fare>> {
  const cacheKey = [origin, destination, currency, departDateParam, lengthOfStay].join("|");
  const hit = calendarCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    stats.cached++;
    return hit.fares;
  }

  const params = new URLSearchParams({
    origin,
    destination,
    currency,
    depart_date: departDateParam,
    calendar_type: "departure_date",
    length: String(lengthOfStay),
    token,
  });
  const json = await getJson(`https://api.travelpayouts.com/v1/prices/calendar?${params}`, stats);
  if (!json) return {}; // failed (already counted) — not cached, so a retry can succeed later

  const fares: Record<string, Fare> = {};
  if (json.success !== false && json.data) {
    for (const [date, entry] of Object.entries(json.data as Record<string, Record<string, unknown>>)) {
      if (!entry || typeof entry.price !== "number") continue;
      fares[date] = {
        price: entry.price,
        departureAt: typeof entry.departure_at === "string" ? entry.departure_at : null,
        returnAt: typeof entry.return_at === "string" ? entry.return_at : null,
        transfers: typeof entry.transfers === "number" ? entry.transfers : 0,
      };
    }
  }
  calendarCache.set(cacheKey, { at: Date.now(), fares });
  return fares;
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
  | { mode: "specific"; departDate: string }
  | { mode: "flexible"; weekendOnly: boolean };

// All cached departure-day fares for one origin/destination pair and stay
// length, given the search mode (narrowed to Fri/Sat departures for weekends).
async function faresForOriginDestination(
  origin: string,
  destination: string,
  currency: string,
  token: string,
  options: SearchOptions,
  length: number,
  stats: CallStats
): Promise<Record<string, Fare>> {
  if (options.mode === "specific") {
    return await fetchCalendarFares(origin, destination, currency, options.departDate, length, token, stats);
  }
  const perMonth = await Promise.all(
    upcomingMonths(FLEXIBLE_SEARCH_MONTHS).map((month) =>
      fetchCalendarFares(origin, destination, currency, month, length, token, stats)
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
  const fail = (message: string, status = 400) => new Response(JSON.stringify({ error: message }), { status, headers: jsonHeaders });
  const startedAt = Date.now();

  try {
    const url = new URL(req.url);
    const originA = url.searchParams.get("originA");
    const originB = url.searchParams.get("originB");
    const currency = url.searchParams.get("currency") ?? "usd";
    const mode = url.searchParams.get("mode") === "specific" ? "specific" : "flexible";
    const debugOn = url.searchParams.get("debug") === "1";
    const gapParam = url.searchParams.get("maxGapHours");
    const maxGapHours = gapParam === null ? DEFAULT_MAX_GAP_HOURS : Number(gapParam);
    const flexNights = Math.min(2, Math.max(0, Number(url.searchParams.get("flexNights") ?? "0") || 0));

    if (!originA || !originB) return fail("originA and originB query parameters are required");
    if (!Number.isFinite(maxGapHours)) return fail("maxGapHours must be a number (0 = no limit)");

    const token = Deno.env.get("TRAVELPAYOUTS_TOKEN");
    if (!token) return fail("Server is missing TRAVELPAYOUTS_TOKEN — add it under Edge Function Secrets", 500);

    let searchOptions: SearchOptions;
    let baseNights: number;
    if (mode === "specific") {
      const departDate = url.searchParams.get("departDate");
      const returnDate = url.searchParams.get("returnDate");
      if (!departDate || !returnDate) return fail("departDate and returnDate are required when mode=specific");
      baseNights = Math.round((Date.parse(returnDate) - Date.parse(departDate)) / 86_400_000);
      if (!Number.isFinite(baseNights) || baseNights < 1) return fail("returnDate must be at least one day after departDate");
      searchOptions = { mode: "specific", departDate };
    } else {
      baseNights = Number(url.searchParams.get("nights") ?? "7");
      if (!Number.isInteger(baseNights) || baseNights < 1 || baseNights > 30) return fail("nights must be a whole number between 1 and 30");
      searchOptions = { mode: "flexible", weekendOnly: url.searchParams.get("weekendOnly") === "true" };
    }

    const callStats: CallStats = { calls: 0, cached: 0, failed: 0, retried: 0, statuses: {}, firstError: null };

    // Phase 1: broad, dateless candidate discovery (2 calls).
    const [a, b] = await Promise.all([
      fetchCheapestByDestination(originA, currency, token, callStats),
      fetchCheapestByDestination(originB, currency, token, callStats),
    ]);

    const shared = Object.keys(a.prices)
      .filter((destination) => destination in b.prices)
      .map((destination) => ({ destination, baseline: a.prices[destination] + b.prices[destination] }))
      .sort((x, y) => x.baseline - y.baseline)
      .map((c) => c.destination);

    const firstPass = shared.slice(0, FIRST_PASS_CANDIDATES);
    const extraPass = shared.slice(FIRST_PASS_CANDIDATES, FIRST_PASS_CANDIDATES + EXTRA_CANDIDATES);

    // Names / coordinates / time zones for both origins and every destination we may check.
    const places = await resolvePlaces([originA, originB, ...firstPass, ...extraPass]);
    const placeA = places[originA];
    const placeB = places[originB];

    // Accumulators for the debug block.
    const totals = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
    const withDataA = new Set<string>();
    const withDataB = new Set<string>();
    const samples: unknown[] = [];
    const checked = new Set<string>();
    const best = new Map<string, NonNullable<Awaited<ReturnType<typeof evaluate>>>>();
    const stages: Array<{ stage: string; destinations: number; stayLengths: number[]; matchesAfter: number }> = [];

    // One destination, one stay length -> the best matching day (or null).
    async function evaluate(destination: string, length: number) {
      const dest = places[destination];
      const [faresA, faresB] = await Promise.all([
        faresForOriginDestination(originA!, destination, currency, token!, searchOptions, length, callStats),
        faresForOriginDestination(originB!, destination, currency, token!, searchOptions, length, callStats),
      ]);
      if (Object.keys(faresA).length > 0) withDataA.add(destination);
      if (Object.keys(faresB).length > 0) withDataB.add(destination);

      if (debugOn && samples.length < 8) {
        for (const [who, fares] of [["A", faresA], ["B", faresB]] as const) {
          for (const [date, f] of Object.entries(fares).slice(0, 2)) samples.push({ who, destination, date, length, ...f });
        }
      }

      // Without coordinates / time zones we can't estimate times; fall back to
      // "same day only", no time rule.
      if (!placeA || !placeB || !dest) {
        let cheapest: { date: string; total: number; priceA: number; priceB: number } | null = null;
        for (const date in faresA) {
          if (!(date in faresB)) continue;
          const total = faresA[date].price + faresB[date].price;
          if (!cheapest || total < cheapest.total) cheapest = { date, total, priceA: faresA[date].price, priceB: faresB[date].price };
        }
        if (!cheapest) return null;
        return {
          destination,
          destinationName: destination,
          country: "",
          lat: null as number | null,
          lon: null as number | null,
          priceA: cheapest.priceA,
          priceB: cheapest.priceB,
          total: cheapest.total,
          departDate: cheapest.date,
          returnDate: addDays(cheapest.date, length),
          nights: length,
          a: null as Leg | null,
          b: null as Leg | null,
          arrivalGapHours: null as number | null,
          returnGapHours: null as number | null,
        };
      }

      const { best: pick, stats } = bestPairing(faresA, faresB, placeA, placeB, dest, maxGapHours);
      totals.sameDayPairs += stats.sameDayPairs;
      totals.rejectedByGap += stats.rejectedByGap;
      totals.withoutTimes += stats.withoutTimes;
      if (!pick) return null;

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
        lat: dest.lat as number | null,
        lon: dest.lon as number | null,
        priceA: pick.fareA.price,
        priceB: pick.fareB.price,
        total: pick.total,
        departDate: pick.date,
        returnDate: addDays(pick.date, length),
        nights: length,
        a: leg(originA!, pick.fareA, pick.a) as Leg | null,
        b: leg(originB!, pick.fareB, pick.b) as Leg | null,
        arrivalGapHours: pick.arrivalGapH as number | null,
        returnGapHours: pick.returnGapH as number | null,
      };
    }

    // Runs one stage: every destination x every stay length, keeping the cheapest match per destination.
    async function runStage(stage: string, destinations: string[], lengths: number[]) {
      destinations.forEach((d) => checked.add(d));
      const jobs = destinations.flatMap((d) => lengths.map((length) => evaluate(d, length)));
      for (const result of await Promise.all(jobs)) {
        if (!result) continue;
        const current = best.get(result.destination);
        if (!current || result.total < current.total) best.set(result.destination, result);
      }
      stages.push({ stage, destinations: destinations.length, stayLengths: lengths, matchesAfter: best.size });
    }
    const timeLeft = () => Date.now() - startedAt < TIME_BUDGET_MS;

    // Stage 1: the cheapest destinations, the exact stay length asked for.
    await runStage("exact stay length", firstPass, [baseNights]);

    // Stage 2 (flexible mode only): few matches? also try one night shorter / longer.
    if (mode === "flexible" && flexNights > 0 && best.size < MIN_RESULTS && timeLeft()) {
      const lengths: number[] = [];
      for (let k = 1; k <= flexNights; k++) lengths.push(baseNights - k, baseNights + k);
      const wanted = lengths.filter((n) => n >= 1 && n <= 30);
      await runStage("stay length ± nights", firstPass.filter((d) => !best.has(d)), wanted);
    }

    // Stage 3: still few matches? look at more destinations (exact length only, to keep the number of calls down).
    if (best.size < MIN_RESULTS && extraPass.length > 0 && timeLeft()) {
      await runStage("more destinations", extraPass, [baseNights]);
    }

    const results = [...best.values()].sort((x, y) => x.total - y.total);
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
          sharedDestinations: shared.length,
          candidatesConsidered: checked.size,
          candidatesWithDateMatch: results.length,
          candidatesWithOriginAData: withDataA.size,
          candidatesWithOriginBData: withDataB.size,
          maxGapHours,
          sameDayPairs: totals.sameDayPairs,
          rejectedByTimeGap: totals.rejectedByGap,
          pairsWithoutTimes: totals.withoutTimes,
          stages,
          // How the calls to Travelpayouts went. `failed` > 0 means some data is
          // missing because Travelpayouts didn't answer, NOT because no fares exist.
          travelpayouts: callStats,
          elapsedMs: Date.now() - startedAt,
          ...(debugOn ? { samples } : {}),
        },
      }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
  }
});
