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
//      destination (no dates yet) and intersects the two lists — same as
//      before — to find candidate shared destinations, then keeps the
//      cheapest handful of those as candidates worth a closer look.
//   2. For each candidate, calls Travelpayouts' day-by-day calendar
//      endpoint for both origins with the traveler's requested stay
//      length (or exact dates), and looks for a departure day BOTH
//      origins have a cached fare for — so the two travelers are actually
//      at the destination together, not just each cheap on their own.
//
// This also still returns a `debug` block, extended with how many
// candidates were considered and how many survived phase 2, so an empty
// result can be explained (no shared destinations at all vs. shared
// destinations but no cached fare on matching dates).

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // fine while testing; can be narrowed to your real domain later
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// How many of the cheapest shared destinations get a deeper, date-aware
// look in phase 2. Keeps the number of Travelpayouts calls bounded.
const MAX_CANDIDATES = 6;

// How many months ahead (including the current month) a "flexible dates"
// search scans for the cheapest matching day. Larger = more thorough but
// more Travelpayouts calls.
const FLEXIBLE_SEARCH_MONTHS = 2;

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

// Phase 1: cheapest cached fare from `origin` to every destination, no
// date filtering — used only to discover which destinations are worth a
// closer, date-aware look in phase 2.
async function fetchCheapestByDestination(origin: string, currency: string, token: string) {
  const params = new URLSearchParams({ origin, destination: "-", currency, token });
  const response = await fetch(`https://api.travelpayouts.com/v1/prices/cheap?${params}`);
  const json = await response.json();

  return {
    prices: extractPrices(json.data ?? {}),
    // Travelpayouts includes a `success` flag and sometimes an `error` —
    // if success is false, the token or request was rejected, and any
    // "0 destinations found" result below is actually THIS, not a real
    // lack of overlap between the two airports.
    success: json.success !== false,
    rawError: json.error ?? null,
  };
}

// Phase 2: day-by-day cached fares for one origin/destination pair, all
// with the same fixed stay length — this is what lets us show real dates
// and a real night count instead of an arbitrary cached fare.
// `departDateParam` is either an exact "YYYY-MM-DD" (specific-dates mode)
// or a "YYYY-MM" month (flexible mode, one call per scanned month).
async function fetchCalendarPrices(
  origin: string,
  destination: string,
  currency: string,
  departDateParam: string,
  lengthOfStay: number,
  token: string
): Promise<Record<string, number>> {
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

    const prices: Record<string, number> = {};
    for (const [date, entry] of Object.entries(json.data as Record<string, { price: number }>)) {
      if (entry && typeof entry.price === "number") prices[date] = entry.price;
    }
    return prices;
  } catch {
    // A single failed calendar call shouldn't take down the whole search —
    // this destination just won't have a date match for this origin.
    return {};
  }
}

function isFridayOrSaturday(dateStr: string): boolean {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return day === 5 || day === 6;
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// "YYYY-MM" for the current month and the next `count - 1` months —
// the window a flexible-dates search scans for the cheapest matching day.
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

// All cached departure-day prices for one origin/destination pair, given
// the search mode — a single exact-date lookup, or one lookup per scanned
// month, merged together (and narrowed to Fri/Sat departures for weekend
// trips).
async function datesForOriginDestination(
  origin: string,
  destination: string,
  currency: string,
  token: string,
  options: SearchOptions
): Promise<Record<string, number>> {
  let prices: Record<string, number>;

  if (options.mode === "specific") {
    prices = await fetchCalendarPrices(origin, destination, currency, options.departDate, options.nights, token);
  } else {
    const perMonth = await Promise.all(
      upcomingMonths(FLEXIBLE_SEARCH_MONTHS).map((month) =>
        fetchCalendarPrices(origin, destination, currency, month, options.nights, token)
      )
    );
    prices = Object.assign({}, ...perMonth);
    if (options.weekendOnly) {
      prices = Object.fromEntries(Object.entries(prices).filter(([date]) => isFridayOrSaturday(date)));
    }
  }

  return prices;
}

// The cheapest departure day both origins have a cached fare for — i.e.
// both travelers can actually be at the destination together on that day.
function cheapestSharedDate(pricesA: Record<string, number>, pricesB: Record<string, number>) {
  let best: { date: string; priceA: number; priceB: number } | null = null;
  for (const date in pricesA) {
    if (!(date in pricesB)) continue;
    const priceA = pricesA[date];
    const priceB = pricesB[date];
    if (!best || priceA + priceB < best.priceA + best.priceB) {
      best = { date, priceA, priceB };
    }
  }
  return best;
}

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

    if (!originA || !originB) {
      return new Response(
        JSON.stringify({ error: "originA and originB query parameters are required" }),
        { status: 400, headers: jsonHeaders }
      );
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
        return new Response(
          JSON.stringify({ error: "departDate and returnDate are required when mode=specific" }),
          { status: 400, headers: jsonHeaders }
        );
      }
      const nights = Math.round((Date.parse(returnDate) - Date.parse(departDate)) / 86_400_000);
      if (!Number.isFinite(nights) || nights < 1) {
        return new Response(
          JSON.stringify({ error: "returnDate must be at least one day after departDate" }),
          { status: 400, headers: jsonHeaders }
        );
      }
      searchOptions = { mode: "specific", departDate, nights };
    } else {
      const nights = Number(url.searchParams.get("nights") ?? "7");
      if (!Number.isInteger(nights) || nights < 1 || nights > 30) {
        return new Response(
          JSON.stringify({ error: "nights must be a whole number between 1 and 30" }),
          { status: 400, headers: jsonHeaders }
        );
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

    // Phase 2: date-aware lookup, only for the cheapest candidates.
    const matched = await Promise.all(
      candidates.map(async ({ destination }) => {
        const [datesA, datesB] = await Promise.all([
          datesForOriginDestination(originA, destination, currency, token, searchOptions),
          datesForOriginDestination(originB, destination, currency, token, searchOptions),
        ]);
        const best = cheapestSharedDate(datesA, datesB);
        if (!best) return null;
        return {
          destination,
          priceA: best.priceA,
          priceB: best.priceB,
          total: best.priceA + best.priceB,
          departDate: best.date,
          returnDate: addDays(best.date, searchOptions.nights),
          nights: searchOptions.nights,
        };
      })
    );

    const results = matched
      .filter((result): result is NonNullable<typeof result> => result !== null)
      .sort((x, y) => x.total - y.total);

    return new Response(
      JSON.stringify({
        results,
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
        },
      }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
  }
});
