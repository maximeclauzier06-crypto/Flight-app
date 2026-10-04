// ---------------------------------------------------------------------------
// Flight Plan — the page's behaviour
//
// How it fits together:
//   * You pick two or more departures (live autocomplete, with how many people leave
//     from each) and when you want to travel — and, if you already know where
//     to go, a destination ("Going to"; empty = Anywhere).
//   * The page asks our small Supabase Edge Function (supabase/functions/
//     search-flights) for matching destinations (or, with a destination, for
//     the cheapest dates). That function holds the Travelpayouts token safely
//     on the server — this file never sees it.
//   * The results fill the table (or the weekends strip); the globe on the
//     right shows the selected destination (geo.js draws the globe).
//
// Sections:  1 Settings · 2 Small helpers · 3 Airport autocomplete + 3b Departures +
//            3c Going to · 4 Currency · 5 The "When" pop-up · 6 Searching ·
//            7 The results table · 7b One destination · 7c Booking ·
//            7d The trip page (after "Select") · 8 The globe
// ---------------------------------------------------------------------------


// ===========================================================================
// 1. SETTINGS
// ===========================================================================

const SEARCH_FUNCTION_URL = "https://xlmxbyrcgftxmfzlglkr.supabase.co/functions/v1/search-flights";

// Supabase blocks calls to your function unless they carry this key.
// It is DESIGNED to live in frontend code — it's public by nature and safe to
// commit to GitHub. The one you must NEVER put here (or send to anyone) is
// the "service_role" / "secret" key, which bypasses all security rules.
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhsbXhieXJjZ2Z0eG1memxnbGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTIxNjUsImV4cCI6MjEwNTQ4ODE2NX0.--mD9VzcBZfB6ncOu35_rr3h1ZdrNzeI83KymRbPrFE";

// Free, public airport/city lookup from Travelpayouts (no token needed).
const AUTOCOMPLETE_URL = "https://autocomplete.travelpayouts.com/places2";

// Booking links (the "Book on Aviasales" buttons) are made by the search
// function, which turns each Aviasales search into your Travelpayouts partner
// link — your marker and project ID live there, as Edge Function Secrets.
// See section 7c.

const GLOBE_RADIUS = 210; // size of the globe window, in pixels
const GLOBE_MAX_ZOOM = 4;  // how far you can zoom in (1 = the whole Earth)

// What the page remembers between actions.
const state = {
  results: [],       // destinations returned by the last search
  origins: [],       // one { label, lat, lon, count } per departure of the last search
  sort: "cheapest",  // cheapest | fastest | stops
  selected: null,    // destination code of the highlighted row
  maxGapHours: 3,    // the arrival/return time rule used by the last search
  debug: null,       // the function's report on the last search (counts, failures...)
  currency: "usd",   // the currency the prices in `results` are actually in
  lastSearch: null,  // so a currency change or "Try again" can re-run the same search
  globeView: null,   // {lat, lon, zoom} once you turn/zoom the globe; null = it frames everything itself
  trip: null,        // with a destination chosen: the answer (weekends and their options); null otherwise
  tripWindow: 0,     // which weekend (or week) of the strip is selected
  tripOption: 0,     // which of its options is selected (they come cheapest first)
};


// ===========================================================================
// 2. SMALL HELPERS
// ===========================================================================

const $ = (id) => document.getElementById(id);

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

// "2026-10-22" -> "Oct 22" (no time-zone shifting: these are plain dates)
const DAY_FORMAT = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const formatDay = (dateStr) => DAY_FORMAT.format(new Date(`${dateStr}T00:00:00Z`));

function formatPrice(amount, currencyCode) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode.toUpperCase(), maximumFractionDigits: 0 }).format(amount);
}

const hhmm = (iso) => iso.slice(11, 16); // "2026-10-22T21:30" -> "21:30"
const daysBetween = (isoFrom, isoTo) => Math.round((Date.parse(isoTo.slice(0, 10)) - Date.parse(isoFrom.slice(0, 10))) / 86400000);
const durationLabel = (minutes) => `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}`;
const stopsLabel = (n) => (n === 0 ? "Direct" : n === 1 ? "1 stop" : `${n} stops`);
const hoursLabel = (hours) => durationLabel(Math.round(hours * 60));

// "+1" / "-1" marker when a flight lands on a different calendar day
function dayShiftMarker(fromIso, toIso) {
  const shift = daysBetween(fromIso, toIso);
  return shift === 0 ? "" : `<sup>${shift > 0 ? "+" : ""}${shift}</sup>`;
}


// ===========================================================================
// 3. AIRPORT AUTOCOMPLETE
// ===========================================================================

function fetchAirportSuggestions(term) {
  const params = new URLSearchParams({ locale: "en", term });
  params.append("types[]", "city");
  params.append("types[]", "airport");
  return fetch(`${AUTOCOMPLETE_URL}?${params}`)
    .then((response) => response.json())
    .then((items) => items.slice().sort((a, b) => b.weight - a.weight).slice(0, 8));
}

function describeSuggestion(item) {
  if (item.type === "airport") return `${item.name}, ${item.city_name ?? ""} · ${item.country_name}`.replace(", ·", " ·");
  return `${item.name} (city — all airports) · ${item.country_name}`;
}

