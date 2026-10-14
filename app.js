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
//   * The results fill the table (or the weekends strip); the world map behind
//     the page shows everyone's routes to the selected destination (geo.js
//     draws the countries).
//
// Sections:  1 Settings · 2 Small helpers · 3 Airport autocomplete + 3b Departures +
//            3c Going to · 4 Currency · 5 The "When" pop-up · 6 Searching +
//            6b The arrival-time rule (− / +) · 7 The results table ·
//            7b One destination · 7c Booking · 7d The trip page (after "Select") ·
//            8 The map
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

// The map's zoom (the size of the world: at 150 the whole world is ~800px wide).
const MAP_MIN_ZOOM = 140;  // how far you can zoom out
const MAP_MAX_ZOOM = 2400; // how far you can zoom in (about one country on screen)
const MAP_FIT_ZOOM = 1500; // how close it zooms by itself, so two nearby cities don't fill the screen

// "Everyone lands within ..." — the steps of the − / + buttons, in hours (0 = any).
const GAP_STEPS = [1, 2, 3, 4, 6, 0];

// What the page remembers between actions.
const state = {
  results: [],       // destinations returned by the last search
  origins: [],       // one { label, lat, lon, count } per departure of the last search
  sort: "cheapest",  // cheapest | fastest | stops
  selected: null,    // destination code of the highlighted row
  maxGapHours: 3,    // the arrival/return time rule ("Everyone lands within"); 0 = no limit
  searching: false,  // a search is on its way
  debug: null,       // the function's report on the last search (counts, failures...)
  currency: "usd",   // the currency the prices in `results` are actually in
  lastSearch: null,  // so a currency change or "Try again" can re-run the same search
  mapView: null,     // {k, tx, ty} once you drag/zoom the map; null = it frames everything itself
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
// its exact code (and position, for the map) on the input itself.
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
    cell.style.setProperty("--who", `var(--c${i % 8})`); // same colour as in the table and on the map
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
    : "Free · no account needed · you book directly on Aviasales";
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
  const common = { currency: currencySelect.value, maxGapHours: String(state.maxGapHours) };
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
    return `There are ${debug.rejectedByTimeGap} dates where everyone has a fare, but the arrival or return times are more than ${gapHours} hours apart. Press <strong>+</strong> next to “Everyone lands within” to allow a bigger gap, or try other dates.`;
  }
  const foundNone = reports.every((r) => !r.destinationsWithFares);
  const hint = foundNone
    ? "Travelpayouts has no cached fares at all for that stay length — try a different trip length."
    : "Everyone has some cached fares, they just never land on the same day — try a more common trip length (a full week tends to have more cached data than an odd number of nights).";
  const groupHint = n >= 3 ? ` With ${n} departures it is much harder for everyone to have a cached fare on the same day; fewer departures, or the ±1 night option, usually helps.` : "";
  return `Found ${debug.candidatesConsidered} destination${debug.candidatesConsidered === 1 ? "" : "s"} everyone can reach, but no cached fare matches your dates. ${hint}${groupHint}`;
}

let searchCounter = 0; // so an older, slower search can't overwrite a newer one

// After a search from the bar: bring the results up, so you see them — and
// the routes on the map behind — without having to scroll.
function revealResults() {
  const visibleTop = document.querySelector(".hero").getBoundingClientRect().bottom; // the results start under the banner
  if (visibleTop < window.innerHeight * 0.4) return; // already in view
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: window.scrollY + visibleTop, behavior: smooth ? "smooth" : "auto" });
}

