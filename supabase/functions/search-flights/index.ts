// Halfway Trips — search-flights Edge Function
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
//   2. For every one of those (cheapest first, within the call budget), gets
//      Travelpayouts' day-by-day calendar for every departure with the
//      requested stay length, and looks for days that work for ALL of them:
//        * short stays (up to 3 nights): the same days for everyone, and
//          everyone's arrival times AND return-flight times within
//          `maxGapHours` of each other — on a weekend, hours apart cost a day;
//        * longer stays: anyone may arrive or leave ONE day apart from the
//          others (shown on the result), and only arrivals on the same day
//          are timed.
//      Only direct flights and flights with one stop are used (MAX_STOPS).
//   3. Short stays with only a few matches also try the whole group a night
//      shorter / longer.
//   OR, when the destination is already chosen (`destination=LIS`): it
//   compares DATES instead of places — the next TRIP_WEEKS weekends (or weeks),
//   each with a few variations (leave a day earlier, come back a day later...),
//   cheapest first. Same time rule, and far fewer calls.
//   AND (`book=1`): makes the Travelpayouts partner link behind each
//   "Book on Aviasales" button (see bookingLink below).
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

const MAX_DESTINATIONS = 250;     // destinations everyone can reach that get checked day by day (cheapest first)
const MIN_RESULTS = 6;            // short stays: fewer matches than this -> also try a night shorter / longer
const SHORT_RETRY_DESTINATIONS = 40; // ...for this many of the cheapest destinations without a match
const MAX_RESULTS = 50;           // places sent back to the page (cheapest first)
const FLEXIBLE_SEARCH_MONTHS = 4; // months ahead a "flexible dates" search scans
const TIME_BUDGET_MS = 20_000;    // don't START new search stages after this long

// --- Which flights ------------------------------------------------------------

const MAX_STOPS = 1; // direct flights, or one stop; flights with more stops are left out

// --- The time rule ------------------------------------------------------------

// Short stays (up to 3 nights): everyone flies on the same days, and everyone's
// ARRIVAL times at the destination AND their RETURN-flight times may differ by
// at most this many hours — on a weekend, leaving hours apart costs a day.
// The page can override it per search (`maxGapHours` query parameter); 0 = no limit.
const DEFAULT_MAX_GAP_HOURS = 3;

// Longer stays (this many nights or more): only arriving together matters, and
// any traveller may arrive or leave ONE day apart from the others (shown on the
// result) — that finds far more trips for groups. A day apart only wins when it
// saves at least this much per person (or is the only way).
const DAY_APART_FROM_NIGHTS = 4;
const DAY_APART_PENALTY_USD = 15;

// --- Being gentle with Travelpayouts -------------------------------------------

// Travelpayouts' limits (support article "API rate limits"): the day-by-day
// calendar allows 300 requests a minute and at most 10 a second; the broad
// "everything from one city" request (prices_for_dates) 600 a minute. Going
// over blocks us for the rest of the minute (HTTP 429).
const CALL_CONCURRENCY = 4;        // calls running at the same time
const MIN_CALL_GAP_MS = 120;       // ...and started at most ~8 a second
const MAX_CALLS_PER_SEARCH = 90;   // new (uncached) calls one search may make (~11 s at most)
// Each answer says how many requests of that kind are left this minute
// (X-Rate-Limit-Remaining). Below this many, an "Anywhere" search makes no
// more new calls of that kind — the rest of the minute is kept for other
// visitors. A "Going to" search needs only a few calls, so it may go lower.
const QUOTA_RESERVE = 60;
const QUOTA_RESERVE_TRIP = 10;
const BREAKER_429_COUNT = 10;      // this many 429s -> stop calling Travelpayouts for this search
const CALL_RETRIES = 2;            // retries for network errors / 5xx (a 429 gets one slow retry)
const CACHE_TTL_MS = 24 * 3_600_000; // how long a remembered answer stays valid (Travelpayouts recommends 24 h)

// The broad request: the cheapest round trips from one city to ANY destination,
// for one month of departures (one request per city x month x return month).
const BROAD_LIMIT = 1000;          // tickets per page (the maximum)
const BROAD_MAX_PAGES = 2;

const BASE_CURRENCY = "usd"; // everything is fetched in this, then converted

// --- Group size ---------------------------------------------------------------

// How many different departure airports/cities one search may have. With the
// free cached data, the more departures there are, the less likely it is that
// EVERYONE has a cached fare on the same day — a live flight API fixes that.
const MAX_ORIGINS = 8;