// Wires one text input to a dropdown of live suggestions. Picking one stores
// its exact code (and position, for the globe) on the input itself.
// `onChange` runs when a place is picked, or when typing cancels the choice.
function setupAutocomplete(input, list, onChange = () => {}) {
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
      li.innerHTML = `<span class="code">${esc(item.code)}</span> — <span class="detail">${esc(describeSuggestion(item))}</span>`;
      if (index === activeIndex) li.classList.add("active");
      // mousedown (not click) so it registers before the input loses focus
      li.addEventListener("mousedown", (event) => {
        event.preventDefault();
        select(item);
      });
      list.appendChild(li);
    });
  }

  function select(item) {
    input.value = `${item.name} (${item.code})`;
    input.dataset.code = item.code;
    input.dataset.label = item.type === "airport" ? item.city_name || item.name : item.name;
    input.dataset.lat = item.coordinates?.lat ?? "";
    input.dataset.lon = item.coordinates?.lon ?? "";
    close();
    onChange();
  }

  const debouncedSearch = debounce((term) => {
    const thisRequest = ++requestId;
    fetchAirportSuggestions(term).then((results) => {
      if (thisRequest !== requestId) return; // a newer keystroke already replaced this
      items = results;
      activeIndex = -1;
      render();
    });
  }, 200);

  input.addEventListener("input", () => {
    for (const key of ["code", "label", "lat", "lon"]) delete input.dataset[key]; // typing cancels the old choice
    onChange();
    const term = input.value.trim();
    if (term.length < 2) return close();
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

  input.addEventListener("blur", () => setTimeout(close, 100));
}

// ===========================================================================
// 3b. THE DEPARTURES (2 to 8 cells in the search bar)
// ===========================================================================

const MAX_ORIGINS = 8;
const originsEl = $("origins");
let originCounter = 0;

const PERSON_ICON =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="3.5" r="2.4" fill="currentColor"></circle><path d="M1.6 11c.4-2.5 2.2-3.7 4.4-3.7s4 1.2 4.4 3.7" fill="currentColor"></path></svg>';

function addOrigin() {
  const id = ++originCounter;
  const cell = document.createElement("div");
  cell.className = "origin-cell";
  cell.dataset.count = "1";
  cell.innerHTML = `
    <div class="origin-head">
      <label for="origin-${id}"></label>
      <button type="button" class="origin-remove" aria-label="Remove this departure" title="Remove this departure">×</button>
    </div>
    <input type="text" id="origin-${id}" placeholder="City or airport" autocomplete="off" required>
    <div class="people" title="How many people leave from here">
      <span class="avatars"></span>
      <span class="people-text"></span>
      <button type="button" class="people-btn" data-delta="-1" aria-label="One person less">−</button>
      <button type="button" class="people-btn" data-delta="1" aria-label="One person more">+</button>
    </div>
    <ul class="suggestions" role="listbox"></ul>`;
  originsEl.appendChild(cell);
  setupAutocomplete(cell.querySelector("input"), cell.querySelector(".suggestions"));
  refreshOrigins();
  return cell;
}

// The little row of people under each airport: one avatar per person (up to 4,
// then "+N"), in that departure's colour, and "1 traveller / 2 travellers".
function renderPeople(cell) {
  const count = Number(cell.dataset.count);
  const shown = Math.min(count, 4);
  let avatars = "";
  for (let k = 0; k < shown; k++) avatars += `<span class="avatar">${PERSON_ICON}</span>`;
  if (count > 4) avatars += `<span class="avatar avatar-more">+${count - 4}</span>`;
  cell.querySelector(".avatars").innerHTML = avatars;
  cell.querySelector(".people-text").textContent = `${count} traveller${count === 1 ? "" : "s"}`;
  cell.querySelector('.people-btn[data-delta="-1"]').disabled = count <= 1;
  cell.querySelector('.people-btn[data-delta="1"]').disabled = count >= 9;
}

// Re-number the labels, colour each departure, hide "×" on the first two,
// lay the cells out in sensible rows, and update the "+ Add" box.
function refreshOrigins() {
  const cells = [...originsEl.querySelectorAll(".origin-cell")];
  const n = cells.length;
  // At most 3 side by side, and only as many as fit (~165px each) so the names stay readable.
  const fit = Math.max(1, Math.floor(originsEl.clientWidth / 165));
  const cols = Math.min(n <= 3 ? n : n === 4 ? 2 : 3, fit);
  originsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  originsEl.classList.toggle("is-dense", originsEl.clientWidth / cols < 220); // narrow cells: a bit tighter
  cells.forEach((cell, i) => {
    cell.querySelector("label").textContent = i === 0 ? "Your airport" : i === 1 ? "Their airport" : `Departure ${i + 1}`;
    cell.querySelector(".origin-remove").hidden = i < 2;
    cell.style.setProperty("--who", `var(--c${i % 8})`); // same colour as in the table and on the globe
    cell.classList.toggle("has-left", i % cols !== 0);
    cell.classList.toggle("has-top", i >= cols);
    renderPeople(cell);
  });
  $("add-departure").hidden = n >= MAX_ORIGINS;
  $("add-departure-note").textContent = `(${n}/${MAX_ORIGINS})`;
}

$("add-departure").addEventListener("click", () => addOrigin().querySelector("input").focus());

// Re-arrange the departures when the window (and so the bar) changes width.
let originsWidth = 0;
new ResizeObserver(([entry]) => {
  if (Math.round(entry.contentRect.width) === originsWidth) return;
  originsWidth = Math.round(entry.contentRect.width);
  refreshOrigins();
}).observe(originsEl);

originsEl.addEventListener("click", (event) => {
  const cell = event.target.closest(".origin-cell");
  if (event.target.closest(".origin-remove")) {
    cell.remove();
    refreshOrigins();
  } else if (event.target.closest(".people-btn")) {
    const delta = Number(event.target.closest(".people-btn").dataset.delta);
    cell.dataset.count = String(Math.min(9, Math.max(1, Number(cell.dataset.count) + delta)));
    renderPeople(cell);
  }
});

// What the visitor typed/picked, one entry per departure.
function readDepartures() {
  return [...originsEl.querySelectorAll(".origin-cell")].map((cell) => {
    const input = cell.querySelector("input[type=text]");
    return {
      code: input.dataset.code,
      label: input.dataset.label || input.value,
      lat: Number(input.dataset.lat) || null,
      lon: Number(input.dataset.lon) || null,
      count: Number(cell.dataset.count) || 1,
    };
  });
}

addOrigin();
addOrigin();


// ===========================================================================
// 3c. GOING TO (empty = Anywhere: find the middle · a city = compare dates)
// ===========================================================================

const goingInput = $("going-input");
const SPARK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C12 7 17 12 24 12C17 12 12 17 12 24C12 17 7 12 0 12C7 12 12 7 12 0Z"></path></svg>';
const PLANE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="transform: rotate(45deg)" aria-hidden="true"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"></path></svg>';

const hasDestination = () => Boolean(goingInput.dataset.code);

// The box, the search button and the hint under the bar follow the choice.
function updateGoing() {
  const chosen = hasDestination();
  $("going-field").classList.toggle("has-destination", chosen);
  $("going-icon").innerHTML = chosen ? PLANE_ICON : SPARK_ICON;
  $("going-sub").textContent = chosen ? "Your trip, together" : "We find the middle";
  $("going-clear").hidden = !goingInput.value;
  $("search-btn-text").textContent = chosen ? "Find dates" : "Find destinations";
  $("bar-hint").textContent = chosen
    ? "We compare the coming weekends for you. Clear “Going to” (×) to find a place in the middle instead."
    : "Travelling as a group? Add everyone's airport. Already know where? Pick it in “Going to”.";
}

setupAutocomplete(goingInput, $("going-suggestions"), () => {
  updateGoing();
  updateWhenFields();
});
$("going-clear").addEventListener("click", () => {
  goingInput.value = "";
  for (const key of ["code", "label", "lat", "lon"]) delete goingInput.dataset[key];
  updateGoing();
  updateWhenFields();
  goingInput.focus();
});
updateGoing();


// ===========================================================================
// 4. CURRENCY
// ===========================================================================

// A starting guess from the browser's language (e.g. "sv-SE" -> SEK). The
// dropdown in the top bar is always there to change it.
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

const currencySelect = $("currency");
currencySelect.value = detectDefaultCurrency();

// Prices come back already converted, so a new currency means asking again.
// (The server remembers its answers, so this is quick and costs no extra
// flight-data calls.)
currencySelect.addEventListener("change", () => {
  if (!state.lastSearch) return;
  runSearch(state.lastSearch.origins, { ...state.lastSearch.params, currency: currencySelect.value });
});


// ===========================================================================
// 5. THE "WHEN" POP-UP
// ===========================================================================

const whenButton = $("when-button");
const whenPopover = $("when-popover");
const durationSelect = $("duration");
const departDateInput = $("depart-date");
const returnDateInput = $("return-date");

const today = new Date().toISOString().slice(0, 10);
departDateInput.min = today;
returnDateInput.min = today;

const isSpecificMode = () => $("mode-specific").checked;

function updateWhenFields() {
  const specific = isSpecificMode();
  $("specific-fields").hidden = !specific;
  $("flexible-fields").hidden = specific;
  $("custom-nights-field").hidden = specific || durationSelect.value !== "custom";
  // "±1 night" only makes sense with flexible dates and no destination (a
  // destination search already shows the days around each weekend).
  $("flex-nights-field").hidden = specific || hasDestination();
  $("when-summary").textContent = describeWhen();
}

function describeWhen() {
  if (isSpecificMode()) {
    return departDateInput.value && returnDateInput.value ? `${formatDay(departDateInput.value)} – ${formatDay(returnDateInput.value)}` : "Pick your dates";
  }
  if (durationSelect.value === "weekend") return "Weekend · Flexible";
  if (durationSelect.value === "long") return "Long weekend · Flexible";
  if (durationSelect.value === "week") return "Full week · Flexible";
  return `${$("custom-nights").value || "?"} nights · Flexible`;
}

// Nights of the stays in the "Trip length" list (custom = the number typed in).
const TRIP_NIGHTS = { weekend: 2, long: 3, week: 7 };

function setWhenOpen(open) {
  whenPopover.hidden = !open;
  whenButton.setAttribute("aria-expanded", String(open));
}

whenButton.addEventListener("click", () => setWhenOpen(whenPopover.hidden));
$("when-done").addEventListener("click", () => setWhenOpen(false));
document.addEventListener("click", (event) => {
  if (!whenPopover.hidden && !event.target.closest(".field-when")) setWhenOpen(false);
});
document.querySelectorAll('input[name="date-mode"]').forEach((radio) => radio.addEventListener("change", updateWhenFields));
[durationSelect, $("custom-nights"), departDateInput, returnDateInput].forEach((el) => el.addEventListener("input", updateWhenFields));
departDateInput.addEventListener("change", () => {
  returnDateInput.min = departDateInput.value || today; // can't return before leaving
});
updateWhenFields();

// Turns the pop-up's choices (and "Going to") into the options sent to the search function.
function collectSearchParams() {
  const common = { currency: currencySelect.value, maxGapHours: $("max-gap").value };
  if (hasDestination()) common.destination = goingInput.dataset.code;

  if (isSpecificMode()) {
    if (!departDateInput.value || !returnDateInput.value) throw new Error("Pick both a depart and a return date, or switch to flexible dates.");
    if (returnDateInput.value <= departDateInput.value) throw new Error("The return date needs to be after the depart date.");
    return { ...common, mode: "specific", departDate: departDateInput.value, returnDate: returnDateInput.value };
  }

  const flexible = { ...common, mode: "flexible", flexNights: $("flex-nights").checked ? "1" : "0" };
  const type = durationSelect.value;
  if (type in TRIP_NIGHTS) {
    const nights = String(TRIP_NIGHTS[type]);
    // With a destination: compare the coming weekends / weeks of that type.
    if (hasDestination()) return { ...flexible, trip: type, nights };
    return type === "week" ? { ...flexible, nights } : { ...flexible, nights, weekendOnly: "true" };
  }

  const nights = Number($("custom-nights").value);
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) throw new Error("Enter a whole number of nights between 1 and 30.");
  return { ...flexible, nights: String(nights) };
}