// `reveal`: scroll to the results once they're in (searches from the bar).
async function runSearch(origins, params, { reveal = false } = {}) {
  // A new search (e.g. another currency) while a trip page is open: back to the list.
  if (!tripPageEl.hidden) {
    closeTripPage();
    if (history.state?.tripPage) history.replaceState(null, "", location.pathname + location.search);
  }
  const thisSearch = ++searchCounter;
  state.lastSearch = { origins, params };
  state.maxGapHours = Number(params.maxGapHours);
  state.searching = true;
  state.debug = null;
  state.trip = null;
  setResultsMode(Boolean(params.destination));
  updateWarning();
  renderGapBar();
  showMessage("Searching… (this can take a few seconds)");
  searchButton.disabled = true;

  try {
    const json = await callSearchFunction(origins, params);
    if (thisSearch !== searchCounter) return;

    // Names and positions for the departures (for the table and the map's labels).
    state.origins = origins.map((o, i) => {
      const server = json.origins?.[i] ?? {};
      return { label: o.label || server.name || o.code, code: o.code, lat: o.lat ?? server.lat, lon: o.lon ?? server.lon, count: o.count };
    });
    state.debug = json.debug;
    state.currency = json.currency || params.currency; // what the prices are really in
    state.selected = null;
    state.mapView = null; // new results: let the map frame them again
    state.searching = false;

    if (json.mode === "trip") {
      state.results = [];
      showTrip(json);
      return;
    }
    state.results = json.results;
    if (json.results.length === 0) {
      showMessage(explainEmptyResult(json.debug, state.maxGapHours));
      renderMap();
      return;
    }
    renderTable();
  } catch (error) {
    if (thisSearch !== searchCounter) return;
    state.results = [];
    showMessage(esc(error.message), true);
    renderMap();
  } finally {
    if (thisSearch === searchCounter) {
      state.searching = false;
      searchButton.disabled = false;
      renderGapBar();
      if (reveal) revealResults();
    }
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
  runSearch(departures, params, { reveal: true });
});


// ===========================================================================
// 6b. THE ARRIVAL-TIME RULE — "Everyone lands within [−] 3 h [+]"
// ===========================================================================
// So nobody waits alone at the airport for hours: everyone's arrivals (and
// return flights) must be within this many hours of each other. It sits next
// to the results; changing it re-runs the search (quick: the server remembers
// its answers). With a destination chosen, the answer already holds the
// options that were just over the limit, so we can say what a looser rule
// would add ("Allow 4 h → +2 weekends").

const gapLabel = (hours) => (hours > 0 ? `${hours} h` : "Any");
const allowLabel = (hours) => (hours > 0 ? `Allow ${hours} h` : "Allow any gap");
const gapStep = () => Math.max(0, GAP_STEPS.indexOf(state.maxGapHours));

// "12 trips found", "7 of 10 weekends work"... (null before the first search)
function gapFoundText() {
  if (state.searching) return "searching…";
  if (!state.lastSearch) return null;
  const trip = state.trip;
  if (trip) {
    if (trip.windows.length > 1) {
      const working = trip.windows.filter(cheapestOption).length;
      return `${working} of ${trip.windows.length} ${stayWords(trip).plural} work`;
    }
    const working = trip.windows[0]?.options.filter((o) => o.status === "ok").length ?? 0;
    return working ? `${working} option${working === 1 ? "" : "s"} work` : "nothing works yet";
  }
  const n = state.results.length;
  return n ? `${n} trip${n === 1 ? "" : "s"} found` : "no trip found yet";
}

// The link offering a looser rule, when it would help (null = hide it).
function gapMoreText() {
  if (state.searching || !state.lastSearch || state.maxGapHours === 0) return null;
  const next = GAP_STEPS[gapStep() + 1];
  const trip = state.trip;
  if (!trip) {
    // Anywhere: we only know that some dates were turned down for their times.
    return state.debug?.rejectedByTimeGap > 0 ? { hours: next, text: `${allowLabel(next)} for more trips →` } : null;
  }
  // One destination: find the first looser step that adds a weekend or lowers a price.
  const words = stayWords(trip);
  for (const hours of GAP_STEPS.slice(gapStep() + 1)) {
    const fits = (o) => o.status === "ok" || (o.status === "gap" && (hours === 0 || (o.arrivalGapHours <= hours && o.returnGapHours <= hours)));
    let addedWindows = 0;
    let bestSaving = 0;
    for (const w of trip.windows) {
      const now = cheapestOption(w)?.total ?? null;
      const later = Math.min(...w.options.filter(fits).map((o) => o.total));
      if (now === null && later < Infinity) addedWindows++;
      else if (now !== null && later < now) bestSaving = Math.max(bestSaving, now - later);
    }
    const gains = [
      addedWindows && `+${addedWindows} ${addedWindows === 1 ? words.unit : words.plural}`,
      bestSaving && `up to ${formatPrice(bestSaving, state.currency)} less`,
    ].filter(Boolean);
    if (gains.length) return { hours, text: `${allowLabel(hours)} → ${gains.join(", ")}` };
  }
  return null;
}

