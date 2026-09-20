// Flight Plan — search-flights Edge Function
//
// Why this exists: Travelpayouts' own rules say their API token can't be
// used from browser JavaScript (the request would expose the token to
// anyone who opens dev tools). This function runs on Supabase's servers
// instead, holds the token as a secret, and the browser talks to THIS
// function rather than to Travelpayouts directly.
//
// What it does: takes two origin airport codes, asks Travelpayouts for
// the cheapest destination prices from EACH of them, and returns only
// the destinations both origins can reach — ranked cheapest total first.
//
// This version also returns a small `debug` block alongside the results,
// so when something looks wrong we can see WHERE it went wrong (bad
// token? one origin has no cached data? something else?) instead of
// just getting an empty list with no explanation.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // fine while testing; can be narrowed to your real domain later
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

async function fetchPricesFrom(origin: string, currency: string, departDate: string, token: string) {
  const params = new URLSearchParams({
    origin,
    destination: "-", // "-" = all destinations from this origin, per Travelpayouts docs
    currency,
    token,
  });
  if (departDate) params.set("depart_date", departDate);

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
    const departDate = url.searchParams.get("departDate") ?? "";

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

    const [a, b] = await Promise.all([
      fetchPricesFrom(originA, currency, departDate, token),
      fetchPricesFrom(originB, currency, departDate, token),
    ]);

    const results = Object.keys(a.prices)
      .filter((destination) => destination in b.prices)
      .map((destination) => {
        const priceA = a.prices[destination];
        const priceB = b.prices[destination];
        return {
          destination,
          priceA,
          priceB,
          total: priceA + priceB,
          gap: Math.abs(priceA - priceB),
        };
      })
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
        },
      }),
      { headers: jsonHeaders }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers: jsonHeaders });
  }
});