// ===========================================================================
// 6. SEARCHING
// ===========================================================================

const rowsEl = $("table-rows");
const searchButton = document.querySelector(".search-btn");

function showMessage(html, isError = false) {
  rowsEl.innerHTML = `<div class="state-message${isError ? " is-error" : ""}">${html}</div>`;
}

// Calls the Edge Function and returns { results, currency, origins, debug }.
async function callSearchFunction(origins, params) {
  const query = new URLSearchParams({
    origins: origins.map((o) => o.code).join(","),
    counts: origins.map((o) => o.count).join(","),
    ...params,
  });
  const response = await fetch(`${SEARCH_FUNCTION_URL}?${query}`, {
    // Supabase requires these on every call to an Edge Function.
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from the server: ${text.slice(0, 200)}`);
  }

  // A rejected request can label its reason `message`, `msg`, or `error`
  // depending on which layer refused it — so a real failure never quietly
  // looks like "no results found".
  if (!response.ok) throw new Error(`Request rejected: ${json.message || json.msg || json.error || `HTTP ${response.status}`}`);
  if (json.error) throw new Error(json.error);
  if (params.destination) {
    if (json.mode !== "trip" || !Array.isArray(json.windows)) {
      throw new Error("The deployed search-flights function doesn't know one-destination searches yet — redeploy supabase/functions/search-flights/index.ts in your Supabase dashboard.");
    }
    return json;
  }
  if (!Array.isArray(json.results)) throw new Error("The server replied, but without a results list — the function may not be deployed correctly.");
  if (json.results.length > 0 && !("travelers" in json.results[0])) {
    throw new Error("The deployed search-flights function is running older code — redeploy supabase/functions/search-flights/index.ts in your Supabase dashboard.");
  }
  return json;
}

// Turns the function's `debug` block into a plain-English reason for "nothing found".
function explainEmptyResult(debug, gapHours) {
  if (!debug) return "No shared destinations found.";
  const reports = debug.originReports ?? [];
  const n = debug.travelerCount ?? reports.length;

  const broken = reports.find((r) => !r.ok);
  if (broken) {
    return `Travelpayouts rejected the request for ${esc(broken.code)}${broken.error ? ` (${esc(broken.error)})` : ""} — likely the token isn't set correctly in Edge Function Secrets.`;
  }
  // Is Travelpayouts rate-limiting us? Then "no results" would be misleading.
  if (debug.rateLimited) {
    return `The flight-data service is limiting how many requests we can make (too many in a short time). This is temporary — wait about a minute, then <button type="button" id="retry-search" class="inline-retry">try again</button>. Searches get faster and use fewer requests as the server remembers more answers.`;
  }
  // Did Travelpayouts simply not answer?
  const tp = debug.travelpayouts;
  if (tp && tp.calls > 0 && tp.failed / tp.calls >= 0.1) {
    return `The flight-data service didn't answer ${tp.failed} of ${tp.calls} requests. That is a temporary glitch, not proof that there are no flights — press <strong>Find destinations</strong> again in a moment.`;
  }
  if (!debug.candidatesConsidered) {
    const counts = reports.map((r) => `${esc(r.code)}: ${r.destinations}`).join(", ");
    return `No destination is reachable from all ${n} departures (cached routes found — ${counts}). Try a bigger city or a different airport for one of them.`;
  }
  if (debug.rejectedByTimeGap > 0 && gapHours > 0) {
    return `There are ${debug.rejectedByTimeGap} dates where everyone has a fare, but the arrival or return times are more than ${gapHours} hours apart. Open <strong>When</strong> and allow a bigger gap, or try other dates.`;
  }
  const foundNone = reports.every((r) => !r.destinationsWithFares);
  const hint = foundNone
    ? "Travelpayouts has no cached fares at all for that stay length — try a different trip length."
    : "Everyone has some cached fares, they just never land on the same day — try a more common trip length (a full week tends to have more cached data than an odd number of nights).";
  const groupHint = n >= 3 ? ` With ${n} departures it is much harder for everyone to have a cached fare on the same day; fewer departures, or the ±1 night option, usually helps.` : "";
  return `Found ${debug.candidatesConsidered} destination${debug.candidatesConsidered === 1 ? "" : "s"} everyone can reach, but no cached fare matches your dates. ${hint}${groupHint}`;
}

async function runSearch(origins, params) {
  // A new search (e.g. another currency) while a trip page is open: back to the list.
  if (!tripPageEl.hidden) {
    closeTripPage();
    if (history.state?.tripPage) history.replaceState(null, "", location.pathname + location.search);
  }
  state.lastSearch = { origins, params };
  state.maxGapHours = Number(params.maxGapHours);
  state.debug = null;
  state.trip = null;
  setResultsMode(Boolean(params.destination));
  updateWarning();
  showMessage("Searching… (this can take a few seconds)");
  searchButton.disabled = true;

  try {
    const json = await callSearchFunction(origins, params);

    // Names and positions for the departures (for the table and the globe's labels).
    state.origins = origins.map((o, i) => {
      const server = json.origins?.[i] ?? {};
      return { label: o.label || server.name || o.code, code: o.code, lat: o.lat ?? server.lat, lon: o.lon ?? server.lon, count: o.count };
    });
    state.debug = json.debug;
    state.currency = json.currency || params.currency; // what the prices are really in
    state.selected = null;
    state.globeView = null; // new results: let the globe frame them again

    if (json.mode === "trip") {
      state.results = [];
      showTrip(json);
      return;
    }
    state.results = json.results;
    if (json.results.length === 0) {
      showMessage(explainEmptyResult(json.debug, state.maxGapHours));
      renderGlobe();
      return;
    }
    renderTable();
  } catch (error) {
    state.results = [];
    showMessage(esc(error.message), true);
    renderGlobe();
  } finally {
    searchButton.disabled = false;
  }
}

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const departures = readDepartures();
  if (departures.some((d) => !d.code)) return showMessage("Pick an airport or city from the dropdown for every departure (or remove the empty one with ×).", true);
  if (new Set(departures.map((d) => d.code)).size !== departures.length) {
    return showMessage("Two departures are the same place. For several travellers leaving from one place, use the people counter on that departure instead.", true);
  }
  if (goingInput.value.trim() && !hasDestination()) {
    return showMessage("Pick the destination from the dropdown in “Going to” — or clear it (×) to search anywhere.", true);
  }
  if (hasDestination() && departures.some((d) => d.code === goingInput.dataset.code)) {
    return showMessage("“Going to” is also one of the departures. Pick another destination, or remove that departure.", true);
  }

  let params;
  try {
    params = collectSearchParams();
  } catch (error) {
    return showMessage(esc(error.message), true);
  }
  setWhenOpen(false);
  runSearch(departures, params);
});


// ===========================================================================
// 7. THE RESULTS TABLE
// ===========================================================================

const BIG = 1e9;
const sumOver = (r, field) => r.travelers.reduce((total, t) => total + t[field], 0);
const travelMinutes = (r) => (r.travelers.every((t) => t.timesKnown) ? sumOver(r, "outMinutes") : BIG);
const stopCount = (r) => sumOver(r, "transfers");

function sortedResults() {
  const list = [...state.results];
  if (state.sort === "fastest") list.sort((x, y) => travelMinutes(x) - travelMinutes(y) || x.total - y.total);
  else if (state.sort === "stops") list.sort((x, y) => stopCount(x) - stopCount(y) || x.total - y.total);
  else list.sort((x, y) => x.total - y.total);
  return list;
}

const TAG_FOR_SORT = { cheapest: "CHEAPEST", fastest: "FASTEST", stops: "FEWEST STOPS" };