function renderGapBar() {
  const step = gapStep();
  $("gap-value").textContent = gapLabel(state.maxGapHours);
  $("gap-minus").disabled = step === 0;
  $("gap-plus").disabled = step === GAP_STEPS.length - 1;
  // Before a search: "... 3 h of each other · applies to your search"; after: "... 3 h · 12 trips found".
  const found = gapFoundText();
  const lead = state.maxGapHours > 0 ? "of each other" : "no limit";
  $("gap-hint").textContent = found === null ? `${lead} · applies to your search` : state.maxGapHours > 0 ? found : `${lead} · ${found}`;
  const more = gapMoreText();
  $("gap-more").hidden = !more;
  $("gap-more").textContent = more?.text ?? "";
  $("gap-more").dataset.hours = more?.hours ?? "";
}

// A change waits a moment, so pressing + twice runs one search, not two.
const searchWithGap = debounce(() => {
  if (state.lastSearch) runSearch(state.lastSearch.origins, { ...state.lastSearch.params, maxGapHours: String(state.maxGapHours) });
}, 450);

function setGap(hours) {
  if (hours === state.maxGapHours) return;
  state.maxGapHours = hours;
  if (state.lastSearch) state.searching = true; // the counts shown are for the old rule
  renderGapBar();
  searchWithGap();
}

$("gap-minus").addEventListener("click", () => setGap(GAP_STEPS[Math.max(0, gapStep() - 1)]));
$("gap-plus").addEventListener("click", () => setGap(GAP_STEPS[Math.min(GAP_STEPS.length - 1, gapStep() + 1)]));
$("gap-more").addEventListener("click", (event) => setGap(Number(event.currentTarget.dataset.hours)));


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
function setResultsMode(trip) {
  document.querySelector(".table-head").hidden = trip;
  $("sort-chips").hidden = trip;
  $("trip-chips").hidden = !trip;
  if (!trip) $("results-title").textContent = "Ranked meeting spots";
}

