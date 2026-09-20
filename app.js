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

// Real airport/city search, powered by Travelpayouts' public autocomplete
// endpoint. It's a plain data lookup (no pricing, no token) so it's safe
// to call straight from the browser — no Edge Function needed for this part.
const AUTOCOMPLETE_URL = "https://autocomplete.travelpayouts.com/places2";

function fetchAirportSuggestions(term) {
  const params = new URLSearchParams({ locale: "en", term });
  params.append("types[]", "city");
  params.append("types[]", "airport");

  return fetch(`${AUTOCOMPLETE_URL}?${params}`)
    .then((response) => response.json())
    .then((items) =>
      items
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
    );
}

function describeSuggestion(item) {
  if (item.type === "airport") {
    return `${item.name}, ${item.city_name ?? ""} · ${item.country_name}`.replace(", ·", " ·");
  }
  return `${item.name} (city — all airports) · ${item.country_name}`;
}

// Wires one text input up to a dropdown of live suggestions. Selecting a
// suggestion stores its IATA code on the input itself (dataset.code), so
// the search always uses an exact code instead of guessing from free text.
function setupAutocomplete(input, list) {
  let items = [];
  let activeIndex = -1;
  let requestId = 0;

  function close() {
    list.innerHTML = "";
    items = [];
    activeIndex = -1;
  }

  function render() {
    list.innerHTML = "";
    items.forEach((item, index) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.innerHTML = `<span class="code">${item.code}</span> — <span class="detail">${describeSuggestion(item)}</span>`;
      if (index === activeIndex) li.classList.add("active");
      li.addEventListener("mousedown", (event) => {
        // mousedown (not click) fires before the input's blur, so the
        // selection registers before the dropdown gets closed by blur.
        event.preventDefault();
        select(item);
      });
      list.appendChild(li);
    });
  }

  function select(item) {
    input.value = `${item.name} (${item.code})`;
    input.dataset.code = item.code;
    close();
  }

  const debouncedSearch = debounce((term) => {
    const thisRequest = ++requestId;
    fetchAirportSuggestions(term).then((results) => {
      if (thisRequest !== requestId) return; // a newer keystroke already superseded this
      items = results;
      activeIndex = -1;
      render();
    });
  }, 200);

  input.addEventListener("input", () => {
    delete input.dataset.code; // typing invalidates any previous selection
    const term = input.value.trim();
    if (term.length < 2) {
      close();
      return;
    }
    debouncedSearch(term);
  });

  input.addEventListener("keydown", (event) => {
    if (items.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      render();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      render();
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      select(items[activeIndex]);
    } else if (event.key === "Escape") {
      close();
    }
  });

  input.addEventListener("blur", () => {
    // Slight delay so a mousedown-driven select() above can still run first.
    setTimeout(close, 100);
  });
}

function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// Calls our Supabase Edge Function, which calls Travelpayouts server-side
// and returns the combined, ranked list of shared destinations.
function searchFlights(originA, originB) {
  if (!originA || !originB) {
    return Promise.reject(
      new Error("Pick an airport or city from the dropdown for both fields.")
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
const originAInput = document.getElementById("origin-a");
const originBInput = document.getElementById("origin-b");

setupAutocomplete(originAInput, document.getElementById("origin-a-suggestions"));
setupAutocomplete(originBInput, document.getElementById("origin-b-suggestions"));

form.addEventListener("submit", (event) => {
  // Stop the browser from doing a full page reload on submit —
  // we want to handle this with JavaScript instead.
  event.preventDefault();

  const originA = originAInput.dataset.code;
  const originB = originBInput.dataset.code;

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