// One traveller's block inside a row: who, price, duration, stops, flight times.
// (Booking happens on the trip page, after "Select" — section 7d.)
function travelerHtml(leg, index, info, totalTravelers, currency) {
  const name = index === 0 ? `You · ${info.label}` : totalTravelers === 2 ? `Them · ${info.label}` : info.label;
  const price =
    leg.count > 1
      ? `<span class="traveler-price">${formatPrice(leg.subtotal, currency)}</span><span class="traveler-sub">${leg.count} × ${formatPrice(leg.price, currency)}</span>`
      : `<span class="traveler-price">${formatPrice(leg.price, currency)}</span>`;
  const head = `<span class="dot dot-${index % 8}"></span><span class="who">${esc(name)}</span>${price}`;

  const stops = `<span class="${leg.transfers === 0 ? "direct" : ""}">${stopsLabel(leg.transfers)}</span>`;
  const meta = leg.timesKnown ? `<span class="traveler-meta">· ≈${durationLabel(leg.outMinutes)} · ${stops}</span>` : `<span class="traveler-meta">· ${stops}</span>`;
  const times = leg.timesKnown
    ? `Out <strong>${hhmm(leg.outDepart)} → ≈${hhmm(leg.outArrive)}</strong>${dayShiftMarker(leg.outDepart, leg.outArrive)} · Back <strong>${hhmm(leg.retDepart)} → ≈${hhmm(leg.retArrive)}</strong>${dayShiftMarker(leg.retDepart, leg.retArrive)}`
    : "Flight times not available for this fare";

  return `<div class="traveler"><div class="traveler-head">${head}${meta}</div><div class="times">${times}</div></div>`;
}

// "Your arrivals are ≈1h 20 apart · ..." under the journeys (when times are known).
function gapNoteHtml(r) {
  if (r.arrivalGapHours == null) return "";
  return r.travelers.length === 2
    ? `<div class="gap-note">Your arrivals are <b>≈${hoursLabel(r.arrivalGapHours)}</b> apart · your return flights <b>≈${hoursLabel(r.returnGapHours)}</b> apart</div>`
    : `<div class="gap-note">Everyone arrives within <b>≈${hoursLabel(r.arrivalGapHours)}</b> of each other · return flights within <b>≈${hoursLabel(r.returnGapHours)}</b></div>`;
}

const peopleLabel = (people) => (people === 2 ? "both of you" : `${people} travellers`);

function rowHtml(r, index, currency) {
  const n = r.travelers.length;
  const people = r.travelers.reduce((total, t) => total + t.count, 0);
  const gapNote = gapNoteHtml(r);
  const selected = r.destination === state.selected;

  return `
    <div class="row${selected ? " is-selected" : ""}" data-code="${esc(r.destination)}" role="button" tabindex="0">
      <div class="rank">${index + 1}</div>
      <div class="dest">
        <div class="dest-city">${esc(r.destinationName)}</div>
        ${r.country ? `<div class="dest-country">${esc(r.country)}</div>` : ""}
        <div class="dest-dates">${formatDay(r.departDate)} – ${formatDay(r.returnDate)}</div>
        <div class="dest-meta"><span class="code-chip">${esc(r.destination)}</span><span>${r.nights} night${r.nights === 1 ? "" : "s"}</span>${index === 0 ? `<span class="tag">${TAG_FOR_SORT[state.sort]}</span>` : ""}</div>
      </div>
      <div class="journeys">
        ${r.travelers.map((leg, i) => travelerHtml(leg, i, state.origins[i], n, currency)).join("")}
        ${gapNote}
      </div>
      <div class="total-cell">
        <div class="total">${formatPrice(r.total, currency)}</div>
        <div class="total-sub">${peopleLabel(people)}</div>
        <button type="button" class="select-btn" data-dest="${esc(r.destination)}">Select</button>
      </div>
    </div>`;
}

// Two ways to show results in the same box: the ranked table of places, or —
// with a destination chosen — the weekends strip and its options.
const DEFAULT_INFO = $("info-text").innerHTML;
function setResultsMode(trip) {
  document.querySelector(".table-head").hidden = trip;
  $("sort-chips").hidden = trip;
  $("trip-chips").hidden = !trip;
  if (!trip) {
    $("results-title").textContent = "Ranked meeting spots";
    $("info-text").innerHTML = DEFAULT_INFO;
  }
}

function renderTable() {
  const list = sortedResults();
  if (!list.some((r) => r.destination === state.selected)) state.selected = list[0].destination;

  rowsEl.innerHTML = list.map((r, i) => rowHtml(r, i, state.currency)).join("");

  const gapText = state.maxGapHours > 0 ? ` · arrivals and returns within ${state.maxGapHours}h of each other` : "";
  const d = state.debug;
  const checkedText = d && d.sharedDestinations ? ` (checked ${d.candidatesConsidered} of the ${d.sharedDestinations} everyone can reach)` : "";
  const currencyText = d && d.currencyConverted === false ? " · prices shown in USD (exchange rates unavailable)" : "";
  $("results-subtitle").textContent = `Showing ${list.length} destination${list.length === 1 ? "" : "s"}${checkedText} · same dates for everyone${gapText}${currencyText}`;
  updateWarning();
  renderGlobe();
}

// A small notice when Travelpayouts didn't answer some requests, so a short
// list isn't mistaken for "that's all there is".
function updateWarning() {
  const box = $("results-warning");
  const tp = state.debug?.travelpayouts;
  if (state.results.length > 0 && state.debug?.rateLimited) {
    box.innerHTML = `<span>Heads-up: the flight-data service is limiting our requests, so this list is incomplete. Wait about a minute and try again for more options.</span><button type="button" id="retry-search">Try again</button>`;
    box.hidden = false;
  } else if (tp && tp.failed > 0 && state.results.length > 0) {
    box.innerHTML = `<span>Heads-up: the flight-data service didn't answer ${tp.failed} of ${tp.calls} requests, so a few options may be missing.</span><button type="button" id="retry-search">Try again</button>`;
    box.hidden = false;
  } else {
    box.innerHTML = "";
    box.hidden = true;
  }
}

// "Try again" buttons (in the warning, or inside a "nothing found" message)
document.addEventListener("click", (event) => {
  if (event.target.id === "retry-search" && state.lastSearch) runSearch(state.lastSearch.origins, state.lastSearch.params);
});

