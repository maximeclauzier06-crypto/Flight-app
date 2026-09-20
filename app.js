// ---------------------------------------------------------
// Flight Plan — v1 search logic
//
// Right now this uses EXAMPLE data (see exampleFlightData below)
// instead of calling a real flight API. That's on purpose: it lets
// us get the whole search-and-display flow working and looking
// right before we deal with signing up for an API key and handling
// real network requests. Swapping the example data for a real API
// call later will only mean changing the function `searchFlights`
// — nothing else in this file needs to change.
// ---------------------------------------------------------

// EXAMPLE DATA — stand-ins for what a real flight API would return.
// Each entry is: a destination, and the round-trip price from each
// of two example origins (Stockholm and Berlin), just so the demo
// has something to show. Replace this once real data is wired up.
const exampleFlightData = {
  stockholm: {
    Lisbon: 145,
    Barcelona: 120,
    Rome: 160,
    Copenhagen: 60,
    Vienna: 130,
  },
  berlin: {
    Lisbon: 110,
    Barcelona: 95,
    Rome: 90,
    Copenhagen: 75,
    Vienna: 85,
  },
};

// Very rough "which example city set does this input match" helper.
// A real version of this would look up an actual airport code via
// the flight API instead of guessing from typed text.
function matchOrigin(inputText) {
  const text = inputText.toLowerCase();
  if (text.includes("stockholm") || text.includes("arn")) return "stockholm";
  if (text.includes("berlin") || text.includes("ber")) return "berlin";
  return null;
}

// This is the function that will eventually make a real network
// request to a flight API (Travelpayouts or Duffel). For now it
// just reads from exampleFlightData and returns a Promise, so the
// rest of the code already works the way it will once this is real.
function searchFlights(originAInput, originBInput) {
  return new Promise((resolve, reject) => {
    const originA = matchOrigin(originAInput);
    const originB = matchOrigin(originBInput);

    if (!originA || !originB) {
      reject(
        new Error(
          "For this demo, try 'Stockholm' and 'Berlin' as the two airports — real airport lookup comes with the live API."
        )
      );
      return;
    }

    const pricesA = exampleFlightData[originA];
    const pricesB = exampleFlightData[originB];

    // Build a combined list: for every destination both origins fly to,
    // work out each partner's price and the total.
    const combined = Object.keys(pricesA)
      .filter((destination) => destination in pricesB)
      .map((destination) => {
        const priceA = pricesA[destination];
        const priceB = pricesB[destination];
        return {
          destination,
          priceA,
          priceB,
          total: priceA + priceB,
          // "fairness" gap: how far apart the two prices are.
          // Smaller is more balanced between the two of you.
          gap: Math.abs(priceA - priceB),
        };
      })
      // Sort cheapest total first — this is the ranking decision
      // called out in the roadmap. Switching to "fairest split"
      // instead would mean sorting by `gap` here rather than `total`.
      .sort((a, b) => a.total - b.total);

    resolve(combined);
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
      if (results.length === 0) {
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