function renderTable() {
  const list = sortedResults();
  if (!list.some((r) => r.destination === state.selected)) state.selected = list[0].destination;

  rowsEl.innerHTML = list.map((r, i) => rowHtml(r, i, state.currency)).join("");

  // (The time rule isn't repeated here: "Everyone lands within" shows it.)
  const d = state.debug;
  const checkedText = d && d.sharedDestinations ? ` (checked ${d.candidatesConsidered} of the ${d.sharedDestinations} everyone can reach)` : "";
  const currencyText = d && d.currencyConverted === false ? " · prices shown in USD (exchange rates unavailable)" : "";
  $("results-subtitle").textContent = `Showing ${list.length} destination${list.length === 1 ? "" : "s"}${checkedText} · same dates for everyone${currencyText}`;
  updateWarning();
  renderMap();
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
  showOnMap(code);
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
    showTripOnMap(null);
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
  const currencyText = state.debug?.currencyConverted === false ? " · prices shown in USD (exchange rates unavailable)" : "";
  $("results-title").textContent = `${trip.destination.name}, together`;
  $("results-subtitle").textContent = `${what} · total for ${peopleLabel(people)} · same dates for everyone${currencyText}`;
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

  const insight = tripInsight(w, words);
  renderTripHeader();
  rowsEl.innerHTML = `
    <div class="trip">
      ${several ? stripHtml(trip, words) : ""}
      <div class="${several ? "trip-section" : ""}">
        <div class="block-title"><strong>${words.same}</strong><span>${dateRange(from, to)} · cheapest first</span></div>
        ${insight ? `<p class="trip-insight">${insight}</p>` : ""}
        <div class="alts">${w.options.map((o, i) => altHtml(o, i, w, trip)).join("")}</div>
        ${option?.status === "ok"
          ? tripBoxHtml(option)
          : `<div class="state-message">No option this ${words.unit} works for everyone yet — pick another ${words.unit} above.</div>`}
      </div>
    </div>`;
  showTripOnMap(option?.status === "ok" ? option : null);
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

// The money tip for the selected weekend, above its options ("" = none).
function tripInsight(w, words) {
  const cheapest = cheapestOption(w);
  const usual = usualOption(w);
  if (!cheapest) return "";
  if (usual && cheapest !== usual && cheapest.total < usual.total) {
    const extra = cheapest.nights > usual.nights ? " One more night, and you pay less." : "";
    return `<strong>${daysLabel(cheapest)} saves you ${formatPrice(usual.total - cheapest.total, state.currency)}</strong> compared with ${daysLabel(usual)}.${extra}`;
  }
  if (usual && cheapest === usual) return `<strong>${daysLabel(usual)} is already the cheapest choice that ${words.unit}.</strong> We only show dates that work for everyone.`;
  return `<strong>Cheapest that ${words.unit}: ${daysLabel(cheapest)}.</strong> We only show dates that work for everyone.`;
}

// The map shows the destination with everyone's flight paths.
function showTripOnMap(option) {
  const d = state.trip.destination;
  const sameAsInput = goingInput.dataset.code === d.code;
  state.results = [{
    destination: d.code,
    destinationName: d.name,
    country: d.country,
    lat: d.lat ?? (sameAsInput ? Number(goingInput.dataset.lat) : null),
    lon: d.lon ?? (sameAsInput ? Number(goingInput.dataset.lon) : null),
    total: option?.total ?? 0,
    mapLabel: option ? `${d.name} · ${dateRange(option.departDate, option.returnDate)}` : d.name,
  }];
  state.selected = d.code;
  renderMap();
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
    return `Everyone has fares to ${name} on ${d.rejectedByGap} of these dates, but the arrival or return times are more than ${state.maxGapHours} hours apart. Press <strong>+</strong> next to “Everyone lands within” to allow a bigger gap, or try another kind of stay.`;
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
// stay...). It takes the place of the list (the map stays); "Back to
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
        <div class="hero-badge">YOUR TRIP</div>
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
// 8. THE MAP
// ===========================================================================
// A flat world map behind the page. On wide screens it fills the window and
// stays put while you scroll: you see it, drag it and zoom it in the open
// space right of the results. On narrower screens it is a block under the
// results. It shows everyone's route to the selected destination, and every
// other result as a dot you can click.

// The map's colours come from the variables at the top of styles.css
// (--map-sea, --map-land, --c0 ... --c7, ...), so changing the theme there
// re-colours the map too.
let themeCache = null;
function themeColors() {
  if (themeCache) return themeCache;
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();
  themeCache = {
    sea: v("--map-sea"), land: v("--map-land"), borders: v("--map-borders"), grid: v("--map-grid"),
    meet: v("--action"),
    pins: Array.from({ length: 8 }, (_, i) => v(`--c${i}`)),
  };
  return themeCache;
}

const hasCoords = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const px = (n) => n.toFixed(1);

const mapLayer = $("map-layer");
const mapSvg = $("map");
let shownView = null; // what the map shows right now: {k, tx, ty}
let shownMap = null;  // ...and its projection (to test what's in view)

// Behind the whole page (wide screens), or a block under the results?
const mapIsBackground = () => getComputedStyle(mapLayer).position === "fixed";

// The part of the map you can really see, [[left, top], [right, bottom]] in
// the map's pixels: right of the results on wide screens (the table covers the
// left), the whole block otherwise. Room is left on the sides for the labels.
function openArea() {
  const w = mapLayer.clientWidth;
  const h = mapLayer.clientHeight;
  if (!mapIsBackground()) {
    const side = Math.min(110, w * 0.18);
    return [[side, 50], [w - side, h - 60]];
  }
  const left = document.querySelector(".map-col").getBoundingClientRect().left;
  return [[left + 100, h * 0.2], [w - 110, h * 0.84]];
}

const areaCentre = ([[left, top], [right, bottom]]) => [(left + right) / 2, (top + bottom) / 2];

// The view zoomed to `k` (within the limits), keeping the point at (x, y) in place.
function zoomedView(v, k, x, y) {
  const nextK = clamp(k, MAP_MIN_ZOOM, MAP_MAX_ZOOM);
  return { k: nextK, tx: x - (x - v.tx) * (nextK / v.k), ty: y - (y - v.ty) * (nextK / v.k) };
}

// Don't let the world slide right off the screen.
function keepInView(v) {
  const w = mapLayer.clientWidth;
  const h = mapLayer.clientHeight;
  const halfWidth = 2.74 * v.k;  // half the width of the world on this map
  const halfHeight = 1.43 * v.k; // ...and half its height
  return { k: v.k, tx: clamp(v.tx, 120 - halfWidth, w - 120 + halfWidth), ty: clamp(v.ty, 120 - halfHeight, h - 120 + halfHeight) };
}

// Where the map looks when you haven't moved it: every departure AND every
// result in view, so all the options are there at once and it doesn't jump
// when you pick another one. No search yet: Europe and the Atlantic, in the
// open space below the banner (what you see when the page opens).
const DEFAULT_POINTS = [{ lat: 30, lon: -25 }, { lat: 62, lon: 35 }];

function autoView() {
  const origins = state.origins ?? [];
  const destinations = state.results.filter(hasCoords);
  const hasRoutes = destinations.length > 0 && origins.length > 0 && origins.every(hasCoords);
  const area = openArea();
  if (!hasRoutes && mapIsBackground()) {
    const h = mapLayer.clientHeight;
    const bannerBottom = document.querySelector(".hero").getBoundingClientRect().bottom;
    if (bannerBottom > 0 && bannerBottom < h * 0.75) {
      area[0] = [area[0][0] - 60, Math.max(area[0][1], bannerBottom + 30)];
      area[1] = [area[1][0] + 50, h - 30];
    }
  }
  const fitted = Geo.fitView(hasRoutes ? [...origins, ...destinations] : DEFAULT_POINTS, area, MAP_FIT_ZOOM);
  return zoomedView(fitted, fitted.k, ...areaCentre(area));
}

// A route: a gentle curve from a departure to the meeting point, bowing upwards.
function routePath([x1, y1], [x2, y2]) {
  let nx = y1 - y2;
  let ny = x2 - x1;
  if (ny > 0) [nx, ny] = [-nx, -ny];
  const cx = (x1 + x2) / 2 + nx * 0.22;
  const cy = (y1 + y2) / 2 + ny * 0.22;
  return `M${px(x1)} ${px(y1)} Q${px(cx)} ${px(cy)} ${px(x2)} ${px(y2)}`;
}

const ZOOM_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

function renderMap() {
  const w = mapLayer.clientWidth;
  const h = mapLayer.clientHeight;
  if (!w || !h) return;
  const T = themeColors();

  const origins = state.origins ?? [];
  const destinations = state.results.filter(hasCoords);
  const selected = destinations.find((r) => r.destination === state.selected);
  const ready = selected && origins.length > 0 && origins.every(hasCoords);

  shownView = state.mapView ?? autoView();
  const m = (shownMap = Geo.createMap(shownView, w, h));
  const onScreen = ([x, y]) => x > -40 && x < w + 40 && y > -40 && y < h + 40;

  let overlay = "";
  let labels = "";
  if (ready) {
    const pd = m.project(selected.lat, selected.lon);
    const pins = origins.map((o, i) => ({ o, i, p: m.project(o.lat, o.lon), color: T.pins[i % 8] }));
    const [middleX] = areaCentre(openArea());

    // 1. Every other result: a small dot you can hover (name + price) and click.
    for (const r of destinations) {
      if (r.destination === selected.destination) continue;
      const [x, y] = m.project(r.lat, r.lon);
      if (!onScreen([x, y])) continue;
      const left = x > middleX; // the hover label goes on the side facing the middle
      overlay += `
        <g class="dest-dot" data-code="${esc(r.destination)}">
          <circle cx="${px(x)}" cy="${px(y)}" r="13" fill="transparent"></circle>
          <circle class="dot-core" cx="${px(x)}" cy="${px(y)}" r="5.5" fill="${T.meet}" stroke="#fff" stroke-width="2"></circle>
          <text class="dot-label" x="${px(x + (left ? -12 : 12))}" y="${px(y + 4)}" text-anchor="${left ? "end" : "start"}">${esc(r.destinationName)} · ${formatPrice(r.total, state.currency)}</text>
        </g>`;
    }

    // 2. The selected destination: dotted routes from every departure (with a
    //    white rim, so they show on land and sea), the departure pins, then
    //    the meeting point.
    for (const { p, color } of pins) {
      const d = routePath(p, pd);
      overlay += `<path d="${d}" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none" opacity="0.9"></path><path d="${d}" stroke="${color}" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none"></path>`;
    }
    for (const { p: [x, y], color } of pins) {
      overlay += `<circle cx="${px(x)}" cy="${px(y)}" r="16" fill="none" stroke="${color}" stroke-width="2" opacity="0.45"></circle><circle cx="${px(x)}" cy="${px(y)}" r="7" fill="${color}" stroke="#fff" stroke-width="3"></circle>`;
    }
    const [dx, dy] = pd;
    overlay += `<circle cx="${px(dx)}" cy="${px(dy)}" r="40" fill="${T.meet}" opacity="0.16"></circle><circle cx="${px(dx)}" cy="${px(dy)}" r="24" fill="${T.meet}" opacity="0.3"></circle><circle cx="${px(dx)}" cy="${px(dy)}" r="10" fill="${T.meet}" stroke="#fff" stroke-width="3"></circle>`;

    // Labels: a departure left of the meeting point gets its label on the left,
    // the others on the right — unless it would run off the map. Labels on
    // one side are nudged apart.
    const labelWidth = (text) => text.length * 7.6 + 30; // about right for the 13px labels
    const labelled = pins.filter((pin) => onScreen(pin.p)).map((pin) => {
      const name = pin.i === 0 ? `${pin.o.label} · You` : pins.length === 2 ? `${pin.o.label} · Them` : pin.o.label;
      const text = pin.o.count > 1 ? `${name} ×${pin.o.count}` : name;
      let side = pin.p[0] <= dx ? "left" : "right";
      if (side === "right" && pin.p[0] + 20 + labelWidth(text) > w - 8) side = "left";
      else if (side === "left" && pin.p[0] - 20 - labelWidth(text) < 8) side = "right";
      return { ...pin, text, side };
    });
    for (const side of ["left", "right"]) {
      let lastY = -999;
      for (const pin of labelled.filter((x) => x.side === side).sort((a, b) => a.p[1] - b.p[1])) {
        const y = Math.max(pin.p[1], lastY + 32);
        lastY = y;
        const transform = side === "left" ? "translate(-100%,-50%)" : "translate(0,-50%)";
        labels += `<div class="map-label" style="left:${(pin.p[0] + (side === "left" ? -20 : 20)).toFixed(0)}px;top:${y.toFixed(0)}px;transform:${transform}">${esc(pin.text)}</div>`;
      }
    }
    if (onScreen(pd)) {
      const text = selected.mapLabel ?? `${selected.destinationName} — meet here`;
      const half = labelWidth(text) / 2;
      const x = half * 2 + 16 < w ? clamp(dx, half + 8, w - half - 8) : dx; // kept on the map
      labels += `<div class="map-label is-dest" style="left:${x.toFixed(0)}px;top:${(dy + 30).toFixed(0)}px;transform:translate(-50%,0)">${esc(text)}</div>`;
    }
  }

  // Sea, a faint grid, the land (its coast in the border colour), the borders, then the routes.
  mapSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  mapSvg.innerHTML = `
    <rect width="${w}" height="${h}" fill="${T.sea}"></rect>
    <path d="${m.gridPath}" stroke="${T.grid}" stroke-width="1" fill="none"></path>
    <path d="${m.landPath}" fill="${T.land}" stroke="${T.borders}" stroke-width="0.8" stroke-linejoin="round"></path>
    <path d="${m.bordersPath}" stroke="${T.borders}" stroke-width="0.6" stroke-linejoin="round" fill="none"></path>
    ${overlay}`;
  $("map-labels").innerHTML = labels;

  $("map-hint").textContent = ready && destinations.length > 1 ? "Drag to explore · click a dot to see another place" : `Drag to explore · ${ZOOM_KEY} + scroll to zoom`;
  $("map-reset").hidden = state.mapView === null;
  $("zoom-in").disabled = shownView.k >= MAP_MAX_ZOOM - 1;
  $("zoom-out").disabled = shownView.k <= MAP_MIN_ZOOM + 1;
}

// --- Dragging and zooming the map -------------------------------------------

let frame = 0;
function redrawMapSoon() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderMap(); });
}