function selectDestination(code, { scrollToRow = false } = {}) {
  if (code === state.selected) return;
  state.selected = code;
  rowsEl.querySelectorAll(".row").forEach((row) => row.classList.toggle("is-selected", row.dataset.code === code));
  showOnGlobe(code);
  if (scrollToRow) rowsEl.querySelector(`.row[data-code="${CSS.escape(code)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

rowsEl.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (row) selectDestination(row.dataset.code);
});
rowsEl.addEventListener("keydown", (event) => {
  if (event.target.closest("button")) return; // Enter on "Select" presses the button, as usual
  const row = event.target.closest(".row");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectDestination(row.dataset.code);
  }
});

$("sort-chips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.sort = chip.dataset.sort;
  document.querySelectorAll("#sort-chips .chip").forEach((c) => c.classList.toggle("is-selected", c === chip));
  if (state.results.length > 0) renderTable();
});


// ===========================================================================
// 7b. ONE DESTINATION — comparing dates instead of places
// ===========================================================================
// The function answers with `windows`: one per coming weekend (or week), each
// with its `options` (the usual days, a day earlier, a day later...) already
// sorted cheapest first. Status "ok" = bookable for everyone; "gap" = everyone
// has a fare but arrivals/returns are too far apart; "missing" = no fare yet.

const WEEKDAY_FORMAT = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
const weekday = (dateStr) => WEEKDAY_FORMAT.format(new Date(`${dateStr}T00:00:00Z`));
const nightsLabel = (n) => `${n} night${n === 1 ? "" : "s"}`;
const daysLabel = (o) => `${weekday(o.departDate)} → ${weekday(o.returnDate)}`;

// "Nov 5 – 8", or "Oct 30 – Nov 2" across two months
function dateRange(from, to) {
  const [fromMonth] = formatDay(from).split(" ");
  const [toMonth, toDay] = formatDay(to).split(" ");
  return fromMonth === toMonth ? `${formatDay(from)} – ${toDay}` : `${formatDay(from)} – ${formatDay(to)}`;
}

const cheapestOption = (w) => w.options.find((o) => o.status === "ok") ?? null;
const usualOption = (w) => w.options.find((o) => o.shift[0] === 0 && o.shift[1] === 0 && o.status === "ok") ?? null;

// The words for the kind of stay being compared.
function stayWords(trip) {
  switch (trip.tripType) {
    case "weekend": return { unit: "weekend", plural: "weekends", same: "Same weekend, other days" };
    case "long": return { unit: "long weekend", plural: "long weekends", same: "Same long weekend, other days" };
    case "week": return { unit: "week", plural: "weeks", same: "Same week, other days" };
    case "dates": return { unit: "trip", plural: "trips", same: "Your dates, and a day either side" };
    default: return { unit: "week", plural: `${nightsLabel(trip.nights)} stays`, same: "Same week, other days" };
  }
}

function showTrip(json) {
  state.trip = json;
  const totals = json.windows.map((w) => cheapestOption(w)?.total ?? Infinity);
  const best = Math.min(...totals);
  state.tripWindow = best === Infinity ? 0 : totals.indexOf(best);
  state.tripOption = 0;
  if (best === Infinity) {
    renderTripHeader();
    showMessage(explainEmptyTrip(json));
    $("info-text").innerHTML = DEFAULT_INFO;
    showTripOnGlobe(null);
    updateWarning();
    return;
  }
  renderTrip();
}

function renderTripHeader() {
  const trip = state.trip;
  const people = state.origins.reduce((sum, o) => sum + o.count, 0);
  const words = stayWords(trip);
  const what = trip.windows.length > 1 ? `Cheapest ${words.plural} over the next ${trip.windows.length} weeks` : "Your dates, and the days around them";
  const gapText = state.maxGapHours > 0 ? ` · arrivals and returns within ${state.maxGapHours}h of each other` : "";
  const currencyText = state.debug?.currencyConverted === false ? " · prices shown in USD (exchange rates unavailable)" : "";
  $("results-title").textContent = `${trip.destination.name}, together`;
  $("results-subtitle").textContent = `${what} · total for ${peopleLabel(people)} · same dates for everyone${gapText}${currencyText}`;
  document.querySelectorAll("#trip-chips .chip").forEach((chip) => chip.classList.toggle("is-selected", chip.dataset.trip === trip.tripType));
}

function renderTrip() {
  const trip = state.trip;
  const w = trip.windows[state.tripWindow];
  const option = w.options[state.tripOption];
  const words = stayWords(trip);
  const several = trip.windows.length > 1;
  const from = w.options.reduce((min, o) => (o.departDate < min ? o.departDate : min), w.departDate);
  const to = w.options.reduce((max, o) => (o.returnDate > max ? o.returnDate : max), w.returnDate);

  renderTripHeader();
  rowsEl.innerHTML = `
    <div class="trip">
      ${several ? stripHtml(trip, words) : ""}
      <div class="${several ? "trip-section" : ""}">
        <div class="block-title"><strong>${words.same}</strong><span>${dateRange(from, to)} · cheapest first</span></div>
        <div class="alts">${w.options.map((o, i) => altHtml(o, i, w, trip)).join("")}</div>
        ${option?.status === "ok"
          ? tripBoxHtml(option)
          : `<div class="state-message">No option this ${words.unit} works for everyone yet — pick another ${words.unit} above.</div>`}
      </div>
    </div>`;
  $("info-text").innerHTML = tripInsight(w, words);
  showTripOnGlobe(option?.status === "ok" ? option : null);
  updateWarning();
}

// The strip: one column per weekend, the bar = the cheapest way to do it.
function stripHtml(trip, words) {
  const people = state.origins.reduce((sum, o) => sum + o.count, 0);
  const totals = trip.windows.map((w) => cheapestOption(w)?.total ?? null);
  const known = totals.filter((t) => t !== null).sort((a, b) => a - b);
  const min = known[0];
  const max = known[known.length - 1];
  const middle = known[Math.floor((known.length - 1) / 2)];

  const columns = trip.windows.map((w, i) => {
    const total = totals[i];
    const [departMonth] = formatDay(w.departDate).split(" ");
    const [returnMonth, returnDay] = formatDay(w.returnDate).split(" ");
    const classes = ["wk", i === state.tripWindow && "is-selected", total === null && "wk-empty", total !== null && total <= middle && "is-cheap"].filter(Boolean).join(" ");
    const height = total === null ? null : max === min ? 70 : Math.round(30 + ((total - min) / (max - min)) * 80);
    const price = total === null ? "—" : formatPrice(total, state.currency);
    return `
      <button type="button" class="${classes}" data-window="${i}" aria-label="${esc(`${dateRange(w.departDate, w.returnDate)}: ${total === null ? "no price yet" : `from ${price}`}`)}">
        <span class="wk-tag">${total === min ? "BEST" : ""}</span>
        <span class="wk-price">${price}</span>
        <span class="wk-bar-area"><span class="wk-bar"${height === null ? "" : ` style="height: ${height}px"`}></span></span>
        <span class="wk-dates">${formatDay(w.departDate)}<br><span>–${departMonth === returnMonth ? returnDay : formatDay(w.returnDate)}</span></span>
      </button>`;
  });
  return `
    <div class="weeks">${columns.join("")}</div>
    <p class="strip-note">Each bar is the cheapest way to do that ${words.unit}, for ${peopleLabel(people)} · — = no fare that works for everyone yet</p>`;
}

// One option card: the days, the price, and how it compares with the usual
// days (e.g. Fri → Sun). If the usual days have no price, it compares with
// the cheapest option instead.
function altHtml(o, i, w, trip) {
  const head = `<span class="alt-days">${daysLabel(o)}</span><span class="alt-dates">${dateRange(o.departDate, o.returnDate)} · ${nightsLabel(o.nights)}</span>`;
  if (o.status !== "ok") {
    const why =
      o.status === "missing" ? "No fare yet"
      : o.arrivalGapHours > state.maxGapHours ? `Arrivals ≈${hoursLabel(o.arrivalGapHours)} apart`
      : `Returns ≈${hoursLabel(o.returnGapHours)} apart`;
    const price = o.total != null ? `<span class="alt-price">${formatPrice(o.total, state.currency)}</span>` : "";
    return `<div class="alt is-off">${head}<span class="alt-bottom">${price}<span class="alt-why">${why}</span></span></div>`;
  }

  const usual = usualOption(w);
  const reference = usual ?? cheapestOption(w);
  let badge;
  if (o === reference) {
    badge = usual ? `<span class="badge badge-plain">${trip.tripType === "dates" ? "your dates" : "usual days"}</span>` : `<span class="badge badge-less">cheapest</span>`;
  } else {
    const diff = o.total - reference.total;
    badge =
      diff < 0 ? `<span class="badge badge-less">${formatPrice(-diff, state.currency)} less</span>`
      : diff > 0 ? `<span class="badge badge-more">+${formatPrice(diff, state.currency)}</span>`
      : `<span class="badge badge-plain">same price</span>`;
  }
  return `
    <button type="button" class="alt${i === state.tripOption ? " is-selected" : ""}" data-option="${i}">
      ${head}
      <span class="alt-bottom"><span class="alt-price">${formatPrice(o.total, state.currency)}</span>${badge}</span>
    </button>`;
}

// The chosen option in full: everyone's flights, the time gaps and the total.
function tripBoxHtml(o) {
  const n = o.travelers.length;
  const people = o.travelers.reduce((sum, t) => sum + t.count, 0);
  return `
    <div class="trip-box">
      <div>
        <div class="trip-box-title">
          <strong>${weekday(o.departDate)} ${formatDay(o.departDate)} → ${weekday(o.returnDate)} ${formatDay(o.returnDate)}</strong>
          <span class="code-chip">${esc(state.trip.destination.code)}</span><span class="nights">${nightsLabel(o.nights)}</span>
        </div>
        ${o.travelers.map((leg, i) => travelerHtml(leg, i, state.origins[i], n, state.currency)).join("")}
        ${gapNoteHtml(o)}
      </div>
      <div class="total-cell">
        <div class="total">${formatPrice(o.total, state.currency)}</div>
        <div class="total-sub">${peopleLabel(people)}</div>
        <button type="button" class="select-btn">Select</button>
      </div>
    </div>`;
}

// The card under the globe: the money tip for the selected weekend.
function tripInsight(w, words) {
  const cheapest = cheapestOption(w);
  const usual = usualOption(w);
  if (!cheapest) return DEFAULT_INFO;
  if (usual && cheapest !== usual && cheapest.total < usual.total) {
    const extra = cheapest.nights > usual.nights ? " One more night, and you pay less." : "";
    return `<strong>${daysLabel(cheapest)} saves you ${formatPrice(usual.total - cheapest.total, state.currency)}</strong> compared with ${daysLabel(usual)}.${extra}`;
  }
  if (usual && cheapest === usual) return `<strong>${daysLabel(usual)} is already the cheapest choice that ${words.unit}.</strong> We only show dates that work for everyone.`;
  return `<strong>Cheapest that ${words.unit}: ${daysLabel(cheapest)}.</strong> We only show dates that work for everyone.`;
}

// The globe shows the destination with everyone's flight paths.
function showTripOnGlobe(option) {
  const d = state.trip.destination;
  const sameAsInput = goingInput.dataset.code === d.code;
  state.results = [{
    destination: d.code,
    destinationName: d.name,
    country: d.country,
    lat: d.lat ?? (sameAsInput ? Number(goingInput.dataset.lat) : null),
    lon: d.lon ?? (sameAsInput ? Number(goingInput.dataset.lon) : null),
    total: option?.total ?? 0,
    globeLabel: option ? `${d.name} · ${dateRange(option.departDate, option.returnDate)}` : d.name,
  }];
  state.selected = d.code;
  renderGlobe();
}

// A plain-English reason when no date works for everyone.
function explainEmptyTrip(json) {
  const d = json.debug ?? {};
  const name = esc(json.destination?.name ?? "there");
  if (d.rateLimited) {
    return `The flight-data service is limiting how many requests we can make (too many in a short time). This is temporary — wait about a minute, then <button type="button" id="retry-search" class="inline-retry">try again</button>.`;
  }
  const tp = d.travelpayouts;
  if (tp && tp.calls > 0 && tp.failed / tp.calls >= 0.1) {
    return `The flight-data service didn't answer ${tp.failed} of ${tp.calls} requests. That is a temporary glitch, not proof that there are no flights — press <strong>Find dates</strong> again in a moment.`;
  }
  const without = (d.faresFound ?? []).map((f, i) => (f.days === 0 ? esc(state.origins[i]?.label ?? f.code) : null)).filter(Boolean);
  if (without.length > 0) {
    return `There are no cached fares from ${without.join(" or ")} to ${name} for these dates yet. Try a bigger airport nearby (or the whole city instead of one airport), or another kind of stay — a full week often has more cached data.`;
  }
  if (d.rejectedByGap > 0 && state.maxGapHours > 0) {
    return `Everyone has fares to ${name} on ${d.rejectedByGap} of these dates, but the arrival or return times are more than ${state.maxGapHours} hours apart. Open <strong>When</strong> and allow a bigger gap, or try another kind of stay.`;
  }
  return `Everyone has some cached fares to ${name}, just never on the same days. Try another kind of stay (weekend, long weekend, a week), or other dates.`;
}

