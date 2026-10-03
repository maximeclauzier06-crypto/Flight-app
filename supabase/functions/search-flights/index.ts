// Flight Plan — search-flights Edge Function
//
// Why this exists: Travelpayouts' own rules say their API token can't be
// used from browser JavaScript (the request would expose the token to
// anyone who opens dev tools). This function runs on Supabase's servers
// instead, holds the token as a secret, and the browser talks to THIS
// function rather than to Travelpayouts directly.
//
// What it does:
//   1. Takes 2 to 8 departures (`origins=STO,BRU,LON`, optionally with how
//      many people leave from each: `counts=2,1,1`), asks Travelpayouts for
//      each one's cheapest cached fare to every destination (no dates yet)
//      and intersects the lists: destinations EVERYONE can reach.
//   2. For the cheapest of those, calls Travelpayouts' day-by-day calendar
//      endpoint for every departure with the requested stay length, and looks
//      for a departure day ALL of them have a cached fare for — AND where
//      everyone's arrival times (and everyone's return-flight times) are
//      within `maxGapHours` of each other, so nobody waits alone for a day.
//   3. If that finds only a few matches, it widens the search in stages
//      (stay length +/- 1 night, then more destinations).
//
// Three things keep us inside Travelpayouts' rate limit (it answers HTTP 429
// "too many requests" when we ask for too much):
//   * every answer is remembered — in memory, and permanently in a small
//     Supabase table (see supabase/calendar_cache.sql) for CACHE_TTL_MS;
//   * a search may make at most MAX_CALLS_PER_SEARCH new calls;
//   * after a few 429s the search stops immediately and says so, instead of
//     hammering on (which only makes the limit last longer).
//
// All lookups are done in USD and converted to the requested currency at the
// end, so one cached answer serves every currency.
//
// IMPORTANT about times: the free Travelpayouts price data only contains the
// DEPARTURE time of each flight (with its real UTC offset, e.g. +02:00) —
// no arrival time and no duration. So arrival times here are ESTIMATES
// (distance-based flight time + time-zone conversion). Good enough for a
// "within 3 hours" rule, not for booking.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // fine while testing; can be narrowed to your real domain later
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// --- Search size ------------------------------------------------------------

const FIRST_PASS_CANDIDATES = 15; // cheapest shared destinations checked first
const EXTRA_CANDIDATES = 25;      // checked too, only if there are fewer than MIN_RESULTS matches
const MIN_RESULTS = 6;
const FLEXIBLE_SEARCH_MONTHS = 4; // months ahead a "flexible dates" search scans
const TIME_BUDGET_MS = 20_000;    // don't START new search stages after this long

// --- The time rule ------------------------------------------------------------

// The two travelers' ARRIVAL times at the destination, and their RETURN-flight
// departure times, may differ by at most this many hours. The page can
// override it per search (`maxGapHours` query parameter); 0 = no limit.
const DEFAULT_MAX_GAP_HOURS = 3;

// --- Being gentle with Travelpayouts -------------------------------------------

const CALL_CONCURRENCY = 8;        // calendar calls running at the same time
const MAX_CALLS_PER_SEARCH = 260;  // new (uncached) calls one search may make
const BREAKER_429_COUNT = 10;      // this many 429s -> stop calling Travelpayouts for this search
const CALL_RETRIES = 2;            // retries for network errors / 5xx (a 429 gets one slow retry)
const CACHE_TTL_MS = 12 * 3_600_000; // how long a remembered answer stays valid

const BASE_CURRENCY = "usd"; // everything is fetched in this, then converted

// --- Group size ---------------------------------------------------------------

// How many different departure airports/cities one search may have. With the
// free cached data, the more departures there are, the less likely it is that
// EVERYONE has a cached fare on the same day — a live flight API fixes that.
const MAX_ORIGINS = 8;

type Fare = { price: number; departureAt: string | null; returnAt: string | null; transfers: number };
type Traveler = { origin: string; count: number };
type Place = { code: string; name: string; country: string; lat: number; lon: number; tz: string };
type CallStats = {
  calls: number;      // new calls attempted
  cached: number;     // answers served from memory or the database
  failed: number;     // calls that never got an answer
  retried: number;
  skipped: number;    // calls not made (budget used up, or rate-limited)
  statuses: Record<string, number>;
  firstError: string | null;
  rateLimited: boolean;
  budgetExhausted: boolean;
};

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
   Currency conversion (everything is fetched in USD)
