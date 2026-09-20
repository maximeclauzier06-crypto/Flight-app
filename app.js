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

  return fetch(`${SEARCH_FUNCTION_URL}?${params}`)
    .then((response) => response.json())
    .then((json) => {
      if (json.error) throw new Error(json.error);
      return json.results;
    });
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
    .then((results) => {
      resultsSection.innerHTML = "";
      if (!results || results.length === 0) {
        resultsSection.innerHTML = "<p>No shared destinations found.</p>";
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