// Picking a weekend in the strip, or an option card.
rowsEl.addEventListener("click", (event) => {
  if (!state.trip) return;
  const week = event.target.closest(".wk");
  const option = event.target.closest(".alt[data-option]");
  if (week) {
    state.tripWindow = Number(week.dataset.window);
    state.tripOption = 0; // its cheapest option
    renderTrip();
    rowsEl.querySelector(`.wk[data-window="${week.dataset.window}"]`)?.focus({ preventScroll: true });
  } else if (option) {
    state.tripOption = Number(option.dataset.option);
    renderTrip();
    rowsEl.querySelector(`.alt[data-option="${option.dataset.option}"]`)?.focus({ preventScroll: true });
  }
});

// Weekend / Long weekend / A week: compare another kind of stay.
$("trip-chips").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip || !state.lastSearch?.params.destination) return;
  const type = chip.dataset.trip;
  // Keep the "When" pop-up in step with the chips.
  $("mode-flexible").checked = true;
  durationSelect.value = type;
  updateWhenFields();
  document.querySelectorAll("#trip-chips .chip").forEach((c) => c.classList.toggle("is-selected", c === chip));
  const { departDate, returnDate, ...params } = state.lastSearch.params;
  runSearch(state.lastSearch.origins, { ...params, mode: "flexible", trip: type, nights: String(TRIP_NIGHTS[type]) });
});


// ===========================================================================
// 7c. BOOKING ON AVIASALES
// ===========================================================================
// Each traveller books their own flight, from their own airport. Pressing
// "Book on Aviasales" asks the search function for that traveller's partner
// link (the Aviasales search, turned into a Travelpayouts link that credits
// the booking to you) and opens it in a new tab.

const bookingLinks = new Map(); // the same button twice = no second request

// The plain Aviasales search, only used if the partner link can't be fetched:
// the visitor still gets their flights, the booking just isn't credited.
function plainAviasalesUrl({ from, to, depart, return: back, adults }) {
  const ddmm = (iso) => iso.slice(8, 10) + iso.slice(5, 7);
  return `https://www.aviasales.com/search/${from}${ddmm(depart)}${to}${back ? ddmm(back) : ""}${adults}`;
}

async function fetchBookingLink(trip) {
  const key = JSON.stringify(trip);
  if (bookingLinks.has(key)) return bookingLinks.get(key);
  try {
    const response = await fetch(`${SEARCH_FUNCTION_URL}?${new URLSearchParams({ book: "1", ...trip })}`, {
      headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY },
    });
    const json = await response.json();
    if (!json.url) throw new Error(`${json.error || json.message || `HTTP ${response.status}`} — is the latest search-flights function deployed?`);
    if (json.tracked) bookingLinks.set(key, json);
    else console.warn(`This booking link is NOT credited to you: ${json.reason}`);
    return json;
  } catch (error) {
    console.warn(`Couldn't get the partner link (${error.message}), opening the plain Aviasales search instead.`);
    return { url: plainAviasalesUrl(trip), tracked: false };
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest(".book-btn");
  if (!button || button.disabled) return;
  const { from, to, depart, return: back, adults } = button.dataset;

  // Browsers only allow a new tab straight after a click, so open it now and
  // send it on once the link is ready.
  const tab = window.open("", "_blank");
  if (tab) {
    tab.opener = null; // the new tab can't reach back into this page
    try {
      tab.document.title = "Opening Aviasales…";
      tab.document.body.innerHTML = '<p style="font: 16px sans-serif; color: #7C5744; padding: 40px;">Opening Aviasales…</p>';
    } catch {
      // a blank tab is fine too
    }
  }
  button.disabled = true;
  const { url } = await fetchBookingLink({ from, to, depart, return: back, adults });
  button.disabled = false;
  if (tab) tab.location.href = url;
  else window.location.href = url; // pop-ups blocked: go there in this tab instead
});


// ===========================================================================
// 7d. THE TRIP PAGE (after "Select")
// ===========================================================================
// "Select" opens a page for that one trip: everyone's flights with their
// "Book on Aviasales" buttons, and room for what goes with the trip (where to
// stay...). It takes the place of the list (the globe stays); "Back to
// results", or the browser's back button, returns to the list.

const tripPageEl = $("trip-page");
const listViewEls = [document.querySelector(".hero"), document.querySelector(".table-box")];
let lastTrip = null; // so the browser's Forward button can reopen it

// The trip behind a "Select" button, in one shape for both kinds of search.
function tripFromSelect(button) {
  if (button.dataset.dest) {
    const r = state.results.find((x) => x.destination === button.dataset.dest);
    return r ? { ...r, code: r.destination, name: r.destinationName } : null;
  }
  const option = state.trip?.windows[state.tripWindow]?.options[state.tripOption];
  const d = state.trip?.destination;
  return option?.status === "ok" ? { ...option, code: d.code, name: d.name, country: d.country } : null;
}

const travellersLabel = (people) => `${people} traveller${people === 1 ? "" : "s"}`;
const dayLabel = (dateStr) => `${weekday(dateStr)} ${formatDay(dateStr)}`;

// One traveller: their route and flight times, their price, their Book button.
function tripFlightHtml(leg, i, n, t) {
  const info = state.origins[i] ?? {};
  const name = i === 0 ? `You · ${info.label}` : n === 2 ? `Them · ${info.label}` : info.label;
  const stops = `<span class="${leg.transfers === 0 ? "direct" : ""}">${stopsLabel(leg.transfers)}</span>`;
  const times = leg.timesKnown
    ? `Out <strong>${dayLabel(leg.outDepart.slice(0, 10))} · ${hhmm(leg.outDepart)} → ≈${hhmm(leg.outArrive)}</strong>${dayShiftMarker(leg.outDepart, leg.outArrive)}<br>
       Back <strong>${dayLabel(leg.retDepart.slice(0, 10))} · ${hhmm(leg.retDepart)} → ≈${hhmm(leg.retArrive)}</strong>${dayShiftMarker(leg.retDepart, leg.retArrive)}<br>
       ≈${durationLabel(leg.outMinutes)} each way · ${stops}`
    : `Out ${dayLabel(t.departDate)} · back ${dayLabel(t.returnDate)} · ${stops}<br>Flight times not available for this fare`;
  const price = leg.count > 1
    ? `<div class="tp-price">${formatPrice(leg.subtotal, state.currency)}</div><div class="tp-price-sub">${leg.count} × ${formatPrice(leg.price, state.currency)}</div>`
    : `<div class="tp-price">${formatPrice(leg.price, state.currency)}</div><div class="tp-price-sub">1 traveller</div>`;
  // The link itself is fetched when the button is pressed (section 7c).
  const book = info.code
    ? `<button type="button" class="book-btn is-primary" data-from="${esc(info.code)}" data-to="${esc(t.code)}" data-depart="${esc(t.departDate)}" data-return="${esc(t.returnDate ?? "")}" data-adults="${leg.count}">Book ${leg.count > 1 ? `${leg.count} seats ` : ""}on Aviasales<span class="book-arrow" aria-hidden="true">↗</span></button>`
    : "";
  return `
    <div class="tp-flight">
      <div>
        <div class="traveler-head"><span class="dot dot-${i % 8}"></span><span class="who">${esc(name)}</span></div>
        <div class="tp-route">${esc(info.label)} → ${esc(t.name)}</div>
        <div class="tp-legs">${times}</div>
      </div>
      <div class="tp-buy">${price}${book}</div>
    </div>`;
}

