// ---------------------------------------------------------
// Flight Plan — v1 search logic
//
// This now calls a real flight data source instead of made-up numbers.
// Because Travelpayouts' own API rules don't allow calling them directly
// from browser JavaScript (it would expose your secret token to anyone
// who opens dev tools), the actual request goes to a small Supabase
// Edge Function we deploy ourselves — see supabase/functions/search-flights.
// That function holds the token safely on the server and calls
// Travelpayouts on our behalf. This file never sees the token at all.
// ---------------------------------------------------------

const SEARCH_FUNCTION_URL = "https://xlmxbyrcgftxmfzlglkr.supabase.co/functions/v1/search-flights";

// ⬇️ PASTE YOUR ANON KEY HERE (one-time step)
// Supabase blocks calls to your function unless they carry this key.
// Find it in your Supabase dashboard: Project Settings → API Keys →
// the key labelled "anon" / "public" / "publishable". It starts with
// "eyJ..." or "sb_publishable_...".
//
// This key is DESIGNED to live in frontend code — it's public by nature
// and safe to commit to GitHub. The one you must NEVER put here (or send
// to anyone, including me) is the "service_role" / "secret" key, which
// bypasses all security rules.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhsbXhieXJjZ2Z0eG1memxnbGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTIxNjUsImV4cCI6MjEwNTQ4ODE2NX0.--mD9VzcBZfB6ncOu35_rr3h1ZdrNzeI83KymRbPrFE";

// Real airport lookup (typing a city name and finding its IATA code) is
// its own small feature we haven't built yet. For now, a short list of
// codes covers testing. Add more cities here as you test with them —
// find codes at https://www.iata.org/en/publications/directories/code-search/
const originCodes = {
  stockholm: "ARN",
  berlin: "BER",
  lisbon: "LIS",
  london: "LON",
  paris: "PAR",
};

function matchOrigin(inputText) {
  const text = inputText.toLowerCase();
  for (const city in originCodes) {
    if (text.includes(city)) return originCodes[city];
  }
  return null;
}

// Calls our Supabase Edge Function, which calls Travelpayouts server-side
// and returns the combined, ranked list of shared destinations.
function searchFlights(originAInput, originBInput) {
  const originA = matchOrigin(originAInput);
  const originB = matchOrigin(originBInput);

  if (!originA || !originB) {
    return Promise.reject(
      new Error(
        `Try one of: ${Object.keys(originCodes).join(", ")} — a real airport search comes later.`
      )
    );
  }

  const params = new URLSearchParams({ originA, originB });

  return fetch(`${SEARCH_FUNCTION_URL}?${params}`, {
    // Supabase requires these on every call to an Edge Function.
    headers: {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
  })
    .then(async (response) => {
      // Read the body once, tolerating a non-JSON response (e.g. plain text).
      const text = await response.text();
      let json = {};
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Unexpected response from the server: ${text.slice(0, 200)}`);
      }

      // A rejected request can label its reason `message`, `msg`, or `error`
      // depending on which layer refused it — check all three, so a real
      // failure never quietly looks like "no results found".
      if (!response.ok) {
        const reason = json.message || json.msg || json.error || `HTTP ${response.status}`;
        throw new Error(`Request rejected: ${reason}`);
      }
      if (json.error) throw new Error(json.error);
      if (!Array.isArray(json.results)) {
        throw new Error("The server replied, but without a results list — the function may not be deployed correctly.");
      }

      // Keep the debug info around so we can explain an empty result
      // instead of just saying "found nothing" with no reason why.
      return { results: json.results, debug: json.debug };
    });
}

// Turns the debug block from the function into a plain-English reason,
// for when there are zero shared destinations and we want to know why.
function explainEmptyResult(debug) {
  if (!debug) return "No shared destinations found.";
  if (!debug.originAOk || !debug.originBOk) {
    const brokenOne = !debug.originAOk ? debug.originA : debug.originB;
    const reason = !debug.originAOk ? debug.originAError : debug.originBError;
    return `Travelpayouts rejected the request for ${brokenOne}${reason ? ` (${reason})` : ""} — likely the token isn't set correctly in Edge Function Secrets.`;
  }
  return `No overlap: ${debug.originA} found ${debug.originADestinationsFound} destinations, ${debug.originB} found ${debug.originBDestinationsFound}. Try two origins with more cached search volume, like ARN and LON.`;
}

// Renders one destination result as a card in the page.
function renderResult(result) {
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div>
      <div class="destination">${result.destination}</div>
      <div class="breakdown">You: $${result.priceA} · Them: $${result.priceB}</div>
    </div>
    <div class="total">$${result.total}</div>
  `;
  return card;
}

// Wire up the form.
const form = document.getElementById("search-form");
const resultsSection = document.getElementById("results");

form.addEventListener("submit", (event) => {
  // Stop the browser from doing a full page reload on submit —
  // we want to handle this with JavaScript instead.
  event.preventDefault();

  const originA = document.getElementById("origin-a").value;
  const originB = document.getElementById("origin-b").value;

  resultsSection.innerHTML = "<p>Searching…</p>";

  searchFlights(originA, originB)
    .then(({ results, debug }) => {
      resultsSection.innerHTML = "";
      if (!results || results.length === 0) {
        resultsSection.innerHTML = `<p>${explainEmptyResult(debug)}</p>`;
        return;
      }
      results.forEach((result) => {
        resultsSection.appendChild(renderResult(result));
      });
    })
    .catch((error) => {
      resultsSection.innerHTML = `<p style="color:#a8431f">${error.message}</p>`;
    });
});