--------------------------------------------------------------------------- */

let ratesCache: { at: number; rates: Record<string, number> } | null = null;

// How many units of `currency` one US dollar buys, or null if unknown.
async function usdRate(currency: string): Promise<number | null> {
  if (currency === BASE_CURRENCY) return 1;
  try {
    if (!ratesCache || Date.now() - ratesCache.at > CACHE_TTL_MS) {
      const response = await fetch("https://open.er-api.com/v6/latest/USD");
      const json = await response.json();
      if (json?.result !== "success" || !json.rates) return null;
      ratesCache = { at: Date.now(), rates: json.rates as Record<string, number> };
    }
    return ratesCache.rates[currency.toUpperCase()] ?? null;
  } catch {
    return null;
  }
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
   Travelpayouts calls — limited, budgeted, retried gently, counted
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

// GET a Travelpayouts URL as JSON. Returns null (and counts why in `stats`) if
// no answer was obtained — so callers can tell "no data" from "call failed".
async function getJson(url: string, stats: CallStats): Promise<Record<string, unknown> | null> {
  if (stats.rateLimited) { stats.skipped++; return null; }
  if (stats.calls >= MAX_CALLS_PER_SEARCH) { stats.budgetExhausted = true; stats.skipped++; return null; }
  stats.calls++;

  let tried429 = false;
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    if (stats.rateLimited) break; // another call just tripped the breaker
    try {
      const response = await limited(() => fetch(url));
      if (response.ok) return (await response.json()) as Record<string, unknown>;

      const key = String(response.status);
      stats.statuses[key] = (stats.statuses[key] ?? 0) + 1;
      stats.firstError ??= `HTTP ${response.status}`;

      if (response.status === 429) {
        if ((stats.statuses["429"] ?? 0) >= BREAKER_429_COUNT) { stats.rateLimited = true; break; }
        if (tried429) break; // one slow retry only
        tried429 = true;
        stats.retried++;
        const wait = Number(response.headers.get("retry-after")) * 1000 || 1200;
        await sleep(Math.min(wait, 3000));
        continue;
      }
      if (response.status < 500) break; // other client errors won't fix themselves
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
async function fetchCheapestByDestination(origin: string, token: string, stats: CallStats) {
  const params = new URLSearchParams({ origin, destination: "-", currency: BASE_CURRENCY, token });
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

/* ---------------------------------------------------------------------------
   Remembering answers: in memory (fast) and in a Supabase table (permanent)
--------------------------------------------------------------------------- */

const memoryCache = new Map<string, { at: number; fares: Record<string, Fare> }>();
const pendingWrites: Array<{ key: string; fares: Record<string, Fare>; fetched_at: string }> = [];
const dbInfo = { status: "not used yet" as string, loaded: 0, saved: 0 };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const dbHeaders = () => ({ apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
let dbDisabled = !SUPABASE_URL || !SERVICE_KEY;

// Pull any remembered answers for these keys into memory (one request per 40 keys).
async function loadFromDatabase(keys: string[]): Promise<void> {
  if (dbDisabled) { dbInfo.status = SUPABASE_URL && SERVICE_KEY ? dbInfo.status : "off (no service key)"; return; }
  const missing = keys.filter((k) => !memoryCache.has(k) || Date.now() - memoryCache.get(k)!.at >= CACHE_TTL_MS);
  for (let i = 0; i < missing.length; i += 40) {
    const chunk = missing.slice(i, i + 40);
    try {
      const filter = `in.(${chunk.map((k) => `"${k}"`).join(",")})`;
      const response = await fetch(`${SUPABASE_URL}/rest/v1/calendar_cache?select=key,fares,fetched_at&key=${encodeURIComponent(filter)}`, { headers: dbHeaders() });
      if (!response.ok) {
        dbDisabled = true; // most likely the table hasn't been created yet
        dbInfo.status = `unavailable (HTTP ${response.status}) — run supabase/calendar_cache.sql`;
        return;
      }
      for (const row of (await response.json()) as Array<{ key: string; fares: Record<string, Fare>; fetched_at: string }>) {
        const at = Date.parse(row.fetched_at);
        if (Date.now() - at < CACHE_TTL_MS) {
          memoryCache.set(row.key, { at, fares: row.fares });
          dbInfo.loaded++;
        }
      }
      dbInfo.status = "ok";
    } catch (error) {
      dbDisabled = true;
      dbInfo.status = `unavailable (${String(error).slice(0, 80)})`;
      return;
    }
  }
}

// Save the answers we just fetched (called once, at the end of a search).
async function flushToDatabase(): Promise<void> {
  if (dbDisabled || pendingWrites.length === 0) return;
  const rows = pendingWrites.splice(0, pendingWrites.length);
  for (let i = 0; i < rows.length; i += 100) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/calendar_cache`, {
        method: "POST",
        headers: { ...dbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(i, i + 100)),
      });
      if (response.ok) dbInfo.saved += Math.min(100, rows.length - i);
      else { dbInfo.status = `save failed (HTTP ${response.status})`; return; }
    } catch (error) {
      dbInfo.status = `save failed (${String(error).slice(0, 80)})`;
      return;
    }
  }
}

const cacheKey = (origin: string, destination: string, departDateParam: string, length: number) =>
  [origin, destination, BASE_CURRENCY, departDateParam, length].join("_");

// Phase 2: day-by-day cached fares for one origin/destination pair, all with
// the same fixed stay length. `departDateParam` is either an exact
// "YYYY-MM-DD" (specific-dates mode) or a "YYYY-MM" month (flexible mode).
async function fetchCalendarFares(
  origin: string,
  destination: string,
  departDateParam: string,
  lengthOfStay: number,
  token: string,
  stats: CallStats
): Promise<Record<string, Fare>> {
  const key = cacheKey(origin, destination, departDateParam, lengthOfStay);
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    stats.cached++;
    return hit.fares;
  }

  const params = new URLSearchParams({
    origin,
    destination,
    currency: BASE_CURRENCY,
    depart_date: departDateParam,
    calendar_type: "departure_date",
    length: String(lengthOfStay),
    token,
  });
  const json = await getJson(`https://api.travelpayouts.com/v1/prices/calendar?${params}`, stats);
  if (!json) return {}; // no answer (already counted) — NOT remembered, so a retry can succeed later

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
  const at = Date.now();
  memoryCache.set(key, { at, fares });
  pendingWrites.push({ key, fares, fetched_at: new Date(at).toISOString() });
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

// The calendar lookups one origin/destination/length needs (one per month, or one exact date).
const lookupsFor = (options: SearchOptions) => (options.mode === "specific" ? [options.departDate] : upcomingMonths(FLEXIBLE_SEARCH_MONTHS));

// All cached departure-day fares for one origin/destination pair and stay
// length, given the search mode (narrowed to Fri/Sat departures for weekends).
async function faresForOriginDestination(
  origin: string,
  destination: string,
  token: string,
  options: SearchOptions,
  length: number,
  stats: CallStats
): Promise<Record<string, Fare>> {
  const perLookup = await Promise.all(lookupsFor(options).map((p) => fetchCalendarFares(origin, destination, p, length, token, stats)));
  let fares: Record<string, Fare> = Object.assign({}, ...perLookup);
  if (options.mode === "flexible" && options.weekendOnly) {
    fares = Object.fromEntries(Object.entries(fares).filter(([date]) => isFridayOrSaturday(date)));
  }
  return fares;
}

/* ---------------------------------------------------------------------------
   Matching a group of travelers (2 to MAX_ORIGINS departures)
--------------------------------------------------------------------------- */

type Leg = {
  origin: string;
  count: number;            // how many people travel from this departure
  price: number;            // price per person
  subtotal: number;         // price x count
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

// The cheapest departure day that EVERY origin has a cached fare for AND where
// everyone's arrival times (and everyone's return-flight times) fall within
// maxGapHours of each other. Prices are weighted by how many people travel
// from each departure.
function bestGroupPairing(
  faresList: Array<Record<string, Fare>>,
  originPlaces: Place[],
  dest: Place,
  counts: number[],
  maxGapHours: number
) {
  const stats = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
  let best: null | {
    date: string;
    total: number;
    gapScore: number;
    fares: Fare[];
    described: Array<ReturnType<typeof describeLeg>>;
    arrivalGapH: number | null;
    returnGapH: number | null;
  } = null;

  for (const date in faresList[0]) {
    if (!faresList.every((fares) => date in fares)) continue;
    stats.sameDayPairs++;
    const fares = faresList.map((f) => f[date]);
    const described = fares.map((fare, i) => describeLeg(fare, originPlaces[i], dest));

    let arrivalGapH: number | null = null;
    let returnGapH: number | null = null;
    if (described.every((d) => d.timesKnown)) {
      const arrivals = described.map((d) => d.outArriveMs);
      const returns = described.map((d) => d.retDepartMs);
      arrivalGapH = (Math.max(...arrivals) - Math.min(...arrivals)) / 3_600_000;
      returnGapH = (Math.max(...returns) - Math.min(...returns)) / 3_600_000;
      if (maxGapHours > 0 && (arrivalGapH > maxGapHours || returnGapH > maxGapHours)) {
        stats.rejectedByGap++;
        continue;
      }
    } else {
      stats.withoutTimes++; // can't check the rule, so it is allowed through
    }

    const total = fares.reduce((sum, fare, i) => sum + fare.price * counts[i], 0);
    const gapScore = (arrivalGapH ?? 0) + (returnGapH ?? 0);
    if (!best || total < best.total || (total === best.total && gapScore < best.gapScore)) {
      best = { date, total, gapScore, fares, described, arrivalGapH, returnGapH };
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
    const wantedCurrency = (url.searchParams.get("currency") ?? BASE_CURRENCY).toLowerCase();
    const mode = url.searchParams.get("mode") === "specific" ? "specific" : "flexible";
    const debugOn = url.searchParams.get("debug") === "1";
    const gapParam = url.searchParams.get("maxGapHours");
    const maxGapHours = gapParam === null ? DEFAULT_MAX_GAP_HOURS : Number(gapParam);
    const flexNights = Math.min(2, Math.max(0, Number(url.searchParams.get("flexNights") ?? "0") || 0));

    // The departures: `origins=STO,BRU,LON` (+ optional `counts=2,1,1` = people from each).
    // The old `originA` / `originB` parameters still work.
    const codes = (url.searchParams.get("origins") ?? [url.searchParams.get("originA"), url.searchParams.get("originB")].filter(Boolean).join(","))
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    const countList = (url.searchParams.get("counts") ?? "").split(",");
    const travelers: Traveler[] = codes.map((origin, i) => ({ origin, count: Math.min(9, Math.max(1, Math.floor(Number(countList[i])) || 1)) }));

    if (travelers.length < 2) return fail("Give at least two departures (origins=STO,BRU)");
    if (travelers.length > MAX_ORIGINS) return fail(`At most ${MAX_ORIGINS} departures are supported`);
    if (new Set(codes).size !== codes.length) return fail("Each departure must be a different airport or city (use the people count for several travellers from one place)");
    if (!Number.isFinite(maxGapHours)) return fail("maxGapHours must be a number (0 = no limit)");
    const N = travelers.length;
    const counts = travelers.map((t) => t.count);

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

    const callStats: CallStats = { calls: 0, cached: 0, failed: 0, retried: 0, skipped: 0, statuses: {}, firstError: null, rateLimited: false, budgetExhausted: false };

    // Phase 1: broad, dateless candidate discovery (one call per departure), plus the exchange rate.
    const [reports, rate] = await Promise.all([
      Promise.all(travelers.map((t) => fetchCheapestByDestination(t.origin, token, callStats))),
      usdRate(wantedCurrency),
    ]);
    // If we can't convert, answer in USD and say so (the page reads `currency`).
    const currency = rate === null ? BASE_CURRENCY : wantedCurrency;
    const toWanted = (usd: number) => Math.round(usd * (rate ?? 1));

    // Destinations everyone can reach, cheapest combined first.
    const shared = Object.keys(reports[0].prices)
      .filter((destination) => reports.every((r) => destination in r.prices))
      .map((destination) => ({ destination, baseline: reports.reduce((sum, r, i) => sum + r.prices[destination] * counts[i], 0) }))
      .sort((x, y) => x.baseline - y.baseline)
      .map((c) => c.destination);

    // More departures = more calls per destination, so check fewer destinations first.
    const lookupsPerCheck = lookupsFor(searchOptions).length;
    const firstPassSize = Math.max(4, Math.min(FIRST_PASS_CANDIDATES, Math.floor((MAX_CALLS_PER_SEARCH - N) / (N * lookupsPerCheck))));
    const firstPass = shared.slice(0, firstPassSize);
    const extraPass = shared.slice(firstPassSize, firstPassSize + EXTRA_CANDIDATES);

    // Names / coordinates / time zones for every departure and every destination we may check.
    const places = await resolvePlaces([...codes, ...firstPass, ...extraPass]);
    const originPlaces = codes.map((c) => places[c]);
    const havePlaces = (dest: Place | null | undefined) => !!dest && originPlaces.every(Boolean);

    // Accumulators for the debug block.
    const totals = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
    const withData = codes.map(() => new Set<string>());
    const samples: unknown[] = [];
    const checked = new Set<string>();
    const best = new Map<string, NonNullable<Awaited<ReturnType<typeof evaluate>>>>();
    const stages: Array<{ stage: string; destinations: number; stayLengths: number[]; matchesAfter: number }> = [];

    // One destination, one stay length -> the best matching day (or null).
    async function evaluate(destination: string, length: number) {
      const dest = places[destination];
      const faresList = await Promise.all(
        codes.map((origin) => faresForOriginDestination(origin, destination, token!, searchOptions, length, callStats))
      );
      faresList.forEach((fares, i) => {
        if (Object.keys(fares).length > 0) withData[i].add(destination);
      });

      if (debugOn && samples.length < 8) {
        faresList.forEach((fares, i) => {
          for (const [date, f] of Object.entries(fares).slice(0, 2)) samples.push({ who: codes[i], destination, date, length, ...f });
        });
      }

      // Without coordinates / time zones we can't estimate times; fall back to
      // "same day only", no time rule.
      if (!havePlaces(dest)) {
        let cheapest: { date: string; fares: Fare[] } | null = null;
        let cheapestTotal = Infinity;
        for (const date in faresList[0]) {
          if (!faresList.every((f) => date in f)) continue;
          const fares = faresList.map((f) => f[date]);
          const total = fares.reduce((s, f, i) => s + f.price * counts[i], 0);
          if (total < cheapestTotal) { cheapestTotal = total; cheapest = { date, fares }; }
        }
        if (!cheapest) return null;
        const legs: Leg[] = cheapest.fares.map((fare, i) => {
          const price = toWanted(fare.price);
          return { origin: codes[i], count: counts[i], price, subtotal: price * counts[i], transfers: fare.transfers, timesKnown: false, outDepart: null, outArrive: null, outMinutes: 0, retDepart: null, retArrive: null, retMinutes: 0 };
        });
        return {
          destination,
          destinationName: destination,
          country: "",
          lat: null as number | null,
          lon: null as number | null,
          total: legs.reduce((s, l) => s + l.subtotal, 0),
          departDate: cheapest.date,
          returnDate: addDays(cheapest.date, length),
          nights: length,
          travelers: legs,
          arrivalGapHours: null as number | null,
          returnGapHours: null as number | null,
        };
      }

      const { best: pick, stats } = bestGroupPairing(faresList, originPlaces as Place[], dest as Place, counts, maxGapHours);
      totals.sameDayPairs += stats.sameDayPairs;
      totals.rejectedByGap += stats.rejectedByGap;
      totals.withoutTimes += stats.withoutTimes;
      if (!pick) return null;

      const legs: Leg[] = pick.fares.map((fare, i) => {
        const d = pick.described[i];
        const price = toWanted(fare.price);
        return {
          origin: codes[i],
          count: counts[i],
          price,
          subtotal: price * counts[i],
          transfers: fare.transfers,
          timesKnown: d.timesKnown,
          outDepart: d.leg?.outDepart ?? null,
          outArrive: d.leg?.outArrive ?? null,
          outMinutes: d.minutes,
          retDepart: d.leg?.retDepart ?? null,
          retArrive: d.leg?.retArrive ?? null,
          retMinutes: d.minutes,
        };
      });

      return {
        destination,
        destinationName: (dest as Place).name,
        country: (dest as Place).country,
        lat: (dest as Place).lat as number | null,
        lon: (dest as Place).lon as number | null,
        total: legs.reduce((s, l) => s + l.subtotal, 0),
        departDate: pick.date,
        returnDate: addDays(pick.date, length),
        nights: length,
        travelers: legs,
        arrivalGapHours: pick.arrivalGapH as number | null,
        returnGapHours: pick.returnGapH as number | null,
      };
    }

    // Runs one stage: every destination x every stay length, keeping the cheapest match per destination.
    async function runStage(stage: string, destinations: string[], lengths: number[]) {
      destinations.forEach((d) => checked.add(d));
      // Pull anything we already remember from the database in a few big requests.
      const keys = destinations.flatMap((d) =>
        lengths.flatMap((length) => codes.flatMap((o) => lookupsFor(searchOptions).map((p) => cacheKey(o, d, p, length))))
      );
      await loadFromDatabase(keys);

      const jobs = destinations.flatMap((d) => lengths.map((length) => evaluate(d, length)));
      for (const result of await Promise.all(jobs)) {
        if (!result) continue;
        const current = best.get(result.destination);
        if (!current || result.total < current.total) best.set(result.destination, result);
      }
      stages.push({ stage, destinations: destinations.length, stayLengths: lengths, matchesAfter: best.size });
    }
    const canContinue = () => Date.now() - startedAt < TIME_BUDGET_MS && !callStats.rateLimited && !callStats.budgetExhausted;

    // Stage 1: the cheapest destinations, the exact stay length asked for.
    await runStage("exact stay length", firstPass, [baseNights]);

    // Stage 2 (flexible mode only): few matches? also try one night shorter / longer.
    if (mode === "flexible" && flexNights > 0 && best.size < MIN_RESULTS && canContinue()) {
      const lengths: number[] = [];
      for (let k = 1; k <= flexNights; k++) lengths.push(baseNights - k, baseNights + k);
      await runStage("stay length ± nights", firstPass.filter((d) => !best.has(d)), lengths.filter((n) => n >= 1 && n <= 30));
    }

    // Stage 3: still few matches? look at more destinations (exact length only, to keep the number of calls down).
    if (best.size < MIN_RESULTS && extraPass.length > 0 && canContinue()) {
      await runStage("more destinations", extraPass, [baseNights]);
    }

    await flushToDatabase(); // remember what we learned for next time

    const results = [...best.values()].sort((x, y) => x.total - y.total);
    const placeOut = (p: Place | null | undefined, i: number) => (p ? { code: p.code, name: p.name, country: p.country, lat: p.lat, lon: p.lon, count: counts[i] } : { code: codes[i], count: counts[i] });

    return new Response(
      JSON.stringify({
        results,
        currency, // the currency the prices above are in (USD if we couldn't convert)
        origins: originPlaces.map(placeOut),
        debug: {
          travelerCount: N,
          people: counts.reduce((a, b) => a + b, 0),
          originReports: reports.map((r, i) => ({ code: codes[i], ok: r.success, error: r.rawError, destinations: Object.keys(r.prices).length, destinationsWithFares: withData[i].size })),
          sharedDestinations: shared.length,
          candidatesConsidered: checked.size,
          candidatesWithDateMatch: results.length,
          maxGapHours,
          sameDayPairs: totals.sameDayPairs,
          rejectedByTimeGap: totals.rejectedByGap,
          pairsWithoutTimes: totals.withoutTimes,
          stages,
          // How the calls to Travelpayouts went. `failed` > 0 means some data is
          // missing because Travelpayouts didn't answer, NOT because no fares exist.
          travelpayouts: callStats,
          rateLimited: callStats.rateLimited,
          currencyRequested: wantedCurrency,
          currencyConverted: rate !== null,
          database: dbInfo,
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