function tripPageHtml(t) {
  const n = t.travelers.length;
  const people = t.travelers.reduce((sum, leg) => sum + leg.count, 0);
  return `
    <button type="button" class="back-link" id="trip-back">← Back to results</button>
    <div class="tp-head">
      <div>
        <div class="badge">YOUR TRIP</div>
        <h2>${esc(t.name)}</h2>
        ${t.country ? `<div class="tp-country">${esc(t.country)}</div>` : ""}
        <div class="tp-when">${dayLabel(t.departDate)} → ${dayLabel(t.returnDate)} · ${nightsLabel(t.nights)} · ${travellersLabel(people)}</div>
      </div>
      <div class="tp-total"><strong>${formatPrice(t.total, state.currency)}</strong><span>in total, for ${peopleLabel(people)}</span></div>
    </div>

    <section class="tp-card">
      <h3>Book your flights</h3>
      <p class="tp-sub">Everyone books their own flight, from their own airport, on the same dates.</p>
      ${t.travelers.map((leg, i) => tripFlightHtml(leg, i, n, t)).join("")}
      ${gapNoteHtml(t)}
      <p class="tp-disclosure">You book directly on Aviasales. Prices come from recent searches, so the live price can be a little different. If you book through these buttons we may earn a small commission, at no extra cost to you.</p>
    </section>

    <!-- Room for what goes with the trip: hotels for these dates, offers... -->
    <section class="tp-card">
      <h3>Where to stay in ${esc(t.name)}</h3>
      <p class="tp-sub">${dateRange(t.departDate, t.returnDate)} · ${nightsLabel(t.nights)} · ${travellersLabel(people)}</p>
      <div class="tp-placeholder">Hotel ideas for these dates will appear here.</div>
    </section>`;
}

function openTripPage(trip) {
  lastTrip = trip;
  tripPageEl.innerHTML = tripPageHtml(trip);
  listViewEls.forEach((el) => (el.hidden = true));
  tripPageEl.hidden = false;
  if (!history.state?.tripPage) history.pushState({ tripPage: true }, "", "#trip"); // so Back returns to the list
  window.scrollTo({ top: 0 });
  $("trip-back").focus({ preventScroll: true });
}

function closeTripPage() {
  if (tripPageEl.hidden) return;
  tripPageEl.hidden = true;
  tripPageEl.innerHTML = "";
  listViewEls.forEach((el) => (el.hidden = false));
  // Back where you were: the selected row (or the trip box).
  (rowsEl.querySelector(".row.is-selected") ?? rowsEl.querySelector(".trip-box"))?.scrollIntoView({ block: "center" });
}

document.addEventListener("click", (event) => {
  const select = event.target.closest(".select-btn");
  if (select) {
    const trip = tripFromSelect(select);
    if (trip) openTripPage(trip);
  } else if (event.target.closest("#trip-back")) {
    if (history.state?.tripPage) history.back(); // the popstate below closes the page
    else closeTripPage();
  }
});

// The browser's Back / Forward buttons. We place the scroll ourselves (top of
// the trip page, or back on the selected row), so the browser shouldn't.
history.scrollRestoration = "manual";
window.addEventListener("popstate", () => {
  if (!history.state?.tripPage) closeTripPage();
  else if (lastTrip && tripPageEl.hidden) openTripPage(lastTrip);
});

// A reload on "#trip" has no trip to show any more: start from the search.
if (location.hash === "#trip") history.replaceState(null, "", location.pathname + location.search);


// ===========================================================================
// 8. THE GLOBE
// ===========================================================================

// The globe's colours come from the variables at the top of styles.css
// (--ocean-a, --land, --pin0 ... --pin7, ...), so changing the theme there
// re-colours the globe too.
let themeCache = null;
function themeColors() {
  if (themeCache) return themeCache;
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();
  themeCache = {
    oceanA: v("--ocean-a"), oceanB: v("--ocean-b"), land: v("--land"), borders: v("--borders"), grid: v("--grid"),
    orbit: v("--orbit"), meet: v("--peach"), accent: v("--accent"),
    pins: Array.from({ length: 8 }, (_, i) => v(`--pin${i}`)),
  };
  return themeCache;
}

const hasCoords = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

const globeSvg = $("globe");
const globeWrap = $("globe-wrap");
let shownView = { lat: 35, lon: -30, zoom: 1 }; // what the globe shows right now
let shownGlobe = null;                          // ...and its projection (to test what's in view)

// Where the globe looks when you haven't moved it: every departure AND every
// result in view, so all the options are there at once and it doesn't jump
// when you pick another one. No search yet: a calm view over the Atlantic.
function autoView() {
  const origins = state.origins ?? [];
  const destinations = state.results.filter(hasCoords);
  if (destinations.length === 0 || origins.length === 0 || !origins.every(hasCoords)) return { lat: 35, lon: -30, zoom: 1 };
  return Geo.fitView([...origins, ...destinations]);
}