function moveMap(dx, dy) {
  cancelAnimationFrame(flight);
  const v = state.mapView ?? shownView;
  state.mapView = keepInView({ k: v.k, tx: v.tx + dx, ty: v.ty + dy });
  redrawMapSoon();
}

// Zoom by `factor`, keeping the point at (x, y) — the cursor, the pinch — in place.
function zoomMapAt(factor, x, y) {
  cancelAnimationFrame(flight);
  const v = state.mapView ?? shownView;
  state.mapView = keepInView(zoomedView(v, v.k * factor, x, y));
  redrawMapSoon();
}

// Glide to a view (null = back to framing every result).
let flight = 0;
function flyMap(target) {
  cancelAnimationFrame(flight);
  const from = { ...shownView };
  const to = target ?? autoView();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    state.mapView = target;
    renderMap();
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 500);
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease in and out
    state.mapView = t < 1 ? { k: from.k + (to.k - from.k) * e, tx: from.tx + (to.tx - from.tx) * e, ty: from.ty + (to.ty - from.ty) * e } : target;
    renderMap();
    if (t < 1) flight = requestAnimationFrame(step);
  };
  flight = requestAnimationFrame(step);
}

// After picking a row in the table: if you had moved the map away from that
// destination, glide back so it's in view.
function showOnMap(code) {
  const r = state.results.find((x) => x.destination === code);
  const [[left, top], [right, bottom]] = openArea();
  const inView = ([x, y]) => x >= left - 60 && x <= right + 60 && y >= top - 60 && y <= bottom + 60;
  if (state.mapView && hasCoords(r) && !inView(shownMap.project(r.lat, r.lon))) flyMap(null);
  else renderMap();
}

