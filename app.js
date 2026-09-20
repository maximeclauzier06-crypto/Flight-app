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
// and returns the combined, ranked list of shared destinations, each with
// a real matching departure date, return date, and night count.
function searchFlights(originA, originB, dateParams) {
  if (!originA || !originB) {
    return Promise.reject(
      new Error("Pick an airport or city from the dropdown for both fields.")
    );
  }

  const params = new URLSearchParams({ originA, originB, ...dateParams });

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
      if (json.results.length > 0 && json.results[0].departDate === undefined) {
        throw new Error(
          "The deployed search-flights function is running older code with no date info — redeploy supabase/functions/search-flights/index.ts to your Supabase dashboard."
        );
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
  if (!debug.candidatesConsidered) {
    return `No overlap: ${debug.originA} found ${debug.originADestinationsFound} destinations, ${debug.originB} found ${debug.originBDestinationsFound}. Try two origins with more cached search volume, like ARN and LON.`;
  }
  return `Found ${debug.candidatesConsidered} destination${debug.candidatesConsidered === 1 ? "" : "s"} you can both reach, but no cached fare matches your dates. Try "Flexible — lowest price", or different dates.`;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

// Formats a "YYYY-MM-DD" string without letting the browser's local
// timezone shift it to the wrong day (these are date-only, not instants).
function formatDate(dateStr) {
  return DATE_FORMAT.format(new Date(`${dateStr}T00:00:00Z`));
}

// Formats a price in whichever currency the search was run in — using
// Intl instead of a hardcoded "$" so the symbol/format is actually right
// for the selected currency (e.g. "€88" vs "$88" vs "₹88").
function formatPrice(amount, currencyCode) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currencyCode.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(amount);
}

// Renders one destination result as a card in the page.
function renderResult(result, currencyCode) {
  const card = document.createElement("div");
  card.className = "result-card";
  card.innerHTML = `
    <div>
      <div class="destination">${result.destination}</div>
      <div class="dates">${formatDate(result.departDate)} → ${formatDate(result.returnDate)} · ${result.nights} night${result.nights === 1 ? "" : "s"}</div>
      <div class="breakdown">You: ${formatPrice(result.priceA, currencyCode)} · Them: ${formatPrice(result.priceB, currencyCode)}</div>
    </div>
    <div class="total">${formatPrice(result.total, currencyCode)}</div>
  `;
  return card;
}

// Wire up the form.
const form = document.getElementById("search-form");
const resultsSection = document.getElementById("results");
const originAInput = document.getElementById("origin-a");
const originBInput = document.getElementById("origin-b");
const flexibleFields = document.getElementById("flexible-fields");
const specificFields = document.getElementById("specific-fields");
const customNightsField = document.getElementById("custom-nights-field");
const durationSelect = document.getElementById("duration");
const departDateInput = document.getElementById("depart-date");
const returnDateInput = document.getElementById("return-date");
const currencySelect = document.getElementById("currency");

setupAutocomplete(originAInput, document.getElementById("origin-a-suggestions"));
setupAutocomplete(originBInput, document.getElementById("origin-b-suggestions"));

// Guesses a sensible default currency from the browser's locale (e.g.
// "sv-SE" → SEK, "en-GB" → GBP) — just a starting point, the dropdown
// above it is always there to override.
const REGION_CURRENCY = {
  US: "usd", GB: "gbp", IE: "eur", DE: "eur", FR: "eur", ES: "eur", IT: "eur",
  NL: "eur", PT: "eur", AT: "eur", BE: "eur", FI: "eur", GR: "eur", LU: "eur",
  SI: "eur", SK: "eur", EE: "eur", LV: "eur", LT: "eur", CY: "eur", MT: "eur",
  SE: "sek", NO: "nok", DK: "dkk", CH: "chf", PL: "pln",
  CA: "cad", AU: "aud", NZ: "nzd", JP: "jpy", RU: "rub", TR: "try",
  IN: "inr", BR: "brl", MX: "mxn",
};

function detectDefaultCurrency() {
  const locales = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const locale of locales) {
    const region = locale.split("-")[1];
    if (region && REGION_CURRENCY[region.toUpperCase()]) return REGION_CURRENCY[region.toUpperCase()];
  }
  return "usd";
}

currencySelect.value = detectDefaultCurrency();

// Depart/return dates can't be in the past.
const today = new Date().toISOString().slice(0, 10);
departDateInput.min = today;
returnDateInput.min = today;

function updateVisibleFields() {
  const isSpecific = document.getElementById("mode-specific").checked;
  specificFields.hidden = !isSpecific;
  flexibleFields.hidden = isSpecific;
  customNightsField.hidden = isSpecific || durationSelect.value !== "custom";
}

document.querySelectorAll('input[name="date-mode"]').forEach((radio) => {
  radio.addEventListener("change", updateVisibleFields);
});
durationSelect.addEventListener("change", updateVisibleFields);

// Keep the return-date picker from allowing a date before the chosen depart date.
departDateInput.addEventListener("change", () => {
  returnDateInput.min = departDateInput.value || today;
});

// Reads the form's date controls into the query params searchFlights needs.
function collectDateParams() {
  if (document.getElementById("mode-specific").checked) {
    if (!departDateInput.value || !returnDateInput.value) {
      throw new Error("Pick both a depart and a return date, or switch to flexible dates.");
    }
    if (returnDateInput.value <= departDateInput.value) {
      throw new Error("The return date needs to be after the depart date.");
    }
    return { mode: "specific", departDate: departDateInput.value, returnDate: returnDateInput.value };
  }

  if (durationSelect.value === "weekend") return { mode: "flexible", nights: "2", weekendOnly: "true" };
  if (durationSelect.value === "week") return { mode: "flexible", nights: "7" };

  const nights = Number(document.getElementById("custom-nights").value);
  if (!Number.isInteger(nights) || nights < 1) {
    throw new Error("Enter a whole number of nights (1 or more).");
  }
  return { mode: "flexible", nights: String(nights) };
}

form.addEventListener("submit", (event) => {
  // Stop the browser from doing a full page reload on submit —
  // we want to handle this with JavaScript instead.
  event.preventDefault();

  const originA = originAInput.dataset.code;
  const originB = originBInput.dataset.code;

  let dateParams;
  try {
    dateParams = collectDateParams();
  } catch (error) {
    resultsSection.innerHTML = `<p style="color:#a8431f">${error.message}</p>`;
    return;
  }

  const currencyCode = currencySelect.value;
  resultsSection.innerHTML = "<p>Searching…</p>";

  searchFlights(originA, originB, { ...dateParams, currency: currencyCode })
    .then(({ results, debug }) => {
      resultsSection.innerHTML = "";
      if (!results || results.length === 0) {
        resultsSection.innerHTML = `<p>${explainEmptyResult(debug)}</p>`;
        return;
      }
      results.forEach((result) => {
        resultsSection.appendChild(renderResult(result, currencyCode));
      });
    })
    .catch((error) => {
      resultsSection.innerHTML = `<p style="color:#a8431f">${error.message}</p>`;
    });
});