function renderGlobe() {
  const labelsEl = $("globe-labels");
  const R = GLOBE_RADIUS;
  const T = themeColors();

  const origins = state.origins ?? [];
  const destinations = state.results.filter(hasCoords);
  const selected = destinations.find((r) => r.destination === state.selected);
  const ready = selected && origins.length > 0 && origins.every(hasCoords);

  shownView = state.globeView ?? autoView();
  const g = (shownGlobe = Geo.createGlobe(shownView, R));
  const { cx, cy, inside } = g;

  let overlay = "";
  let labels = "";
  let meetCountry = "";
  if (ready) {
    const dest = { lat: selected.lat, lon: selected.lon };
    const pd = g.project(dest.lat, dest.lon);
    const pins = origins.map((o, i) => ({ o, i, p: g.project(o.lat, o.lon), color: T.pins[i % 8] }));
    meetCountry = g.countryPath(dest.lat, dest.lon); // the meeting country is lit up

    // 1. Every other result: a small dot you can hover (name + price) and click.
    for (const r of destinations) {
      if (r.destination === selected.destination) continue;
      const p = g.project(r.lat, r.lon);
      if (!inside(p)) continue;
      const left = p.x > cx; // put the hover label on the side facing the middle
      overlay += `
        <g class="dest-dot" data-code="${esc(r.destination)}">
          <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="13" fill="transparent"></circle>
          <circle class="dot-core" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5.5" fill="${T.meet}" stroke="${T.oceanB}" stroke-width="2"></circle>
          <text class="dot-label" x="${(p.x + (left ? -12 : 12)).toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="${left ? "end" : "start"}">${esc(r.destinationName)} · ${formatPrice(r.total, state.currency)}</text>
        </g>`;
    }

    // 2. The selected destination: flight paths from every departure (dots with
    //    a dark rim, so they show on the sea and on land), then the pins.
    for (const { o, color } of pins) {
      const d = g.arc(o, dest);
      overlay += `<path d="${d}" stroke="${T.oceanB}" stroke-width="6.5" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none" opacity="0.6"></path><path d="${d}" stroke="${color}" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none"></path>`;
    }
    for (const { p, color } of pins) {
      if (!inside(p)) continue;
      overlay += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="17" fill="none" stroke="${color}" stroke-width="2" opacity="0.5"></circle><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="${color}" stroke="${T.accent}" stroke-width="3"></circle>`;
    }
    if (inside(pd)) {
      overlay += `<circle cx="${pd.x.toFixed(1)}" cy="${pd.y.toFixed(1)}" r="40" fill="${T.meet}" opacity="0.14"></circle><circle cx="${pd.x.toFixed(1)}" cy="${pd.y.toFixed(1)}" r="25" fill="${T.meet}" opacity="0.28"></circle><circle cx="${pd.x.toFixed(1)}" cy="${pd.y.toFixed(1)}" r="10" fill="${T.meet}" stroke="#fff" stroke-width="3"></circle>`;
    }

    // Labels: departures left of the meeting point get their label on the left,
    // the others on the right; labels on one side are nudged apart.
    const place = (side) => {
      const group = pins.filter((pin) => inside(pin.p) && (pin.p.x <= pd.x) === (side === "left")).sort((a, b) => a.p.y - b.p.y);
      let lastY = -999;
      for (const pin of group) {
        const y = Math.max(pin.p.y, lastY + 32);
        lastY = y;
        const name = pin.i === 0 ? `${pin.o.label} · You` : pins.length === 2 ? `${pin.o.label} · Them` : pin.o.label;
        const text = pin.o.count > 1 ? `${name} ×${pin.o.count}` : name;
        const transform = side === "left" ? "translate(-100%,-50%)" : "translate(0,-50%)";
        labels += `<div class="globe-label" style="left:${(pin.p.x + (side === "left" ? -20 : 20)).toFixed(0)}px;top:${y.toFixed(0)}px;transform:${transform}">${esc(text)}</div>`;
      }
    };
    place("left");
    place("right");
    if (inside(pd)) {
      labels += `<div class="globe-label is-dest" style="left:${pd.x.toFixed(0)}px;top:${(pd.y + 30).toFixed(0)}px;transform:translate(-50%,0)">${esc(selected.globeLabel ?? `${selected.destinationName} — meet here`)}</div>`;
    }
  }

  // A thin orbit ring behind the globe, a satellite dot, then the globe itself.
  const rx = R + 40, ry = R * 0.3, th = 0.35, rot = (-20 * Math.PI) / 180;
  const sx = cx + rx * Math.cos(th) * Math.cos(rot) - ry * Math.sin(th) * Math.sin(rot);
  const sy = cy + rx * Math.cos(th) * Math.sin(rot) + ry * Math.sin(th) * Math.cos(rot);

  // Sea, faint grid, countries, the meeting country, borders, then the pins.
  globeSvg.innerHTML = `
    <defs>
      <radialGradient id="ocean" cx="35%" cy="28%" r="85%"><stop offset="0" stop-color="${T.oceanA}"></stop><stop offset="1" stop-color="${T.oceanB}"></stop></radialGradient>
      <clipPath id="globe-clip"><circle cx="${cx}" cy="${cy}" r="${R}"></circle></clipPath>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(-20 ${cx} ${cy})" stroke="${T.orbit}" stroke-width="2" fill="none"></ellipse>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#ocean)"></circle>
    <g clip-path="url(#globe-clip)">
      <path d="${g.gridPath}" stroke="${T.grid}" stroke-width="1" fill="none"></path>
      <path d="${g.landPath}" fill="${T.land}"></path>
      <path d="${meetCountry}" fill="${T.meet}"></path>
      <path d="${g.bordersPath}" stroke="${T.borders}" stroke-width="0.8" stroke-linejoin="round" fill="none"></path>
      ${overlay}
    </g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2" pointer-events="none"></circle>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="7" fill="${T.meet}"></circle>`;
  labelsEl.innerHTML = labels;

  hintText = ready && destinations.length > 1 ? "Drag to turn · tap a dot to see another destination" : "";
  if (!hintTimer) showHint();
  $("globe-reset").hidden = state.globeView === null;
  $("zoom-in").disabled = shownView.zoom >= GLOBE_MAX_ZOOM - 0.01;
  $("zoom-out").disabled = shownView.zoom <= 1.01;
}

// The tip at the bottom of the globe (a short-lived one can replace it).
let hintText = "";
let hintTimer = 0;
function showHint() {
  $("map-hint").textContent = hintText;
  $("map-hint").hidden = !hintText;
}
function flashHint(text) {
  $("map-hint").textContent = text;
  $("map-hint").hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hintTimer = 0; showHint(); }, 1800);
}

// --- Turning and zooming the globe -----------------------------------------

let frame = 0;
function redrawGlobeSoon() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderGlobe(); });
}

// A drag of dx, dy pixels turns the globe under your finger.
function turnGlobe(dx, dy) {
  cancelAnimationFrame(flight);
  const v = state.globeView ?? shownView;
  const degPerPx = 180 / (Math.PI * GLOBE_RADIUS * v.zoom);
  state.globeView = { lat: clamp(v.lat + dy * degPerPx, -80, 80), lon: wrapLon(v.lon - dx * degPerPx), zoom: v.zoom };
  redrawGlobeSoon();
}

function zoomGlobe(factor) {
  cancelAnimationFrame(flight);
  const v = state.globeView ?? shownView;
  state.globeView = { ...v, zoom: clamp(v.zoom * factor, 1, GLOBE_MAX_ZOOM) };
  redrawGlobeSoon();
}

// Glide to a view (null = back to framing every result).
let flight = 0;
function flyGlobe(target) {
  cancelAnimationFrame(flight);
  const from = { ...shownView };
  const to = target ?? autoView();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    state.globeView = target;
    renderGlobe();
    return;
  }
  const dLon = wrapLon(to.lon - from.lon); // the short way round
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 500);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
    state.globeView = t < 1 ? { lat: from.lat + (to.lat - from.lat) * e, lon: wrapLon(from.lon + dLon * e), zoom: from.zoom + (to.zoom - from.zoom) * e } : target;
    renderGlobe();
    if (t < 1) flight = requestAnimationFrame(step);
  };
  flight = requestAnimationFrame(step);
}

// After picking a row in the table: if you had turned the globe away from
// that destination, glide back so it's in view.
function showOnGlobe(code) {
  const r = state.results.find((x) => x.destination === code);
  if (state.globeView && hasCoords(r) && !shownGlobe.inside(shownGlobe.project(r.lat, r.lon))) flyGlobe(null);
  else renderGlobe();
}

// Mouse and fingers: one pointer turns the globe, two pinch to zoom.
// A drag only starts after 5px, so a simple click/tap on a dot still selects it.
const pointers = new Map();
let dragged = false;
let pinchDistance = 0;

globeSvg.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
  if (pointers.size === 1) dragged = false;
  if (pointers.size === 2) {
    dragged = true;
    pinchDistance = 0;
    for (const id of pointers.keys()) globeSvg.setPointerCapture(id);
  }
});

globeSvg.addEventListener("pointermove", (event) => {
  const p = pointers.get(event.pointerId);
  if (!p) return;
  const scale = 520 / globeSvg.getBoundingClientRect().width; // the globe is drawn smaller on phones
  if (pointers.size >= 2) {
    p.x = event.clientX;
    p.y = event.clientY;
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDistance) zoomGlobe(distance / pinchDistance);
    pinchDistance = distance;
    return;
  }
  if (!dragged) {
    if (Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < 5) return;
    dragged = true;
    globeSvg.setPointerCapture(event.pointerId);
    globeWrap.classList.add("is-dragging");
  }
  turnGlobe((event.clientX - p.x) * scale, (event.clientY - p.y) * scale);
  p.x = event.clientX;
  p.y = event.clientY;
});

function endPointer(event) {
  if (!pointers.delete(event.pointerId)) return;
  pinchDistance = 0;
  if (pointers.size === 0) globeWrap.classList.remove("is-dragging");
}
globeSvg.addEventListener("pointerup", endPointer);
globeSvg.addEventListener("pointercancel", endPointer);

// Zoom with Ctrl/⌘ + scroll (that's also what a trackpad pinch sends). A plain
// scroll keeps scrolling the page, with a tip on how to zoom.
const ZOOM_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
globeSvg.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) {
    flashHint(`Hold ${ZOOM_KEY} and scroll to zoom — or use + and −`);
    return;
  }
  event.preventDefault();
  zoomGlobe(Math.exp(-clamp(event.deltaY, -50, 50) * 0.006));
}, { passive: false });

function zoomStep(factor) {
  const v = state.globeView ?? shownView;
  flyGlobe({ ...v, zoom: clamp(v.zoom * factor, 1, GLOBE_MAX_ZOOM) });
}
$("zoom-in").addEventListener("click", () => zoomStep(1.5));
$("zoom-out").addEventListener("click", () => zoomStep(1 / 1.5));
$("globe-reset").addEventListener("click", () => flyGlobe(null));

// Clicking (not dragging) a dot on the globe selects that destination and shows its row.
globeSvg.addEventListener("click", (event) => {
  if (dragged) return;
  const dot = event.target.closest(".dest-dot");
  if (dot) selectDestination(dot.dataset.code, { scrollToRow: true });
});

renderGlobe();
Geo.load().then(renderGlobe); // the countries arrive a moment later