type Fare = {
  price: number;
  departureAt: string | null;
  returnAt: string | null;
  transfers: number;     // stops (for the broad answers: the larger of the way there and the way back)
  minutesTo?: number;    // real flight durations, when Travelpayouts gives them (the broad answers do)
  minutesBack?: number;
};
type Traveler = { origin: string; count: number };
type Place = { code: string; name: string; country: string; lat: number; lon: number; tz: string };
type CallStats = {
  cap: number;        // new calls allowed so far (MAX_CALLS_PER_SEARCH, or less in an early stage)
  calls: number;      // new calls attempted
  cached: number;     // answers served from memory or the database
  failed: number;     // calls that never got an answer
  retried: number;
  skipped: number;    // calls not made (budget used up, or rate-limited)
  statuses: Record<string, number>;
  firstError: string | null;
  rateLimited: boolean;
  budgetExhausted: boolean;
  quotaLeft: Record<string, number>; // per kind of request: what Travelpayouts says is left this minute
  reserve: number;                   // ...and how much of it this search must leave for others
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

// How many minutes `tz` is ahead of UTC at the given instant. (One formatter
// per time zone, made once: making them is slow, and a search uses thousands.)
const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function offsetMinutes(tz: string, atMs: number): number {
  let formatter = tzFormatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    tzFormatters.set(tz, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
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

// A tiny gate: only CALL_CONCURRENCY calls in flight at once, started at
// least MIN_CALL_GAP_MS apart (Travelpayouts allows ~10 a second).
let inFlight = 0;
const waiting: Array<() => void> = [];
let nextStartAt = 0;
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= CALL_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt);
    nextStartAt = startAt + MIN_CALL_GAP_MS;
    if (startAt > now) await sleep(startAt - now);
    return await task();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

// The kind of request, as Travelpayouts counts its limits (e.g. "/v1/prices/calendar").
const kindOf = (url: string) => new URL(url).pathname;
const lowOnQuota = (url: string, stats: CallStats) => (stats.quotaLeft[kindOf(url)] ?? Infinity) <= stats.reserve;

// GET a Travelpayouts URL as JSON. Returns null (and counts why in `stats`) if
// no answer was obtained — so callers can tell "no data" from "call failed".
async function getJson(url: string, stats: CallStats): Promise<Record<string, unknown> | null> {
  if (stats.rateLimited) { stats.skipped++; return null; }
  if (stats.calls >= stats.cap || lowOnQuota(url, stats)) { stats.budgetExhausted = true; stats.skipped++; return null; }
  stats.calls++;

  let tried429 = false;
  for (let attempt = 0; attempt <= CALL_RETRIES; attempt++) {
    if (stats.rateLimited) break; // another call just tripped the breaker
    try {
      // Checked again when our turn comes: calls queued before the breaker
      // tripped, or before the quota ran low, are dropped (not sent).
      const response = await limited(() => (stats.rateLimited || lowOnQuota(url, stats) ? Promise.resolve(null) : fetch(url)));
      if (!response) {
        if (stats.rateLimited) break;
        stats.calls--; // never sent
        stats.budgetExhausted = true;
        stats.skipped++;
        return null;
      }
      const left = Number(response.headers.get("x-rate-limit-remaining"));
      if (response.headers.has("x-rate-limit-remaining") && Number.isFinite(left)) {
        stats.quotaLeft[kindOf(url)] = Math.min(stats.quotaLeft[kindOf(url)] ?? Infinity, left);
      }
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
// What happened with the database during this search (reset at the start of each one).
const dbInfo = { status: "not used yet" as string, loaded: 0, saved: 0, loadFailures: 0, lastProblem: null as string | null };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const dbHeaders = () => ({ apikey: SERVICE_KEY!, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" });
let dbDisabled = !SUPABASE_URL || !SERVICE_KEY;

// Pull any remembered answers for these keys into memory: DB_CHUNK keys per
// request (40 is known to work), DB_PARALLEL requests at a time. A failed
// request only loses its own keys; after DB_MAX_FAILURES we stop trying.
const DB_CHUNK = 40;
const DB_PARALLEL = 6;
const DB_MAX_FAILURES = 3;
const dbLookedUp = new Set<string>(); // keys already asked for during this search
async function loadFromDatabase(keys: string[]): Promise<void> {
  if (dbDisabled) { dbInfo.status = SUPABASE_URL && SERVICE_KEY ? dbInfo.status : "off (no service key)"; return; }
  const missing = [...new Set(keys)].filter((k) => !dbLookedUp.has(k) && (!memoryCache.has(k) || Date.now() - memoryCache.get(k)!.at >= CACHE_TTL_MS));

  async function loadChunk(chunk: string[]): Promise<void> {
    chunk.forEach((k) => dbLookedUp.add(k));
    try {
      const filter = `in.(${chunk.map((k) => `"${k}"`).join(",")})`;
      const response = await fetch(`${SUPABASE_URL}/rest/v1/calendar_cache?select=key,fares,fetched_at&key=${encodeURIComponent(filter)}`, { headers: dbHeaders() });
      if (!response.ok) {
        dbInfo.loadFailures++;
        dbInfo.lastProblem = `load failed (HTTP ${response.status}) — is supabase/calendar_cache.sql set up?`;
        return;
      }
      for (const row of (await response.json()) as Array<{ key: string; fares: Record<string, Fare>; fetched_at: string }>) {
        const at = Date.parse(row.fetched_at);
        if (Date.now() - at < CACHE_TTL_MS) {
          memoryCache.set(row.key, { at, fares: row.fares });
          dbInfo.loaded++;
        }
      }
    } catch (error) {
      dbInfo.loadFailures++;
      dbInfo.lastProblem = `load failed (${String(error).slice(0, 80)})`;
    }
  }

  const chunks: string[][] = [];
  for (let i = 0; i < missing.length; i += DB_CHUNK) chunks.push(missing.slice(i, i + DB_CHUNK));
  for (let i = 0; i < chunks.length && dbInfo.loadFailures < DB_MAX_FAILURES; i += DB_PARALLEL) {
    await Promise.all(chunks.slice(i, i + DB_PARALLEL).map(loadChunk));
  }
  dbInfo.status = dbInfo.loadFailures === 0 ? "ok" : `${dbInfo.loadFailures} load request(s) failed`;
}

// Save the answers we just fetched (called once, at the end of a search).
// Save the answers we just fetched (called once, at the end of a search), in
// batches of at most ~400 KB (a broad answer alone can be ~150 KB).
const DB_SAVE_BYTES = 400_000;
async function flushToDatabase(): Promise<void> {
  if (dbDisabled || pendingWrites.length === 0) return;
  const rows = pendingWrites.splice(0, pendingWrites.length);
  const batches: Array<typeof rows> = [];
  let batch: typeof rows = [];
  let size = 0;
  for (const row of rows) {
    const rowSize = JSON.stringify(row).length;
    if (batch.length > 0 && size + rowSize > DB_SAVE_BYTES) { batches.push(batch); batch = []; size = 0; }
    batch.push(row);
    size += rowSize;
  }
  if (batch.length > 0) batches.push(batch);

  for (const b of batches) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/calendar_cache`, {
        method: "POST",
        headers: { ...dbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(b),
      });
      if (response.ok) dbInfo.saved += b.length;
      else dbInfo.lastProblem = `save failed (HTTP ${response.status})`;
    } catch (error) {
      dbInfo.lastProblem = `save failed (${String(error).slice(0, 80)})`;
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
  | { mode: "specific"; departDate: string; dayApart: boolean }
  | { mode: "flexible"; weekendOnly: boolean };

const monthOf = (dateStr: string) => dateStr.slice(0, 7);

// The calendar lookups one origin/destination/length needs: one per month
// (flexible dates), or the exact date — or, when travellers may arrive a day
// apart, the month(s) around it, to also see the day before and the day after.
function lookupsFor(options: SearchOptions): string[] {
  if (options.mode === "flexible") return upcomingMonths(FLEXIBLE_SEARCH_MONTHS);
  if (!options.dayApart) return [options.departDate];
  return [...new Set([addDays(options.departDate, -1), addDays(options.departDate, 1)].map(monthOf))];
}

// The fares we can use: direct or MAX_STOPS stops at most, and Fri/Sat
// departures only for a weekend search.
function usableFares(fares: Record<string, Fare>, options: SearchOptions | null): Record<string, Fare> {
  const weekendOnly = options?.mode === "flexible" && options.weekendOnly;
  return Object.fromEntries(Object.entries(fares).filter(([date, f]) => f.transfers <= MAX_STOPS && (!weekendOnly || isFridayOrSaturday(date))));
}

/* ---------------------------------------------------------------------------
   Broad answers: the cheapest round trips from ONE city to ANY destination,
   for departures in one month and returns in the same or the next month —
   Travelpayouts' prices_for_dates with only an origin. A few of these requests
   cover every destination at once (the day-by-day calendar needs one request
   per destination, month and stay length). They also give the real flight
   durations and the stops each way.
--------------------------------------------------------------------------- */

const broadKey = (origin: string, month: string, returnMonth: string) => ["broad", origin, BASE_CURRENCY, month, returnMonth].join("_");
const nextMonth = (month: string) => monthOf(addDays(`${month}-28`, 7));
const toNumber = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

// The [departure month, return month] pairs a search needs.
function broadLookups(options: SearchOptions): Array<[string, string]> {
  const months = [...new Set(lookupsFor(options).map(monthOf))];
  return months.flatMap((m) => [[m, m], [m, nextMonth(m)]] as Array<[string, string]>);
}

// One broad answer, as { "LIS|2026-11-07|7": the cheapest such trip }.
async function fetchBroadFares(origin: string, month: string, returnMonth: string, token: string, stats: CallStats): Promise<Record<string, Fare>> {
  const key = broadKey(origin, month, returnMonth);
  const hit = memoryCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    stats.cached++;
    return hit.fares;
  }
  const fares: Record<string, Fare> = {};
  let answered = false;
  for (let page = 1; page <= BROAD_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      origin, departure_at: month, return_at: returnMonth, one_way: "false", direct: "false", unique: "false",
      sorting: "price", currency: BASE_CURRENCY, limit: String(BROAD_LIMIT), page: String(page), token,
    });
    const json = await getJson(`https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`, stats);
    if (!json) break;
    answered = true;
    const tickets = Array.isArray(json.data) ? (json.data as Array<Record<string, unknown>>) : [];
    for (const t of tickets) {
      const departureAt = typeof t.departure_at === "string" ? t.departure_at : null;
      const returnAt = typeof t.return_at === "string" ? t.return_at : null;
      if (typeof t.destination !== "string" || typeof t.price !== "number" || !departureAt || !returnAt) continue;
      const date = departureAt.slice(0, 10);
      const length = Math.round((Date.parse(returnAt.slice(0, 10)) - Date.parse(date)) / 86_400_000);
      if (!(length >= 1 && length <= 30)) continue;
      const k = `${t.destination}|${date}|${length}`;
      if (fares[k] && fares[k].price <= t.price) continue;
      fares[k] = {
        price: t.price,
        departureAt,
        returnAt,
        transfers: Math.max(toNumber(t.transfers), toNumber(t.return_transfers)),
        minutesTo: toNumber(t.duration_to) || undefined,
        minutesBack: toNumber(t.duration_back) || undefined,
      };
    }
    if (tickets.length < BROAD_LIMIT) break; // that was the last page
  }
  if (!answered) return fares; // no answer: not remembered, so a later search can try again
  const at = Date.now();
  memoryCache.set(key, { at, fares });
  pendingWrites.push({ key, fares, fetched_at: new Date(at).toISOString() });
  return fares;
}

// Broad answers, rearranged for quick lookups: "PAR_LIS_7" -> fares by departure day.
type BroadIndex = Map<string, Record<string, Fare>>;
function indexBroad(origin: string, answers: Array<Record<string, Fare>>, index: BroadIndex) {
  for (const fares of answers) {
    for (const [k, fare] of Object.entries(fares)) {
      const [destination, date, length] = k.split("|");
      const byDay = index.get(`${origin}_${destination}_${length}`) ?? {};
      if (!byDay[date] || fare.price < byDay[date].price) byDay[date] = fare;
      index.set(`${origin}_${destination}_${length}`, byDay);
    }
  }
}

// What we already know for one origin/destination/stay length — the broad
// answers and any day-by-day calendars fetched or loaded — never makes a new
// call. The cheapest fare wins on each day.
function rememberedFares(origin: string, destination: string, length: number, options: SearchOptions, broad: BroadIndex): Record<string, Fare> {
  const fares: Record<string, Fare> = { ...(broad.get(`${origin}_${destination}_${length}`) ?? {}) };
  for (const lookup of lookupsFor(options)) {
    const hit = memoryCache.get(cacheKey(origin, destination, lookup, length));
    if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) continue;
    for (const [date, fare] of Object.entries(hit.fares)) {
      if (!fares[date] || fare.price < fares[date].price) fares[date] = fare;
    }
  }
  // Exact dates (no "day apart"): only that day.
  if (options.mode === "specific" && !options.dayApart) {
    return usableFares(fares[options.departDate] ? { [options.departDate]: fares[options.departDate] } : {}, options);
  }
  return usableFares(fares, options);
}

// Are all the day-by-day calendars for this destination already in memory?
function calendarsRemembered(codes: string[], destination: string, lengths: number[], options: SearchOptions): boolean {
  return codes.every((o) => lengths.every((n) => lookupsFor(options).every((p) => {
    const hit = memoryCache.get(cacheKey(o, destination, p, n));
    return Boolean(hit && Date.now() - hit.at < CACHE_TTL_MS);
  })));
}

/* ---------------------------------------------------------------------------
   Matching a group of travelers (2 to MAX_ORIGINS departures)
--------------------------------------------------------------------------- */

// On longer stays a traveller may arrive or leave one day apart from the group.
type Apart = null | "arrives-earlier" | "arrives-later" | "leaves-earlier" | "leaves-later";

type Leg = {
  origin: string;
  count: number;            // how many people travel from this departure
  price: number;            // price per person
  subtotal: number;         // price x count
  departDate: string;       // this traveller's own dates (the same as the trip's,
  returnDate: string;       // unless `apart` says otherwise)
  apart: Apart;
  transfers: number;
  timesKnown: boolean;
  outDepart: string | null; // local time at the origin
  outArrive: string | null; // local time at the destination (estimated)
  outMinutes: number;
  retDepart: string | null; // local time at the destination
  retArrive: string | null; // local time back home (estimated)
  retMinutes: number;
};

// One place in the answer to an "Anywhere" search: the cheapest trip found there.
type TripResult = {
  destination: string;
  destinationName: string;
  country: string;
  lat: number | null;
  lon: number | null;
  total: number;
  departDate: string;  // the group's days (a traveller "a day apart" has their own in `travelers`)
  returnDate: string;
  nights: number;
  travelers: Leg[];
  arrivalGapHours: number | null; // null when not everyone arrives the same day
  returnGapHours: number | null;
  daysApart: boolean;  // someone arrives or leaves a day apart
};

// Everything we can say about one traveler's trip on a given day.
function describeLeg(fare: Fare, origin: Place, dest: Place) {
  // Real flight durations when we have them, otherwise an estimate from the distance.
  const estimate = estimateMinutes(haversineKm(origin, dest), fare.transfers);
  const minutes = fare.minutesTo && fare.minutesTo > 0 ? fare.minutesTo : estimate;
  const minutesBack = fare.minutesBack && fare.minutesBack > 0 ? fare.minutesBack : estimate;
  if (!fare.departureAt || !fare.returnAt) {
    return { timesKnown: false, minutes, outArriveMs: 0, retDepartMs: 0, leg: null as Partial<Leg> | null };
  }
  const outDepartMs = fareTimeToUtcMs(fare.departureAt, origin.tz);
  const outArriveMs = outDepartMs + minutes * 60000;
  const retDepartMs = fareTimeToUtcMs(fare.returnAt, dest.tz);
  const retArriveMs = retDepartMs + minutesBack * 60000;
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

const spreadHours = (times: number[]) => (Math.max(...times) - Math.min(...times)) / 3_600_000;

// Can the group fly on these fares (one per departure, same days)? Estimates
// everyone's arrival and return-flight times and checks the arrivals — and,
// with `checkReturns` (short stays), the return flights — fall within
// maxGapHours of each other. Without times or places the rule can't be
// checked, so the day is allowed through.
function judgeGroup(fares: Fare[], originPlaces: Array<Place | null>, dest: Place | null | undefined, maxGapHours: number, checkReturns: boolean) {
  const described = dest && originPlaces.every(Boolean) ? fares.map((fare, i) => describeLeg(fare, originPlaces[i] as Place, dest)) : null;
  let arrivalGapH: number | null = null;
  let returnGapH: number | null = null;
  if (described && described.every((d) => d.timesKnown)) {
    arrivalGapH = spreadHours(described.map((d) => d.outArriveMs));
    returnGapH = spreadHours(described.map((d) => d.retDepartMs));
  }
  const tooFarApart = arrivalGapH !== null && returnGapH !== null && maxGapHours > 0 && (arrivalGapH > maxGapHours || (checkReturns && returnGapH > maxGapHours));
  return { described, arrivalGapH, returnGapH, tooFarApart };
}

// One Leg per departure, with prices converted to the page's currency and
// each traveller's own dates.
function legsFor(
  fares: Fare[],
  described: Array<ReturnType<typeof describeLeg>> | null,
  codes: string[],
  counts: number[],
  toWanted: (usd: number) => number,
  dates: Array<{ departDate: string; returnDate: string; apart: Apart }>
): Leg[] {
  return fares.map((fare, i) => {
    const d = described?.[i];
    const price = toWanted(fare.price);
    return {
      origin: codes[i],
      count: counts[i],
      price,
      subtotal: price * counts[i],
      ...dates[i],
      transfers: fare.transfers,
      timesKnown: d?.timesKnown ?? false,
      outDepart: d?.leg?.outDepart ?? null,
      outArrive: d?.leg?.outArrive ?? null,
      outMinutes: d?.minutes ?? 0,
      retDepart: d?.leg?.retDepart ?? null,
      retArrive: d?.leg?.retArrive ?? null,
      retMinutes: d?.minutes ?? 0,
    };
  });
}

// Short stays: the cheapest departure day that EVERY origin has a cached fare
// for AND where everyone's arrival times and return-flight times fall within
// maxGapHours of each other. Prices are weighted by how many people travel
// from each departure.
function bestGroupPairing(
  faresList: Array<Record<string, Fare>>,
  originPlaces: Array<Place | null>,
  dest: Place | null | undefined,
  counts: number[],
  maxGapHours: number
) {
  const stats = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
  let best: null | {
    date: string;
    total: number;
    gapScore: number;
    fares: Fare[];
    described: Array<ReturnType<typeof describeLeg>> | null;
    arrivalGapH: number | null;
    returnGapH: number | null;
  } = null;

  for (const date in faresList[0]) {
    if (!faresList.every((fares) => date in fares)) continue;
    stats.sameDayPairs++;
    const fares = faresList.map((f) => f[date]);
    const { described, arrivalGapH, returnGapH, tooFarApart } = judgeGroup(fares, originPlaces, dest, maxGapHours, true);
    if (tooFarApart) {
      stats.rejectedByGap++;
      continue;
    }
    if (arrivalGapH === null) stats.withoutTimes++; // can't check the rule, so it is allowed through

    const total = fares.reduce((sum, fare, i) => sum + fare.price * counts[i], 0);
    const gapScore = (arrivalGapH ?? 0) + (returnGapH ?? 0);
    if (!best || total < best.total || (total === best.total && gapScore < best.gapScore)) {
      best = { date, total, gapScore, fares, described, arrivalGapH, returnGapH };
    }
  }
  return { best, stats };
}

// Longer stays: around every possible trip (group departure day D, stay L),
// each traveller takes their best choice of:
//   the group's days D -> D+L · arriving a day early (D-1) or late (D+1) ·
//   leaving a day early (D+L-1) or late (D+L+1)   — never both.
// At least one traveller keeps the group's days, and all arrivals (and all
// departures home) stay within ONE day of each other — so nobody is two days
// apart from anyone. A day apart costs DAY_APART_PENALTY_USD per person in the
// comparison, so it is only chosen when it saves money or is the only way.
// Travellers who arrive on the same day must land within maxGapHours of each
// other; flight times home don't matter on a longer stay.
const DAY_APART_CHOICES: Array<{ depart: number; length: number; apart: Apart }> = [
  { depart: 0, length: 0, apart: null },
  { depart: -1, length: 1, apart: "arrives-earlier" },
  { depart: 1, length: -1, apart: "arrives-later" },
  { depart: 0, length: -1, apart: "leaves-earlier" },
  { depart: 0, length: 1, apart: "leaves-later" },
];

type TravellerPick = { fare: Fare; choice: (typeof DAY_APART_CHOICES)[number]; score: number };

// "Within one day of each other" means the moves go one way on each side:
// everyone who moves their arrival moves it the same way, and the same for leaving.
const DAY_APART_DIRECTIONS: Array<[Apart, Apart]> = [
  ["arrives-earlier", "leaves-earlier"],
  ["arrives-earlier", "leaves-later"],
  ["arrives-later", "leaves-earlier"],
  ["arrives-later", "leaves-later"],
];

function bestDayApartPairing(
  calendars: Array<Record<number, Record<string, Fare>>>, // per traveller: stay length -> fares by departure day
  originPlaces: Array<Place | null>,
  dest: Place | null | undefined,
  counts: number[],
  nights: number,
  maxGapHours: number,
  onlyDay: string | null // exact dates: the group's departure day is fixed
) {
  const stats = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
  const canTime = Boolean(dest) && originPlaces.every(Boolean);
  const timesFor = (picks: TravellerPick[]) => picks.map((p, i) => describeLeg(p.fare, originPlaces[i] as Place, dest as Place));

  // Travellers arriving on the same day must land within maxGapHours of each other.
  function arrivalsOk(picks: TravellerPick[]): boolean {
    if (!canTime || maxGapHours <= 0) return true;
    const times = timesFor(picks);
    const byDay = new Map<number, number[]>();
    picks.forEach((p, i) => {
      if (!times[i].timesKnown) return;
      byDay.set(p.choice.depart, [...(byDay.get(p.choice.depart) ?? []), times[i].outArriveMs]);
    });
    return [...byDay.values()].every((arrivals) => arrivals.length < 2 || spreadHours(arrivals) <= maxGapHours);
  }

  // Every group departure day worth trying.
  const days = new Set<string>();
  for (const byLength of calendars) {
    for (const c of DAY_APART_CHOICES) for (const date in byLength[nights + c.length] ?? {}) days.add(addDays(date, -c.depart));
  }

  let best: null | { date: string; picks: TravellerPick[]; score: number; total: number } = null;
  for (const day of days) {
    if (onlyDay && day !== onlyDay) continue;
    // Each traveller's choices for this trip, best (cheapest, with the penalty) first.
    const options = calendars.map((byLength, i) =>
      DAY_APART_CHOICES.flatMap((choice) => {
        const fare = byLength[nights + choice.length]?.[addDays(day, choice.depart)];
        return fare ? [{ fare, choice, score: (fare.price + (choice.apart ? DAY_APART_PENALTY_USD : 0)) * counts[i] }] : [];
      }).sort((a, b) => a.score - b.score)
    );
    if (options.some((o) => o.length === 0)) continue;
    if (options.every((o) => o.some((p) => p.choice.apart === null))) stats.sameDayPairs++;

    const scoreOf = (ps: TravellerPick[]) => ps.reduce((sum, p) => sum + p.score, 0);
    const onGroupDays = (ps: TravellerPick[]) => ps.some((p) => p.choice.apart === null);
    let rejected = false;
    for (const direction of DAY_APART_DIRECTIONS) {
      const allowed = options.map((o) => o.filter((p) => p.choice.apart === null || direction.includes(p.choice.apart)));
      if (allowed.some((o) => o.length === 0)) continue;
      let picks = allowed.map((o) => o[0]);
      // Someone keeps the group's days: the traveller for whom that costs least.
      if (!onGroupDays(picks)) {
        let swap: { i: number; pick: TravellerPick; extra: number } | null = null;
        for (let i = 0; i < picks.length; i++) {
          const core = allowed[i].find((p) => p.choice.apart === null);
          if (core && (swap === null || core.score - picks[i].score < swap.extra)) swap = { i, pick: core, extra: core.score - picks[i].score };
        }
        if (swap === null) continue;
        const s = swap;
        picks = picks.map((p, i) => (i === s.i ? s.pick : p));
      }
      if (best && scoreOf(picks) >= best.score) continue; // can't beat what we have
      if (!arrivalsOk(picks)) {
        // Landing too far apart: let one traveller take their best choice on another arrival day instead.
        let fixed: TravellerPick[] | null = null;
        for (let i = 0; i < picks.length; i++) {
          const other = allowed[i].find((o) => o.choice.depart !== picks[i].choice.depart);
          if (!other) continue;
          const tryPicks = picks.map((q, j) => (j === i ? other : q));
          if (onGroupDays(tryPicks) && arrivalsOk(tryPicks) && (fixed === null || scoreOf(tryPicks) < scoreOf(fixed))) fixed = tryPicks;
        }
        if (fixed === null) { rejected = true; continue; }
        picks = fixed;
        if (best && scoreOf(picks) >= best.score) continue;
      }
      best = { date: day, picks, score: scoreOf(picks), total: picks.reduce((sum, p, i) => sum + p.fare.price * counts[i], 0) };
      rejected = false;
    }
    if (rejected) stats.rejectedByGap++;
  }
  if (!best) return { best: null, stats };

  // The chosen trip in full: everyone's times, and how close the arrivals (and returns) are.
  const described = canTime ? timesFor(best.picks) : null;
  const known = described && described.every((d) => d.timesKnown);
  const sameArrival = best.picks.every((p) => p.choice.depart === best!.picks[0].choice.depart);
  const sameReturn = best.picks.every((p) => p.choice.depart + p.choice.length === best!.picks[0].choice.depart + best!.picks[0].choice.length);
  if (!known) stats.withoutTimes++;
  return {
    best: {
      ...best,
      described,
      arrivalGapH: known && sameArrival ? spreadHours(described!.map((d) => d.outArriveMs)) : null,
      returnGapH: known && sameReturn ? spreadHours(described!.map((d) => d.retDepartMs)) : null,
    },
    stats,
  };
}

/* ---------------------------------------------------------------------------
   Trip search: everyone flies to ONE destination chosen in advance, and we
   compare dates instead of places
--------------------------------------------------------------------------- */

// The stays the page offers: leave on `weekday` (0 = Sunday ... 5 = Friday,
// 6 = Saturday) for `nights` nights.
const TRIP_TYPES: Record<string, { weekday: number; nights: number }> = {
  weekend: { weekday: 5, nights: 2 }, // Fri -> Sun
  long: { weekday: 5, nights: 3 },    // Fri -> Mon
  week: { weekday: 6, nights: 7 },    // Sat -> Sat
};
const TRIP_WEEKS = 10; // how many weekends (or weeks) ahead a trip search compares

// Around each base trip we also price these variations: [days to move the
// departure, days to move the return]. Around Fri -> Sun that gives
// Thu -> Sun, Fri -> Mon, Sat -> Mon and Thu -> Sat.
const TRIP_VARIATIONS: Array<[number, number]> = [[0, 0], [-1, 0], [0, 1], [1, 1], [-1, -1]];

type TripOption = {
  departDate: string;
  returnDate: string;
  nights: number;
  shift: [number, number]; // [0, 0] = the base trip itself
  // ok = priced · gap = everyone has a fare but arrivals/returns are too far
  // apart · missing = someone has no cached fare for these days
  status: "ok" | "gap" | "missing";
  total: number | null;
  travelers: Leg[] | null;
  arrivalGapHours: number | null;
  returnGapHours: number | null;
};

// The base departure days: the next `weeks` `weekday`s, far enough ahead that
// "leave a day earlier" is still in the future.
function tripBaseDates(weekday: number, weeks: number): string[] {
  let date = addDays(new Date().toISOString().slice(0, 10), 2);
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== weekday) date = addDays(date, 1);
  return Array.from({ length: weeks }, (_, i) => addDays(date, 7 * i));
}

async function searchTrip(o: {
  destination: string;
  codes: string[];
  counts: number[];
  baseDates: string[];
  nights: number;
  maxGapHours: number;
  token: string;
  toWanted: (usd: number) => number;
  stats: CallStats;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const windows = o.baseDates.map((departDate) => ({
    departDate,
    returnDate: addDays(departDate, o.nights),
    trips: TRIP_VARIATIONS.map(([moveOut, moveBack]) => ({
      departDate: addDays(departDate, moveOut),
      returnDate: addDays(departDate, o.nights + moveBack),
      nights: o.nights + moveBack - moveOut,
      shift: [moveOut, moveBack] as [number, number],
    })).filter((t) => t.nights >= 1 && t.nights <= 30 && t.departDate >= today),
  }));

  // One calendar per departure x month x stay length (remembered answers first).
  const lengths = [...new Set(windows.flatMap((w) => w.trips.map((t) => t.nights)))];
  const months = [...new Set(windows.flatMap((w) => w.trips.map((t) => t.departDate.slice(0, 7))))];
  await loadFromDatabase(o.codes.flatMap((origin) => months.flatMap((m) => lengths.map((n) => cacheKey(origin, o.destination, m, n)))));
  const placesPromise = resolvePlaces([...o.codes, o.destination]);
  const calendars = new Map<string, Record<string, Fare>>(); // "STO_2" -> fares by departure day
  await Promise.all(
    o.codes.flatMap((origin) =>
      lengths.map(async (n) => {
        const parts = await Promise.all(months.map((m) => fetchCalendarFares(origin, o.destination, m, n, o.token, o.stats)));
        calendars.set(`${origin}_${n}`, usableFares(Object.assign({}, ...parts), null)); // direct or 1 stop
      })
    )
  );
  const places = await placesPromise;
  const originPlaces = o.codes.map((c) => places[c]);
  const dest = places[o.destination];

  const counters = { priced: 0, rejectedByGap: 0, missing: 0 };
  const statusOrder = { ok: 0, gap: 1, missing: 2 };
  const checkReturns = o.nights < DAY_APART_FROM_NIGHTS; // weekends: arrivals and returns · longer stays: arrivals only
  const result = windows.map((w) => {
    const options: TripOption[] = w.trips.map((trip) => {
      const fares = o.codes.map((origin) => calendars.get(`${origin}_${trip.nights}`)?.[trip.departDate]);
      if (fares.some((f) => !f)) {
        counters.missing++;
        return { ...trip, status: "missing", total: null, travelers: null, arrivalGapHours: null, returnGapHours: null };
      }
      const judged = judgeGroup(fares as Fare[], originPlaces, dest, o.maxGapHours, checkReturns);
      const sameDates = o.codes.map(() => ({ departDate: trip.departDate, returnDate: trip.returnDate, apart: null as Apart }));
      const travelers = legsFor(fares as Fare[], judged.described, o.codes, o.counts, o.toWanted, sameDates);
      if (judged.tooFarApart) counters.rejectedByGap++;
      else counters.priced++;
      return {
        ...trip,
        status: judged.tooFarApart ? "gap" : "ok",
        total: travelers.reduce((sum, leg) => sum + leg.subtotal, 0),
        travelers,
        arrivalGapHours: judged.arrivalGapH,
        returnGapHours: judged.returnGapH,
      };
    });
    // Cheapest first; then the ones with times too far apart; then the ones without fares.
    options.sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || (a.total ?? 0) - (b.total ?? 0));
    return { departDate: w.departDate, returnDate: w.returnDate, options };
  });

  return {
    destination: dest
      ? { code: dest.code, name: dest.name, country: dest.country, lat: dest.lat, lon: dest.lon }
      : { code: o.destination, name: o.destination, country: "", lat: null, lon: null },
    windows: result,
    originPlaces,
    counters,
    lengths,
    months,
    // How many departure days with a cached fare each departure has (all stay lengths together).
    faresFound: o.codes.map((code) => ({ code, days: lengths.reduce((sum, n) => sum + Object.keys(calendars.get(`${code}_${n}`) ?? {}).length, 0) })),
  };
}

const placeOut = (p: Place | null | undefined, code: string, count: number) =>
  p ? { code: p.code, name: p.name, country: p.country, lat: p.lat, lon: p.lon, count } : { code, count };

/* ---------------------------------------------------------------------------
   Booking links (`book=1`): one traveller's Aviasales search, turned into a
   Travelpayouts PARTNER link so a booking made after the click is credited
   to you. Travelpayouts says this conversion is required — just adding your
   marker to an Aviasales address isn't enough. It needs the API token, which
   is why it happens here and not in the page.
   Needs two more Edge Function Secrets (not secret really, but kept with the
   token): TRAVELPAYOUTS_MARKER (your partner ID) and TRAVELPAYOUTS_TRS (the
   ID of your project that is connected to Aviasales).
--------------------------------------------------------------------------- */

const LINKS_API_URL = "https://api.travelpayouts.com/links/v1/create";
const partnerLinkCache = new Map<string, { at: number; url: string }>();
const BOOKING_SUB_ID = "book-button"; // shows up in your Travelpayouts statistics

// Aviasales' search address: ORIGIN + DDMM + DESTINATION + DDMM + adults,
// e.g. /search/STO0611LIS08112 = Stockholm to Lisbon, 6 Nov back 8 Nov, 2 adults.
function aviasalesSearchUrl(from: string, to: string, departDate: string, returnDate: string | null, adults: number): string {
  const ddmm = (iso: string) => iso.slice(8, 10) + iso.slice(5, 7);
  return `https://www.aviasales.com/search/${from}${ddmm(departDate)}${to}${returnDate ? ddmm(returnDate) : ""}${adults}`;
}

// -> { url, tracked } where `tracked` says whether bookings through `url` are
// credited to you. If the partner link can't be made, `url` is the plain
// Aviasales search (so the visitor still gets their flights) and `reason` says why.
async function bookingLink(params: URLSearchParams, token: string | undefined) {
  const from = (params.get("from") ?? "").toUpperCase();
  const to = (params.get("to") ?? "").toUpperCase();
  const departDate = params.get("depart") ?? "";
  const returnDate = params.get("return") || null;
  const adults = Math.floor(Number(params.get("adults") ?? "1"));
  const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return { error: "from and to must be 3-letter airport or city codes" };
  if (!isDate(departDate) || (returnDate !== null && !isDate(returnDate))) return { error: "depart (and return) must be dates like 2026-11-06" };
  if (!(adults >= 1 && adults <= 9)) return { error: "adults must be between 1 and 9" };

  const direct = aviasalesSearchUrl(from, to, departDate, returnDate, adults);
  const marker = Number(Deno.env.get("TRAVELPAYOUTS_MARKER"));
  const trs = Number(Deno.env.get("TRAVELPAYOUTS_TRS"));
  if (!token || !marker || !trs) {
    return { url: direct, tracked: false, reason: "Add the TRAVELPAYOUTS_MARKER and TRAVELPAYOUTS_TRS Edge Function Secrets to earn from bookings" };
  }

  const hit = partnerLinkCache.get(direct);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { url: hit.url, tracked: true };
  try {
    const response = await fetch(LINKS_API_URL, {
      method: "POST",
      headers: { "X-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ trs, marker, shorten: false, links: [{ url: direct, sub_id: BOOKING_SUB_ID }] }),
    });
    const json = await response.json().catch(() => null);
    const link = json?.result?.links?.[0];
    if (response.ok && link?.code === "success" && link.partner_url) {
      partnerLinkCache.set(direct, { at: Date.now(), url: link.partner_url });
      return { url: link.partner_url as string, tracked: true };
    }
    // e.g. "trs is not subscribed for brand", "incorrect marker in the request", HTTP 401 (token)
    return { url: direct, tracked: false, reason: String(link?.message ?? json?.error ?? `HTTP ${response.status}`) };
  } catch (error) {
    return { url: direct, tracked: false, reason: String(error).slice(0, 120) };
  }
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

    // A booking link for one traveller (the page's "Book on Aviasales" button).
    if (url.searchParams.get("book") === "1") {
      const answer = await bookingLink(url.searchParams, Deno.env.get("TRAVELPAYOUTS_TOKEN"));
      return new Response(JSON.stringify(answer), { status: "error" in answer ? 400 : 200, headers: jsonHeaders });
    }

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
    // Optional: the destination, when it's already chosen (`destination=LIS`).
    const destination = (url.searchParams.get("destination") ?? "").trim().toUpperCase();
    if (destination && !/^[A-Z]{3}$/.test(destination)) return fail("destination must be a 3-letter airport or city code");
    if (destination && codes.includes(destination)) return fail("The destination is also one of the departures — pick another destination, or remove that departure.");
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
      searchOptions = { mode: "specific", departDate, dayApart: baseNights >= DAY_APART_FROM_NIGHTS };
    } else {
      baseNights = Number(url.searchParams.get("nights") ?? "7");
      if (!Number.isInteger(baseNights) || baseNights < 1 || baseNights > 30) return fail("nights must be a whole number between 1 and 30");
      searchOptions = { mode: "flexible", weekendOnly: url.searchParams.get("weekendOnly") === "true" };
    }

    const callStats: CallStats = { cap: MAX_CALLS_PER_SEARCH, calls: 0, cached: 0, failed: 0, retried: 0, skipped: 0, statuses: {}, firstError: null, rateLimited: false, budgetExhausted: false, quotaLeft: {}, reserve: destination ? QUOTA_RESERVE_TRIP : QUOTA_RESERVE };
    // A fresh report on the database for this search.
    Object.assign(dbInfo, { status: "not used yet", loaded: 0, saved: 0, loadFailures: 0, lastProblem: null });
    dbLookedUp.clear();

    // The destination is already chosen: compare dates (the next weekends /
    // weeks, or the days around the given dates), cheapest first.
    if (destination) {
      const tripParam = url.searchParams.get("trip") ?? "";
      const type = TRIP_TYPES[tripParam];
      const nights = searchOptions.mode === "specific" ? baseNights : type?.nights ?? baseNights;
      const baseDates = searchOptions.mode === "specific" ? [searchOptions.departDate] : tripBaseDates(type?.weekday ?? 5, TRIP_WEEKS);
      const rate = await usdRate(wantedCurrency);
      const trip = await searchTrip({
        destination, codes, counts, baseDates, nights, maxGapHours, token, stats: callStats,
        toWanted: (usd) => Math.round(usd * (rate ?? 1)),
      });
      await flushToDatabase();
      return new Response(
        JSON.stringify({
          mode: "trip",
          tripType: searchOptions.mode === "specific" ? "dates" : type ? tripParam : "nights",
          nights, // of the base trip; the variations are a night shorter or longer
          destination: trip.destination,
          windows: trip.windows, // one per weekend / week: { departDate, returnDate, options (cheapest first) }
          currency: rate === null ? BASE_CURRENCY : wantedCurrency,
          origins: trip.originPlaces.map((p, i) => placeOut(p, codes[i], counts[i])),
          debug: {
            travelerCount: N,
            people: counts.reduce((a, b) => a + b, 0),
            maxGapHours,
            ...trip.counters, // priced / rejectedByGap / missing options
            stayLengths: trip.lengths,
            months: trip.months,
            faresFound: trip.faresFound,
            travelpayouts: callStats,
            rateLimited: callStats.rateLimited,
            currencyRequested: wantedCurrency,
            currencyConverted: rate !== null,
            database: dbInfo,
            elapsedMs: Date.now() - startedAt,
          },
        }),
        { headers: jsonHeaders }
      );
    }

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

    // Every destination everyone can reach is checked, cheapest first: what we
    // already remember costs nothing, and new calls stop at the budget.
    const toCheck = shared.slice(0, MAX_DESTINATIONS);
    // Longer stays: travellers may arrive or leave a day apart (that needs the
    // nights either side too), and only the arrivals are timed.
    const dayApart = baseNights >= DAY_APART_FROM_NIGHTS;
    const nightsAround = [baseNights - 1, baseNights, baseNights + 1].filter((n) => n >= 1 && n <= 30);

    const lengthsNeeded = dayApart ? [baseNights, ...nightsAround.filter((n) => n !== baseNights)] : [baseNights];

    // Names / coordinates / time zones for every departure and every destination we may check.
    const places = await resolvePlaces([...codes, ...toCheck]);
    const originPlaces = codes.map((c) => places[c]);

    // Broad answers first: everything from each departure city, month by month
    // — a handful of requests that cover every destination at once.
    const broad: BroadIndex = new Map();
    const broadPairs = broadLookups(searchOptions);
    await loadFromDatabase(codes.flatMap((o) => broadPairs.map(([m, r]) => broadKey(o, m, r))));
    const broadAnswers = await Promise.all(codes.map((o) => Promise.all(broadPairs.map(([m, r]) => fetchBroadFares(o, m, r, token!, callStats)))));
    codes.forEach((o, i) => indexBroad(o, broadAnswers[i], broad));
    const broadTrips = broadAnswers.flat().reduce((sum, fares) => sum + Object.keys(fares).length, 0);

    // Accumulators for the debug block.
    const totals = { sameDayPairs: 0, rejectedByGap: 0, withoutTimes: 0 };
    const addStats = (s: typeof totals) => {
      totals.sameDayPairs += s.sameDayPairs;
      totals.rejectedByGap += s.rejectedByGap;
      totals.withoutTimes += s.withoutTimes;
    };
    const withData = codes.map(() => new Set<string>());
    const samples: unknown[] = [];
    const checked = new Set<string>();
    const best = new Map<string, TripResult>();
    const stages: Array<{ stage: string; destinations: number; stayLengths: number[]; matchesAfter: number }> = [];

    // The day-by-day calendar keys for these destinations x stay lengths:
    // the first length for every destination (cheapest first), then the next...
    const calendarJobs = (destinations: string[], lengths: number[]) =>
      lengths.flatMap((n) => destinations.flatMap((d) => codes.flatMap((o) => lookupsFor(searchOptions).map((p) => ({ o, d, p, n })))));

    // Fetch (or load from the database) those calendars. New calls are paced
    // and stop at the budget; the next search continues where this one stopped.
    async function fetchCalendars(destinations: string[], lengths: number[]) {
      const jobs = calendarJobs(destinations, lengths);
      await loadFromDatabase(jobs.map((j) => cacheKey(j.o, j.d, j.p, j.n)));
      await Promise.all(jobs.map((j) => fetchCalendarFares(j.o, j.d, j.p, j.n, token!, callStats)));
    }

    // The best trip to one destination, from what we know (never makes a call).
    // `lengths`: short stays may also try the whole group a night shorter/longer.
    function evaluate(destination: string, lengths: number[]): TripResult | null {
      checked.add(destination);
      const dest = places[destination];
      codes.forEach((o, i) => {
        if (Object.keys(rememberedFares(o, destination, baseNights, searchOptions, broad)).length > 0) withData[i].add(destination);
      });
      const about = {
        destination,
        destinationName: dest?.name ?? destination,
        country: dest?.country ?? "",
        lat: dest?.lat ?? null,
        lon: dest?.lon ?? null,
      };

      if (dayApart) {
        const calendars = codes.map((o) => Object.fromEntries(nightsAround.map((n) => [n, rememberedFares(o, destination, n, searchOptions, broad)])));
        const onlyDay = searchOptions.mode === "specific" ? searchOptions.departDate : null;
        const { best: pick, stats } = bestDayApartPairing(calendars, originPlaces, dest, counts, baseNights, maxGapHours, onlyDay);
        addStats(stats);
        if (!pick) return null;
        const dates = pick.picks.map((p) => ({
          departDate: addDays(pick.date, p.choice.depart),
          returnDate: addDays(pick.date, p.choice.depart + baseNights + p.choice.length),
          apart: p.choice.apart,
        }));
        const legs = legsFor(pick.picks.map((p) => p.fare), pick.described, codes, counts, toWanted, dates);
        return {
          ...about,
          total: legs.reduce((s, l) => s + l.subtotal, 0),
          departDate: pick.date,
          returnDate: addDays(pick.date, baseNights),
          nights: baseNights,
          travelers: legs,
          arrivalGapHours: pick.arrivalGapH,
          returnGapHours: pick.returnGapH,
          daysApart: dates.some((d) => d.apart !== null),
        };
      }

      // Short stays: everyone on the same days, arrivals and returns timed.
      let found: TripResult | null = null;
      for (const n of lengths) {
        const faresList = codes.map((o) => rememberedFares(o, destination, n, searchOptions, broad));
        if (debugOn && samples.length < 8) {
          faresList.forEach((fares, i) => {
            for (const [date, f] of Object.entries(fares).slice(0, 2)) samples.push({ who: codes[i], destination, date, length: n, ...f });
          });
        }
        const { best: pick, stats } = bestGroupPairing(faresList, originPlaces, dest, counts, maxGapHours);
        addStats(stats);
        if (!pick) continue;
        const dates = codes.map(() => ({ departDate: pick.date, returnDate: addDays(pick.date, n), apart: null as Apart }));
        const legs = legsFor(pick.fares, pick.described, codes, counts, toWanted, dates);
        const total = legs.reduce((s, l) => s + l.subtotal, 0);
        if (found && found.total <= total) continue;
        found = {
          ...about,
          total,
          departDate: pick.date,
          returnDate: addDays(pick.date, n),
          nights: n,
          travelers: legs,
          arrivalGapHours: pick.arrivalGapH,
          returnGapHours: pick.returnGapH,
          daysApart: false,
        };
      }
      return found;
    }

    // Keep the cheapest trip per destination.
    function keepBest(destinations: string[], lengths: number[]) {
      for (const d of destinations) {
        const result = evaluate(d, lengths);
        const current = best.get(d);
        if (result && (!current || result.total < current.total)) best.set(d, result);
      }
    }
    const canContinue = () => Date.now() - startedAt < TIME_BUDGET_MS && !callStats.rateLimited && !callStats.budgetExhausted;

    // Stage 1: every destination, from the broad answers and the day-by-day
    // calendars we remember (loaded from the database) — no new calls.
    await loadFromDatabase(calendarJobs(toCheck, lengthsNeeded).map((j) => cacheKey(j.o, j.d, j.p, j.n)));
    keepBest(toCheck, [baseNights]);
    stages.push({ stage: "every destination", destinations: toCheck.length, stayLengths: lengthsNeeded, matchesAfter: best.size });

    // Stage 2: day-by-day calendars for the cheapest places we don't know in
    // detail yet (they have dates the broad answers miss), while the budget lasts.
    if (canContinue()) {
      const detail = toCheck.filter((d) => !calendarsRemembered(codes, d, lengthsNeeded, searchOptions));
      await fetchCalendars(detail, lengthsNeeded);
      keepBest(detail, [baseNights]);
      stages.push({ stage: "day-by-day details", destinations: detail.length, stayLengths: lengthsNeeded, matchesAfter: best.size });
    }

    if (!dayApart && mode === "flexible" && flexNights > 0 && best.size < MIN_RESULTS && canContinue()) {
      // Stage 2 (short stays, few matches): the whole group a night shorter / longer.
      const lengths: number[] = [];
      for (let k = 1; k <= flexNights; k++) lengths.push(baseNights - k, baseNights + k);
      const usable = lengths.filter((n) => n >= 1 && n <= 30);
      const retry = toCheck.filter((d) => !best.has(d)).slice(0, SHORT_RETRY_DESTINATIONS);
      await fetchCalendars(retry, usable);
      keepBest(retry, usable);
      stages.push({ stage: "stay length ± nights", destinations: retry.length, stayLengths: usable, matchesAfter: best.size });
    }

    await flushToDatabase(); // remember what we learned for next time

    const results = [...best.values()].sort((x, y) => x.total - y.total).slice(0, MAX_RESULTS);

    return new Response(
      JSON.stringify({
        results,
        currency, // the currency the prices above are in (USD if we couldn't convert)
        origins: originPlaces.map((p, i) => placeOut(p, codes[i], counts[i])),
        debug: {
          travelerCount: N,
          people: counts.reduce((a, b) => a + b, 0),
          originReports: reports.map((r, i) => ({ code: codes[i], ok: r.success, error: r.rawError, destinations: Object.keys(r.prices).length, destinationsWithFares: withData[i].size })),
          sharedDestinations: shared.length,
          candidatesConsidered: checked.size,
          candidatesWithDateMatch: best.size, // places with a trip (the page gets the MAX_RESULTS cheapest)
          maxGapHours,
          returnsTimed: !dayApart,          // short stays: return flights are timed too
          dayApart,                         // longer stays: someone may arrive / leave a day apart
          resultsWithDayApart: results.filter((r) => r.daysApart).length,
          broadRequests: codes.length * broadPairs.length, // "everything from this city, this month" answers used
          broadTrips,                                      // round trips they contained
          maxStops: MAX_STOPS,
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