// Mouse and fingers: one pointer drags the map, two pinch to zoom.
// A drag only starts after 5px, so a simple click/tap on a dot still selects it.
const pointers = new Map();
let dragged = false;
let pinchDistance = 0;

mapSvg.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
  if (pointers.size === 1) dragged = false;
  if (pointers.size === 2) {
    dragged = true;
    pinchDistance = 0;
    for (const id of pointers.keys()) mapSvg.setPointerCapture(id);
  }
});

mapSvg.addEventListener("pointermove", (event) => {
  const p = pointers.get(event.pointerId);
  if (!p) return;
  if (pointers.size >= 2) {
    p.x = event.clientX;
    p.y = event.clientY;
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const rect = mapSvg.getBoundingClientRect();
    if (pinchDistance) zoomMapAt(distance / pinchDistance, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
    pinchDistance = distance;
    return;
  }
  if (!dragged) {
    if (Math.hypot(event.clientX - p.startX, event.clientY - p.startY) < 5) return;
    dragged = true;
    mapSvg.setPointerCapture(event.pointerId);
    mapLayer.classList.add("is-dragging");
  }
  moveMap(event.clientX - p.x, event.clientY - p.y);
  p.x = event.clientX;
  p.y = event.clientY;
});

function endPointer(event) {
  if (!pointers.delete(event.pointerId)) return;
  pinchDistance = 0;
  if (pointers.size === 0) mapLayer.classList.remove("is-dragging");
}
mapSvg.addEventListener("pointerup", endPointer);
mapSvg.addEventListener("pointercancel", endPointer);

// Zoom with Ctrl/⌘ + scroll (that's also what a trackpad pinch sends). A plain
// scroll keeps scrolling the page — the map is its background.
mapSvg.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const rect = mapSvg.getBoundingClientRect();
  zoomMapAt(Math.exp(-clamp(event.deltaY, -50, 50) * 0.006), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

// + and − zoom around the middle of the open space.
function zoomStep(factor) {
  const v = state.mapView ?? shownView;
  flyMap(keepInView(zoomedView(v, v.k * factor, ...areaCentre(openArea()))));
}
$("zoom-in").addEventListener("click", () => zoomStep(1.6));
$("zoom-out").addEventListener("click", () => zoomStep(1 / 1.6));
$("map-reset").addEventListener("click", () => flyMap(null));

// Clicking (not dragging) a dot selects that destination and shows its row.
mapSvg.addEventListener("click", (event) => {
  if (dragged || !tripPageEl.hidden) return;
  const dot = event.target.closest(".dest-dot");
  if (dot) selectDestination(dot.dataset.code, { scrollToRow: true });
});

window.addEventListener("resize", redrawMapSoon);

renderGapBar();
renderMap();
Geo.load().then(renderMap); // the countries arrive a moment later
