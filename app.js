// ---------------------------------------------------------------------------
// Halfway Trips — the page's behaviour
//
// How it fits together:
//   * You pick two or more departures (live autocomplete, with how many people leave
//     from each) and when you want to travel — and, if you already know where
//     to go, a destination ("Going to"; empty = Anywhere).
//   * The page asks our small Supabase Edge Function (supabase/functions/
//     search-flights) for matching destinations (or, with a destination, for
//     the cheapest dates). That function holds the Travelpayouts token safely
//     on the server — this file never sees it.
//   * The results fill the table (or the weekends strip) in two kinds: exact
//     matches (flights for everyone on dates that work together) and "good
//     places" (cheap flights for everyone, just not on the same dates yet —
//     "Choose dates" compares the coming weeks there, then each traveller
//     opens Aviasales for the live prices). The world map behind the page
//     shows everyone's routes to the selected destination (geo.js draws the
//     countries).
//
// Sections:  1 Settings · 2 Small helpers · 3 Airport autocomplete + 3b Departures +
//            3c Going to · 4 Currency · 5 The "When" pop-up · 6 Searching +
//            6b The arrival-time rule (− / +) · 7 The results (exact matches,
//            good places) · 7b One destination · 7c Booking · 7d The trip page
//            (after "Select") · 7e A good place (after "Choose dates") ·
//            8 The map (with, at its end, the full-screen map on phones)
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
// A search that finds nothing within the limit tries the next steps by itself.
const GAP_STEPS = [1, 2, 3, 4, 5, 6, 0];

// Short stays (up to this many nights, e.g. a weekend) keep a strict rule —
// arrivals AND flights home close together — and widen it by themselves to
// SHORT_STAY_MAX_GAP hours at most: leaving hours apart would cost a day.
// (Longer stays only time the arrivals, and someone may arrive or leave a day
// apart: the search function decides that.)
const SHORT_STAY_NIGHTS = 3;
const SHORT_STAY_MAX_GAP = 4;

// How many rows the results show before a "Show N more" button: exact matches
// (fewer on phones when good places follow, so they aren't far down), then good places.
const EXACT_SHOWN = 10;
const EXACT_SHOWN_PHONE = 3;
const GOOD_SHOWN = 8;

// What the page remembers between actions.
const state = {
  results: [],       // destinations returned by the last search (exact matches)
  goodPlaces: [],    // ...and the good places: cheap for everyone, not on the same dates yet
  exactShown: EXACT_SHOWN, // how many of each are shown ("Show N more" adds the rest)
  goodShown: GOOD_SHOWN,
  origins: [],       // one { label, lat, lon, count } per departure of the last search
  sort: "cheapest",  // cheapest | fastest | stops
  selected: null,    // destination code of the highlighted row
  maxGapHours: 3,    // the arrival/return time rule ("Everyone lands within"); 0 = no limit
  widenedFrom: null, // the limit the last search started from, when it had to allow more
  searching: false,  // a search is on its way
  searchedOnce: false, // the "Everyone lands within" bar appears after the first search
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
const MONTH_FORMAT = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const monthName = (month) => MONTH_FORMAT.format(new Date(`${month}-01T00:00:00Z`)); // "2026-11" -> "Nov"

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

// Visitor statistics (Umami, loaded in index.html): counts what people do —
// searches, "Select", "Book on Aviasales" — without cookies and without
// anything personal. It quietly does nothing when the script isn't there
// (blocked by an ad blocker, or on your own computer: it only runs on the live site).
function track(name, data) {
  try {
    window.umami?.track(name, data);
  } catch {
    // statistics must never break the page
  }
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
  // At most 3 side by side (2 on phones, where the cells are more compact), and
  // only as many as fit (~165px each, ~120px on phones) so the names stay readable.
  const phone = window.matchMedia("(max-width: 860px)").matches;
  const fit = Math.max(1, Math.floor(originsEl.clientWidth / (phone ? 120 : 165)));
  const cols = Math.min(n <= 3 ? n : n === 4 ? 2 : 3, fit, phone ? 2 : 3);
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
  $("bar-hint").classList.toggle("is-trust", !chosen); // the "Free ·" line is left out on phones
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

// Coming from a card on the Destinations page ("index.html?to=LIS&name=Lisbon"):
// "Going to" is already filled in. The search's place position comes from the
// server, so the code and the name are enough.
const linkedPlace = new URLSearchParams(location.search);
if (/^[A-Z]{3}$/.test(linkedPlace.get("to") ?? "")) {
  const code = linkedPlace.get("to");
  const name = (linkedPlace.get("name") || code).slice(0, 60);
  goingInput.value = `${name} (${code})`;
  Object.assign(goingInput.dataset, { code, label: name });
}
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
  runSearch(state.lastSearch.origins, { ...state.lastSearch.params, currency: currencySelect.value }, { source: "currency" });
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

// While a search runs: a line that changes every few seconds and a bar that
// slowly fills, so it's clear something is happening — a search can take up
// to ~20 seconds. (The steps follow the clock: the function answers once, at
// the end, so they say what it is doing in general, not how far it got.)
const PROGRESS_STEP_MS = 3000;
let progressTimer = 0;

function searchSteps(params, departures) {
  const you = departures === 2 ? "both" : "all";
  if (params.destination) {
    const which = params.mode === "specific" ? "your dates"
      : params.trip === "weekend" ? "the coming weekends"
      : params.trip === "long" ? "the coming long weekends"
      : "the coming weeks";
    return [
      `Looking at ${which}…`,
      `Pricing each one for you ${you}…`,
      "Trying a day earlier or later…",
      "Comparing everyone's arrival times…",
      "Almost there…",
    ];
  }
  return [
    `Finding places you can ${you} fly to…`,
    "Checking the dates for each place…",
    `Looking for days that work for you ${you}…`,
    "Comparing everyone's arrival times…",
    "Adding up the prices…",
    "Almost there…",
  ];
}

function showProgress(steps) {
  clearInterval(progressTimer);
  rowsEl.innerHTML = `
    <div class="search-progress">
      <div class="sp-bar" aria-hidden="true"><span></span></div>
      <p class="sp-text" aria-live="off">${esc(steps[0])}</p>
      <p class="sp-note">This can take up to 20 seconds.</p>
    </div>`;
  let step = 0;
  progressTimer = setInterval(() => {
    const text = rowsEl.querySelector(".sp-text");
    if (!text) return clearInterval(progressTimer); // the results are in
    if (step >= steps.length - 1) return; // stays on "Almost there…"
    showProgressText(steps[++step]);
  }, PROGRESS_STEP_MS);
}

// A new line under the bar (it fades in). `hold`: keep it until the answer
// comes, e.g. "… trying 4 h" while the time rule widens.
function showProgressText(text, { hold = false } = {}) {
  if (hold) clearInterval(progressTimer);
  const el = rowsEl.querySelector(".sp-text");
  if (!el) return showMessage(esc(text));
  el.textContent = text;
  el.classList.remove("is-new");
  void el.offsetWidth; // restart the fade
  el.classList.add("is-new");
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

// A search from the bar: bring the results box up — as soon as it starts (its
// progress bar), and again at the end if you scrolled back up — so you see
// them, and the routes on the map behind, without having to scroll.
function revealResults() {
  const visibleTop = document.querySelector(".hero").getBoundingClientRect().bottom; // the results start under the banner
  if (visibleTop < window.innerHeight * 0.4) return; // already in view
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: window.scrollY + visibleTop, behavior: smooth ? "smooth" : "auto" });
}

// A search, for the statistics: its shape and how it went (nothing personal).
function searchStats(origins, params, source, failed, startGap) {
  const found = failed ? 0 : state.trip ? state.trip.windows.filter(cheapestOption).length : state.results.length;
  const good = failed ? 0 : state.goodPlaces.length;
  const nights = params.weekendOnly ? `${params.nights} nights, weekend` : `${params.nights} nights`;
  return {
    source, // bar · gap · stay · currency · retry
    kind: params.destination ? "destination" : "anywhere",
    from: origins.map((o) => o.code).join(","),
    to: params.destination ?? "anywhere",
    departures: origins.length,
    travellers: origins.reduce((sum, o) => sum + o.count, 0),
    when: params.mode === "specific" ? "dates" : params.trip ?? nights,
    gap: gapLabel(Number(params.maxGapHours)), // the limit the results are for...
    startGap: gapLabel(startGap),              // ...and the one the search started from
    found, // places (anywhere) or weekends that work (destination)
    good,  // good places (anywhere): cheap for everyone, not on the same dates
    dayApart: state.results.filter((r) => r.daysApart).length, // of those, with someone a day apart
    outcome: failed ? "error" : found > 0 ? "results" : good > 0 ? "good-places" : "none",
  };
}

// Searches that widen the time rule by themselves when nothing fits it. Not
// the − / + buttons (a deliberate choice), nor a currency change (it keeps
// the limit the search already ended on).
const WIDEN_SOURCES = new Set(["bar", "stay", "retry"]);

// The stay a search asks for, in nights, and whether it is a short one.
const stayNights = (params) => (params.mode === "specific" ? daysBetween(params.departDate, params.returnDate) : Number(params.nights));
const isShortStay = (params) => stayNights(params) <= SHORT_STAY_NIGHTS;

// The looser limits worth trying or offering after `hours` ("any" comes last;
// short stays stop at SHORT_STAY_MAX_GAP).
function looserGaps(hours, params) {
  const steps = GAP_STEPS.filter((step) => step === 0 || step > hours);
  return isShortStay(params) ? steps.filter((step) => step !== 0 && step <= SHORT_STAY_MAX_GAP) : steps;
}

// How far apart an option's times are, the way the rule counts them: short
// stays count arrivals and flights home, longer stays only arrivals.
const gapOf = (o, params) => (isShortStay(params) ? Math.max(o.arrivalGapHours, o.returnGapHours) : o.arrivalGapHours);

// When a search found nothing only because arrival or return times were too
// far apart: the next limit worth trying (null = nothing left to try).
function widerGap(json, hours, params) {
  if (hours === 0) return null;
  const looser = looserGaps(hours, params);
  if (json.mode === "trip") {
    // The answer holds the options that were just over the limit, so we know
    // straight away which limit makes at least one of them work.
    if (json.windows.some((w) => w.options.some((o) => o.status === "ok"))) return null;
    const gaps = json.windows.flatMap((w) => w.options).filter((o) => o.status === "gap").map((o) => gapOf(o, params));
    if (gaps.length === 0) return null;
    const needed = Math.min(...gaps);
    return looser.find((step) => step === 0 || step >= needed) ?? null;
  }
  if (json.results.length > 0 || !(json.debug?.rejectedByTimeGap > 0)) return null;
  return looser[0] ?? null;
}

// `reveal`: scroll to the results once they're in (searches from the bar).
// `source`: what started the search, for the statistics.
async function runSearch(origins, params, { reveal = false, source = "bar" } = {}) {
  // A new search (e.g. another currency) while a trip page is open: back to the list.
  if (!tripPageEl.hidden) {
    closeTripPage();
    if (history.state?.tripPage) history.replaceState(null, "", location.pathname + location.search);
  }
  const thisSearch = ++searchCounter;
  let failed = false;
  const startGap = Number(params.maxGapHours);
  state.lastSearch = { origins, params };
  state.maxGapHours = startGap;
  if (source !== "currency") state.widenedFrom = null;
  state.searching = true;
  state.debug = null;
  state.trip = null;
  setResultsMode(Boolean(params.destination));
  updateWarning();
  renderGapBar();
  showProgress(searchSteps(params, origins.length));
  searchButton.disabled = true;
  // From the bar: bring the results box (and its progress bar) into view
  // straight away — on a phone the search bar fills the screen, and without
  // this nothing would seem to happen.
  if (reveal) revealResults();

  try {
    let json = await callSearchFunction(origins, params);
    if (thisSearch !== searchCounter) return;

    // Nothing only because nobody lands close enough together? Allow a bigger
    // gap — 4 h, 5 h, 6 h, then any — so there is always something to show
    // first. The − / + buttons can tighten it again afterwards.
    const widen = WIDEN_SOURCES.has(source);
    for (let next = widen ? widerGap(json, startGap, params) : null; next !== null; next = widerGap(json, next, params)) {
      showProgressText(`Nothing where everyone lands within ${gapLabel(state.maxGapHours)} of each other — trying ${next > 0 ? `${next} h` : "any gap"}…`, { hold: true });
      params = { ...params, maxGapHours: String(next) };
      state.lastSearch = { origins, params };
      state.maxGapHours = next;
      renderGapBar();
      json = await callSearchFunction(origins, params);
      if (thisSearch !== searchCounter) return;
    }
    if (state.maxGapHours !== startGap) state.widenedFrom = startGap;

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
      state.goodPlaces = [];
      showTrip(json);
      return;
    }
    state.results = json.results;
    // (An older search function sends no good places: then there are none.)
    state.goodPlaces = (json.goodPlaces ?? []).map((g) => ({ ...g, isGood: true }));
    state.exactShown = phoneQuery.matches && state.goodPlaces.length > 0 ? EXACT_SHOWN_PHONE : EXACT_SHOWN;
    state.goodShown = GOOD_SHOWN;
    if (json.results.length === 0 && state.goodPlaces.length === 0) {
      showMessage(explainEmptyResult(json.debug, state.maxGapHours));
      renderMap();
      return;
    }
    renderTable();
  } catch (error) {
    if (thisSearch !== searchCounter) return;
    failed = true;
    state.results = [];
    state.goodPlaces = [];
    showMessage(esc(error.message), true);
    renderMap();
  } finally {
    if (thisSearch === searchCounter) {
      clearInterval(progressTimer);
      state.searching = false;
      state.searchedOnce = true;
      searchButton.disabled = false;
      renderGapBar();
      if (reveal) revealResults();
      track("search", searchStats(origins, params, source, failed, startGap));
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
  runSearch(departures, params, { reveal: true, source: "bar" });
});


// ===========================================================================
// 6b. THE ARRIVAL-TIME RULE — "Everyone lands within [−] 3 h [+]"
// ===========================================================================
// So nobody waits alone at the airport for hours: everyone's arrivals (and
// return flights) must be within this many hours of each other. It appears
// with the first results; changing it re-runs the search (quick: the server
// remembers its answers). A search that finds nothing within the limit widens
// it by itself (runSearch), and the hint says so ("widened from 3 h"). With a
// destination chosen, the answer already holds the options that were just
// over the limit, so we can say what a looser rule would add
// ("Allow 4 h → +2 weekends").

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
  const good = state.goodPlaces.length;
  if (good) return `${n} exact match${n === 1 ? "" : "es"} · ${good} good place${good === 1 ? "" : "s"}`;
  return n ? `${n} trip${n === 1 ? "" : "s"} found` : "no trip found yet";
}

// The link offering a looser rule, when it would help (null = hide it).
function gapMoreText() {
  if (state.searching || !state.lastSearch || state.maxGapHours === 0) return null;
  const params = state.lastSearch.params;
  const looser = looserGaps(state.maxGapHours, params); // short stays: never past SHORT_STAY_MAX_GAP
  if (looser.length === 0) return null;
  const trip = state.trip;
  if (!trip) {
    // Anywhere: we only know that some dates were turned down for their times.
    return state.debug?.rejectedByTimeGap > 0 ? { hours: looser[0], text: `${allowLabel(looser[0])} for more trips →` } : null;
  }
  // One destination: find the first looser step that adds a weekend or lowers a price.
  const words = stayWords(trip);
  for (const hours of looser) {
    const fits = (o) => o.status === "ok" || (o.status === "gap" && (hours === 0 || gapOf(o, params) <= hours));
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
  $("gap-bar").hidden = !state.searchedOnce;
  // Short stays time the flights home too.
  const short = state.lastSearch ? isShortStay(state.lastSearch.params) : true;
  $("gap-label-text").textContent = short ? "Everyone lands and leaves within" : "Everyone lands within";
  $("gap-value").textContent = gapLabel(state.maxGapHours);
  $("gap-minus").disabled = step === 0;
  $("gap-plus").disabled = step === GAP_STEPS.length - 1;
  // "... 3 h · 12 trips found", "... 5 h · widened from 3 h · 4 trips found", "... Any · no limit · 9 trips found"
  const found = gapFoundText() ?? "applies to your search";
  const widened = state.widenedFrom !== null && !state.searching ? `widened from ${gapLabel(state.widenedFrom)}` : null;
  const lead = widened ?? (state.maxGapHours > 0 ? null : "no limit");
  $("gap-hint").textContent = lead ? `${lead} · ${found}` : found;
  const more = gapMoreText();
  $("gap-more").hidden = !more;
  $("gap-more").textContent = more?.text ?? "";
  $("gap-more").dataset.hours = more?.hours ?? "";
}

// A change waits a moment, so pressing + twice runs one search, not two.
const searchWithGap = debounce(() => {
  if (state.lastSearch) runSearch(state.lastSearch.origins, { ...state.lastSearch.params, maxGapHours: String(state.maxGapHours) }, { source: "gap" });
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
// 7. THE RESULTS — exact matches, then good places
// ===========================================================================
// Exact matches: flights for everyone, on dates that work together (the time
// rule included) — "Select" opens the trip page with the Book buttons. Good
// places: everyone has a cheap flight there, just not on the same dates in
// the prices we have — "Choose dates" opens their page (section 7e).

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

  return `<div class="traveler"><div class="traveler-head">${head}${meta}${apartHtml(leg)}</div><div class="times">${times}</div></div>`;
}

// On longer stays someone may arrive or leave a day apart from the others: a
// small label next to them, e.g. "arrives a day later · Sat Nov 7".
const APART_WORDS = {
  "arrives-earlier": "arrives a day early",
  "arrives-later": "arrives a day later",
  "leaves-earlier": "leaves a day early",
  "leaves-later": "leaves a day later",
};
function apartHtml(leg) {
  if (!leg.apart || !APART_WORDS[leg.apart]) return "";
  const day = leg.apart.startsWith("arrives") ? leg.departDate : leg.returnDate;
  return `<span class="apart-tag">${APART_WORDS[leg.apart]} · ${weekday(day)} ${formatDay(day)}</span>`;
}

// "Your arrivals are ≈1h 20 apart · ..." under the journeys (when everyone
// arrives the same day and the times are known).
function gapNoteHtml(r) {
  if (r.arrivalGapHours == null) return "";
  const back = r.returnGapHours == null ? null : hoursLabel(r.returnGapHours);
  return r.travelers.length === 2
    ? `<div class="gap-note">Your arrivals are <b>≈${hoursLabel(r.arrivalGapHours)}</b> apart${back ? ` · your return flights <b>≈${back}</b> apart` : ""}</div>`
    : `<div class="gap-note">Everyone arrives within <b>≈${hoursLabel(r.arrivalGapHours)}</b> of each other${back ? ` · return flights within <b>≈${back}</b>` : ""}</div>`;
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
  $("sort-chips").hidden = trip;
  $("trip-chips").hidden = !trip;
  if (!trip) $("results-title").textContent = "Ranked meeting spots";
}

// "a full week · flexible dates", "a weekend · flexible dates", "Nov 14 – 21"
function describeStay(params) {
  if (params.mode === "specific") return dateRange(params.departDate, params.returnDate);
  const nights = Number(params.nights);
  const stay = params.weekendOnly === "true" && nights === 2 ? "a weekend"
    : params.weekendOnly === "true" && nights === 3 ? "a long weekend"
    : nights === 7 ? "a full week"
    : nightsLabel(nights);
  return `${stay} · flexible dates`;
}

// The words for "both of you" / "all of you" (2 departures, or more).
const groupWords = (n) => (n === 2 ? { both: "both", you: "both of you", cities: "both cities" } : { both: "all", you: "all of you", cities: "every city" });

// "Show 4 more exact matches" / "Show 89 more places" (nothing when all are shown).
function moreHtml(kind, left, words) {
  return left > 0 ? `<div class="more-row"><button type="button" class="more-btn" data-more="${kind}">Show ${left} more ${left === 1 ? words[0] : words[1]}</button></div>` : "";
}

// No exact match, but good places: why, in a sentence.
function noExactHtml() {
  const timed = state.debug?.rejectedByTimeGap > 0 && state.maxGapHours > 0;
  const why = timed
    ? `in the prices we have, your flights are never on the same days with landings within ${gapLabel(state.maxGapHours)} of each other`
    : "in the prices we have, your flights are never on the same days";
  return `<div class="section-empty">No exact match yet — ${why}. The good places below have cheap flights for each of you: choose dates there, and Aviasales shows you the live prices.</div>`;
}

function renderTable() {
  const list = sortedResults();
  const good = state.goodPlaces;
  if (![...list, ...good].some((r) => r.destination === state.selected)) state.selected = (list[0] ?? good[0]).destination;
  const words = groupWords(state.origins.length);

  const exactRows = list.slice(0, state.exactShown).map((r, i) => rowHtml(r, i, state.currency)).join("");
  const exactMore = moreHtml("exact", list.length - state.exactShown, ["exact match", "exact matches"]);
  rowsEl.innerHTML = good.length === 0
    ? exactRows + exactMore
    : `
      <div class="section-head"><span class="pill pill-exact">EXACT MATCHES · ${list.length}</span><span>Flights found for ${words.you}, on dates that work together</span></div>
      ${list.length ? exactRows + exactMore : noExactHtml()}
      ${goodPlacesHtml(good, words)}`;
  $("sort-chips").hidden = list.length < 2; // sorting needs at least two exact matches

  // (The time rule isn't repeated here: "Everyone lands within" shows it.)
  const d = state.debug;
  const currencyText = d && d.currencyConverted === false ? " · prices shown in USD (exchange rates unavailable)" : "";
  const names = state.origins.map((o) => o.label).join(" + ");
  $("results-subtitle").textContent = `${names} · ${describeStay(state.lastSearch.params)} · cheapest total first${currencyText}`;
  updateWarning();
  renderMap();
}

// The good places: each traveller's lowest price there and the total together.
// With two travellers each gets a column; with more, a line under the place.
function goodPlacesHtml(good, words) {
  const two = state.origins.length === 2;
  const head = two
    ? `<span>Place</span>${state.origins.map((o) => `<span>${esc(o.label)}</span>`).join("")}<span>Together</span><span></span>`
    : "<span>Place</span><span>Together</span><span></span>";
  const note = state.lastSearch.params.mode === "specific"
    ? "“From” is the cheapest price we've seen recently for each of you, around your dates. Aviasales shows the live price before you book."
    : "“From” is the cheapest price we've seen recently for each of you, for this kind of trip, on any dates in the next 4 months. The real price depends on the dates you choose — Aviasales shows it live before you book.";
  return `
    <div class="good-places">
      <div class="section-head"><span class="pill pill-good">GOOD PLACES FOR ${words.you.toUpperCase()} · ${good.length}</span></div>
      <p class="good-intro">Cheap flights from ${words.cities} — just not on dates that work together yet. Choose a place, pick dates that suit you ${words.both}, and see the live prices on Aviasales.</p>
      <div class="gp-list${two ? " is-two" : ""}">
        <div class="gp-head">${head}</div>
        ${good.slice(0, state.goodShown).map((g) => goodRowHtml(g, two, words)).join("")}
      </div>
      ${moreHtml("good", good.length - state.goodShown, ["place", "places"])}
      <p class="gp-note">${note}</p>
    </div>`;
}

function goodRowHtml(g, two, words) {
  const currency = state.currency;
  const seats = (t) => (t.count > 1 ? ` <small>×${t.count}</small>` : "");
  const tags = [
    g.directForAll && `<span class="gp-tag is-direct">DIRECT FROM ${words.both.toUpperCase()}</span>`,
    g.cheapestMonth && `<span class="gp-tag">CHEAPEST IN ${monthName(g.cheapestMonth).toUpperCase()}</span>`,
  ].filter(Boolean).join("");
  const each = g.travelers.map((t, i) => `<span class="gp-each-one">${esc(state.origins[i]?.label ?? t.origin)} from <b>${formatPrice(t.price, currency)}</b>${seats(t)}</span>`).join(" · ");
  const columns = two ? g.travelers.map((t) => `<div class="gp-col">from <b>${formatPrice(t.price, currency)}</b>${seats(t)}</div>`).join("") : "";
  return `
    <div class="gp-row${g.destination === state.selected ? " is-selected" : ""}" data-code="${esc(g.destination)}" role="button" tabindex="0">
      <div class="gp-place">
        <div class="gp-name">${esc(g.destinationName)}${g.country ? ` <span>${esc(g.country)}</span>` : ""}</div>
        <div class="gp-each">${each}</div>
        ${tags ? `<div class="gp-tags">${tags}</div>` : ""}
      </div>
      ${columns}
      <div class="gp-together"><span class="gp-from-wide">from </span><span class="gp-from-phone">together from</span><b>${formatPrice(g.total, currency)}</b></div>
      <button type="button" class="gp-go place-btn" data-dest="${esc(g.destination)}">Choose dates →</button>
    </div>`;
}

// A small notice when Travelpayouts didn't answer some requests, so a short
// list isn't mistaken for "that's all there is".
function updateWarning() {
  const box = $("results-warning");
  const tp = state.debug?.travelpayouts;
  const shown = state.results.length > 0 || state.goodPlaces.length > 0;
  if (shown && state.debug?.rateLimited) {
    box.innerHTML = `<span>Heads-up: the flight-data service is limiting our requests, so this list is incomplete. Wait about a minute and try again for more options.</span><button type="button" id="retry-search">Try again</button>`;
    box.hidden = false;
  } else if (tp && tp.failed > 0 && shown) {
    box.innerHTML = `<span>Heads-up: the flight-data service didn't answer ${tp.failed} of ${tp.calls} requests, so a few options may be missing.</span><button type="button" id="retry-search">Try again</button>`;
    box.hidden = false;
  } else {
    box.innerHTML = "";
    box.hidden = true;
  }
}

// "Try again" buttons (in the warning, or inside a "nothing found" message)
document.addEventListener("click", (event) => {
  if (event.target.id === "retry-search" && state.lastSearch) runSearch(state.lastSearch.origins, state.lastSearch.params, { source: "retry" });
});

function selectDestination(code, { scrollToRow = false } = {}) {
  if (code === state.selected) return;
  state.selected = code;
  const rowFor = () => rowsEl.querySelector(`.row[data-code="${CSS.escape(code)}"], .gp-row[data-code="${CSS.escape(code)}"]`);
  if (!state.trip && !rowFor()) {
    // Picked on the map, but its row is behind "Show N more": show the rows up to it.
    state.exactShown = Math.max(state.exactShown, sortedResults().findIndex((r) => r.destination === code) + 1);
    state.goodShown = Math.max(state.goodShown, state.goodPlaces.findIndex((g) => g.destination === code) + 1);
    renderTable();
  }
  rowsEl.querySelectorAll(".row, .gp-row").forEach((row) => row.classList.toggle("is-selected", row.dataset.code === code));
  showOnMap(code);
  if (scrollToRow) rowFor()?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// A row: picks that place (its routes on the map). On phones, where the map
// is hidden, a good place's row opens its page straight away.
function pickRow(row) {
  if (row.classList.contains("gp-row") && phoneQuery.matches) openPlacePage(row.dataset.code);
  else selectDestination(row.dataset.code);
}

rowsEl.addEventListener("click", (event) => {
  if (event.target.closest(".place-btn")) return; // "Choose dates" (handled in section 7e)
  const more = event.target.closest(".more-btn");
  if (more) {
    const rows = more.dataset.more === "exact" ? ".row" : ".gp-row";
    const before = rowsEl.querySelectorAll(rows).length;
    if (more.dataset.more === "exact") state.exactShown = Infinity;
    else state.goodShown = Infinity;
    renderTable();
    rowsEl.querySelectorAll(rows)[before]?.focus({ preventScroll: true }); // the first of the new rows
    return;
  }
  const row = event.target.closest(".row, .gp-row");
  if (row) pickRow(row);
});
rowsEl.addEventListener("keydown", (event) => {
  if (event.target.closest("button")) return; // Enter on "Select" presses the button, as usual
  const row = event.target.closest(".row, .gp-row");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    pickRow(row);
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
  runSearch(state.lastSearch.origins, { ...params, mode: "flexible", trip: type, nights: String(TRIP_NIGHTS[type]) }, { source: "stay" });
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
  // kind: "trip" (an exact match's Book button) or "good-place" (its "See live prices")
  track("book-click", { kind: button.dataset.kind ?? "trip", from, to, seats: Number(adults), nights: daysBetween(depart, back || depart) });

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
let lastPage = null; // the page open last, { trip } or { place } — so the browser's Forward button can reopen it

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
// (On longer stays a traveller may fly a day apart: their own dates are on the leg.)
function tripFlightHtml(leg, i, n, t) {
  const info = state.origins[i] ?? {};
  const name = i === 0 ? `You · ${info.label}` : n === 2 ? `Them · ${info.label}` : info.label;
  const departDate = leg.departDate ?? t.departDate;
  const returnDate = leg.returnDate ?? t.returnDate;
  const stops = `<span class="${leg.transfers === 0 ? "direct" : ""}">${stopsLabel(leg.transfers)}</span>`;
  const times = leg.timesKnown
    ? `Out <strong>${dayLabel(leg.outDepart.slice(0, 10))} · ${hhmm(leg.outDepart)} → ≈${hhmm(leg.outArrive)}</strong>${dayShiftMarker(leg.outDepart, leg.outArrive)}<br>
       Back <strong>${dayLabel(leg.retDepart.slice(0, 10))} · ${hhmm(leg.retDepart)} → ≈${hhmm(leg.retArrive)}</strong>${dayShiftMarker(leg.retDepart, leg.retArrive)}<br>
       ≈${durationLabel(leg.outMinutes)} each way · ${stops}`
    : `Out ${dayLabel(departDate)} · back ${dayLabel(returnDate)} · ${stops}<br>Flight times not available for this fare`;
  const price = leg.count > 1
    ? `<div class="tp-price">${formatPrice(leg.subtotal, state.currency)}</div><div class="tp-price-sub">${leg.count} × ${formatPrice(leg.price, state.currency)}</div>`
    : `<div class="tp-price">${formatPrice(leg.price, state.currency)}</div><div class="tp-price-sub">1 traveller</div>`;
  // The link itself is fetched when the button is pressed (section 7c).
  const book = info.code
    ? `<button type="button" class="book-btn is-primary" data-from="${esc(info.code)}" data-to="${esc(t.code)}" data-depart="${esc(departDate)}" data-return="${esc(returnDate ?? "")}" data-adults="${leg.count}">Book ${leg.count > 1 ? `${leg.count} seats ` : ""}on Aviasales<span class="book-arrow" aria-hidden="true">↗</span></button>`
    : "";
  return `
    <div class="tp-flight">
      <div>
        <div class="traveler-head"><span class="dot dot-${i % 8}"></span><span class="who">${esc(name)}</span>${apartHtml(leg)}</div>
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
      <p class="tp-sub">Everyone books their own flight, from their own airport${t.travelers.some((leg) => leg.apart) ? " — on the dates shown for each of you" : ", on the same dates"}.</p>
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

// Shows a page (a trip, or a good place) in place of the list.
function showPage(html) {
  closeMapPopup(); // (a box opened on the map belongs to the page before)
  tripPageEl.innerHTML = html;
  listViewEls.forEach((el) => (el.hidden = true));
  tripPageEl.hidden = false;
  if (!history.state?.tripPage) history.pushState({ tripPage: true }, "", "#trip"); // so Back returns to the list
  window.scrollTo({ top: 0 });
  $("trip-back").focus({ preventScroll: true });
  updateMapButton();
}

function openTripPage(trip) {
  lastPage = { trip };
  placeView = null;
  showPage(tripPageHtml(trip));
}

function closeTripPage() {
  if (tripPageEl.hidden) return;
  placeView = null; // (a good place's dates still on their way are dropped)
  closeMapPopup();
  tripPageEl.hidden = true;
  tripPageEl.innerHTML = "";
  listViewEls.forEach((el) => (el.hidden = false));
  updateMapButton();
  renderMap(); // a good place's label goes back to its price
  // Back where you were: the selected row (or the trip box).
  (rowsEl.querySelector(".row.is-selected, .gp-row.is-selected") ?? rowsEl.querySelector(".trip-box"))?.scrollIntoView({ block: "center" });
}

document.addEventListener("click", (event) => {
  const select = event.target.closest(".select-btn");
  if (select) {
    const trip = tripFromSelect(select);
    if (trip) {
      setMapOpen(false); // "Select" on the phone's full-screen map
      if (select.dataset.dest) selectDestination(select.dataset.dest); // (e.g. "See this trip" in a box on the map)
      openTripPage(trip);
      track("select", {
        kind: select.dataset.dest ? "anywhere" : "destination",
        to: trip.code,
        nights: trip.nights,
        travellers: trip.travelers.reduce((sum, leg) => sum + leg.count, 0),
        total: Math.round(trip.total),
        currency: state.currency.toUpperCase(),
      });
    }
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
  else if (lastPage && tripPageEl.hidden) lastPage.trip ? openTripPage(lastPage.trip) : openPlacePage(lastPage.place.destination);
});

// A reload on "#trip" has no trip to show any more: start from the search.
if (location.hash === "#trip") history.replaceState(null, "", location.pathname + location.search);


// ===========================================================================
// 7e. A GOOD PLACE (after "Choose dates")
// ===========================================================================
// Everyone has a cheap flight there, just not on days that work together in
// the prices we have. So the page compares the coming weekends (or weeks):
// each traveller's cheapest price around each one, added up (the search
// function's one-destination answer, `each`). You pick one — or your own
// dates — and each of you opens Aviasales for the live prices and books.
// It uses the same place as the trip page (#trip-page, the Back button...).

let placeView = null; // the open good place: { place, stay, answer, loading, error, window, custom, calendarOpen }
let placeCounter = 0; // so an older answer can't overwrite a newer one

// The kind of stay the search was for: weekend · long · week (the chips),
// "nights" (a custom number of nights) or "dates" (specific dates).
function stayOfSearch(params) {
  if (params.mode === "specific") return "dates";
  if (params.weekendOnly === "true") return params.nights === "2" ? "weekend" : params.nights === "3" ? "long" : "nights";
  return params.nights === "7" ? "week" : "nights";
}

// The one-destination search for this place and kind of stay.
function placeParams(code, stay) {
  const p = state.lastSearch.params;
  const common = { currency: p.currency, maxGapHours: String(state.maxGapHours), destination: code };
  if (stay === "dates") return { ...common, mode: "specific", departDate: p.departDate, returnDate: p.returnDate };
  if (stay in TRIP_NIGHTS) return { ...common, mode: "flexible", trip: stay, nights: String(TRIP_NIGHTS[stay]) };
  return { ...common, mode: "flexible", nights: p.nights };
}

function openPlacePage(code) {
  const place = state.goodPlaces.find((g) => g.destination === code);
  if (!place) return;
  lastPage = { place };
  selectDestination(code); // its row in the list (for coming back), its routes on the map
  placeView = { place, stay: stayOfSearch(state.lastSearch.params), answer: null, loading: true, error: null, window: null, custom: null, calendarOpen: false };
  showPage(placePageHtml());
  renderMap(); // its label on the map: "meet here"
  loadPlaceDates();
  track("choose-dates", {
    to: code,
    travellers: place.travelers.reduce((sum, t) => sum + t.count, 0),
    total: Math.round(place.total),
    currency: state.currency.toUpperCase(),
  });
}

async function loadPlaceDates() {
  const view = placeView;
  const thisLoad = ++placeCounter;
  Object.assign(view, { answer: null, loading: true, error: null, window: null });
  renderPlacePage();
  try {
    const json = await callSearchFunction(state.lastSearch.origins, placeParams(view.place.destination, view.stay));
    if (thisLoad !== placeCounter || placeView !== view) return;
    if (!json.windows.every((w) => Array.isArray(w.each))) console.warn("The deployed search-flights function sends no prices per traveller yet — redeploy supabase/functions/search-flights/index.ts.");
    view.answer = json;
    // Start on the cheapest weekend (or week) with a price for everyone.
    const totals = json.windows.map(windowTotal);
    const best = Math.min(...totals.filter((t) => t !== null));
    view.window = Number.isFinite(best) ? totals.indexOf(best) : 0;
  } catch (error) {
    if (thisLoad !== placeCounter || placeView !== view) return;
    view.error = error.message;
  }
  view.loading = false;
  renderPlacePage();
}

// Everyone's cheapest prices around one weekend (or week), added up (null = someone has none).
function windowTotal(w) {
  if (!Array.isArray(w.each) || w.each.some((e) => !e)) return null;
  return w.each.reduce((sum, e, i) => sum + e.price * (state.origins[i]?.count ?? 1), 0);
}

// The dates chosen: your own ones, or the weekend (or week) picked.
function chosenDates() {
  const v = placeView;
  if (v.custom) return v.custom;
  const w = v.answer?.windows[v.window];
  return w ? { departDate: w.departDate, returnDate: w.returnDate } : null;
}

// Re-draws the page, keeping the focus where it was (e.g. on the card just picked).
function renderPlacePage(focusSelector = null) {
  if (!placeView || tripPageEl.hidden) return;
  const active = focusSelector ?? (tripPageEl.contains(document.activeElement) && document.activeElement.id ? `#${document.activeElement.id}` : null);
  tripPageEl.innerHTML = placePageHtml();
  if (active) tripPageEl.querySelector(active)?.focus({ preventScroll: true });
  // On phones the weeks are one row you swipe: keep the chosen one in the middle.
  const strip = tripPageEl.querySelector(".pp-weeks");
  const picked = strip?.querySelector(".pp-week.is-selected");
  if (picked && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = picked.offsetLeft - (strip.clientWidth - picked.offsetWidth) / 2;
}

const STAY_CHIPS = [["weekend", "Weekend"], ["long", "Long weekend"], ["week", "A week"]];

function placePageHtml() {
  const v = placeView;
  const g = v.place;
  const n = g.travelers.length;
  const words = groupWords(n);
  const people = g.travelers.reduce((sum, t) => sum + t.count, 0);
  const labels = state.origins.map((o) => o.label);
  const fromLine = g.travelers.map((t, i) => `${esc(labels[i] ?? t.origin)} from ${formatPrice(t.price, state.currency)}`).join(" · ");
  const direct = g.directForAll ? ` · direct flights from ${labels.length === 2 ? `${esc(labels[0])} and from ${esc(labels[1])}` : `all ${labels.length} cities`}` : "";
  const stayText = stayWords({ tripType: v.stay, nights: Number(state.lastSearch.params.nights) });
  const d = chosenDates();

  return `
    <button type="button" class="back-link" id="trip-back">← Back to results</button>
    <div class="tp-head">
      <div>
        <div class="hero-badge">A GOOD PLACE FOR ${words.you.toUpperCase()}</div>
        <h2>${esc(g.destinationName)}</h2>
        <div class="tp-country">${esc(g.country)}${direct}</div>
      </div>
      <div class="tp-total"><span>together, usually from</span><strong>${formatPrice(g.total, state.currency)}</strong><span>${fromLine}</span></div>
    </div>

    <section class="tp-card pp-step">
      <div class="pp-step-head"><span class="pp-num">1</span><h3>Choose your dates</h3></div>
      <p class="pp-sub">${v.stay === "dates"
        ? `The price below is the cheapest we've seen recently for each of you, around your dates.`
        : `The prices below are the cheapest we've seen recently for each ${stayText.unit}. Pick one that suits you ${words.both}.`}</p>
      <div class="chips pp-stays" id="pp-stays">${stayChipsHtml(v.stay)}</div>
      ${placeWeeksHtml(stayText)}
      ${d ? chosenHtml(d, people) : ""}
    </section>

    <section class="tp-card pp-step">
      <div class="pp-step-head"><span class="pp-num">2</span><h3>See the live prices and book</h3></div>
      <p class="pp-sub">Aviasales searches the airlines right now, for exactly these dates — you see the real flights and prices, and each of you books their own.</p>
      ${d ? g.travelers.map((t, i) => placeFlightHtml(t, i, d)).join("") : `<p class="pp-note">Choose your dates above first.</p>`}
      <p class="pp-tip">Tip: open ${n === 2 ? "both" : "them all"} before booking, to check you can land close together. If the times don't suit you ${words.both}, come back and pick another ${v.stay === "dates" ? "day" : stayText.unit}.</p>
      <p class="tp-disclosure">If you book through these buttons we may earn a small commission, at no extra cost to you.</p>
    </section>

    <!-- Room for what goes with the trip: hotels for these dates, offers... -->
    <section class="tp-card">
      <h3>Where to stay in ${esc(g.destinationName)}</h3>
      <p class="tp-sub">${d ? `${dateRange(d.departDate, d.returnDate)} · ${nightsLabel(daysBetween(d.departDate, d.returnDate))} · ` : ""}${travellersLabel(people)}</p>
      <div class="tp-placeholder">Hotel ideas for these dates will appear here.</div>
    </section>`;
}

// Weekend · Long weekend · A week — plus "Your dates" / "5 nights" when the search was for those.
function stayChipsHtml(stay) {
  const p = state.lastSearch.params;
  const own = stayOfSearch(p);
  const chips = [...STAY_CHIPS];
  if (own === "dates") chips.unshift(["dates", "Your dates"]);
  if (own === "nights") chips.push(["nights", nightsLabel(Number(p.nights))]);
  return chips.map(([key, label]) => `<button type="button" class="chip${key === stay ? " is-selected" : ""}" data-stay="${key}" id="pp-stay-${key}">${label}</button>`).join("");
}

// The coming weekends (or weeks) as cards: everyone's cheapest prices added up.
function placeWeeksHtml(stayText) {
  const v = placeView;
  if (v.loading) return `<p class="pp-loading">Looking at the coming ${v.stay === "dates" ? "days" : stayText.plural}…</p>`;
  if (v.error) return `<p class="pp-note is-error">${esc(v.error)} <button type="button" class="inline-retry" id="pp-retry">Try again</button></p>`;
  const windows = v.answer.windows;
  const totals = windows.map(windowTotal);
  const priced = totals.filter((t) => t !== null);
  const min = Math.min(...priced);
  const cards = windows.map((w, i) => {
    const total = totals[i];
    const classes = ["pp-week", i === v.window && !v.custom && "is-selected", total === null && "is-empty"].filter(Boolean).join(" ");
    return `
      <button type="button" class="${classes}" data-window="${i}" id="pp-week-${i}">
        <span class="pp-week-dates">${dateRange(w.departDate, w.returnDate)}</span>
        <span class="pp-week-days">${daysLabel(w)}</span>
        <span class="pp-week-price">${total === null ? "no price yet" : formatPrice(total, state.currency)}</span>
        ${total !== null && total === min && priced.length > 1 ? `<span class="pp-week-tag">CHEAPEST</span>` : ""}
      </button>`;
  });
  const busy = v.answer.debug?.rateLimited ? `<p class="pp-note">The flight-data service is busy right now, so some prices may be missing — you can still pick any dates.</p>` : "";
  const none = priced.length === 0 ? `<p class="pp-note">No saved prices for everyone on these dates yet — pick the ones you like: Aviasales shows the live prices.</p>` : "";
  return `<div class="pp-weeks">${cards.join("")}</div>${busy || none}`;
}

// "Sat Nov 14 → Sat Nov 21 · 7 nights · 2 travellers", and your own dates instead.
function chosenHtml(d, people) {
  const v = placeView;
  const custom = v.calendarOpen
    ? `<span class="pp-custom">
         <input type="date" id="pp-depart" aria-label="Depart date" min="${today}" value="${esc(d.departDate)}">
         <span>to</span>
         <input type="date" id="pp-return" aria-label="Return date" min="${esc(addDaysIso(d.departDate, 1))}" value="${esc(d.returnDate)}">
       </span>`
    : `<button type="button" class="pp-link" id="pp-calendar">or pick other dates on a calendar</button>`;
  return `
    <div class="pp-chosen">
      <strong>${dayLabel(d.departDate)} → ${dayLabel(d.returnDate)} · ${nightsLabel(daysBetween(d.departDate, d.returnDate))} · ${travellersLabel(people)}</strong>
      ${custom}
    </div>`;
}

const addDaysIso = (dateStr, days) => {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// One traveller: their route on the chosen dates, an idea of the price, and
// the button to Aviasales' live prices (the partner link, section 7c).
function placeFlightHtml(t, i, d) {
  const v = placeView;
  const n = v.place.travelers.length;
  const info = state.origins[i] ?? {};
  const name = i === 0 ? `You · ${info.label}` : n === 2 ? `Them · ${info.label}` : info.label;
  const around = v.custom ? null : v.answer?.windows[v.window]?.each?.[i];
  const price = around
    ? `around these dates from <b>${formatPrice(around.price, state.currency)}</b>`
    : `usually from <b>${formatPrice(t.price, state.currency)}</b>`;
  const seats = t.count > 1 ? ` per person · ${t.count} seats` : "";
  return `
    <div class="tp-flight">
      <div>
        <div class="traveler-head"><span class="dot dot-${i % 8}"></span><span class="who">${esc(name)}</span></div>
        <div class="tp-route">${esc(info.label)} → ${esc(v.place.destinationName)}</div>
        <div class="tp-legs">${dayLabel(d.departDate)} → ${dayLabel(d.returnDate)} · ${price}${seats}${t.direct ? " · direct flights exist" : ""}</div>
      </div>
      <div class="tp-buy">
        <button type="button" class="book-btn is-primary" data-kind="good-place" data-from="${esc(info.code ?? t.origin)}" data-to="${esc(v.place.destination)}" data-depart="${esc(d.departDate)}" data-return="${esc(d.returnDate)}" data-adults="${t.count}">See live prices on Aviasales<span class="book-arrow" aria-hidden="true">↗</span></button>
      </div>
    </div>`;
}

// "Choose dates →" (in the list, and on the phone's full-screen map).
document.addEventListener("click", (event) => {
  const button = event.target.closest(".place-btn");
  if (!button) return;
  setMapOpen(false);
  openPlacePage(button.dataset.dest);
});

// On the page: a weekend (or week), another kind of stay, your own dates, "Try again".
tripPageEl.addEventListener("click", (event) => {
  const v = placeView;
  if (!v) return;
  const week = event.target.closest(".pp-week");
  const stay = event.target.closest("#pp-stays .chip");
  if (week) {
    v.window = Number(week.dataset.window);
    v.custom = null;
    v.calendarOpen = false;
    renderPlacePage(`#${week.id}`);
  } else if (stay && stay.dataset.stay !== v.stay) {
    v.stay = stay.dataset.stay;
    v.custom = null;
    v.calendarOpen = false;
    loadPlaceDates();
    tripPageEl.querySelector(`#pp-stay-${v.stay}`)?.focus({ preventScroll: true });
  } else if (event.target.closest("#pp-calendar")) {
    v.calendarOpen = true;
    renderPlacePage("#pp-depart");
  } else if (event.target.closest("#pp-retry")) {
    loadPlaceDates();
  }
});

tripPageEl.addEventListener("change", (event) => {
  const v = placeView;
  if (!v || !["pp-depart", "pp-return"].includes(event.target.id)) return;
  const departDate = $("pp-depart").value;
  let returnDate = $("pp-return").value;
  if (!departDate) return;
  // A new depart date after the return date: keep the same number of nights.
  if (!returnDate || returnDate <= departDate) {
    const current = chosenDates();
    returnDate = addDaysIso(departDate, current ? Math.max(1, daysBetween(current.departDate, current.returnDate)) : 1);
  }
  v.custom = { departDate, returnDate };
  renderPlacePage(`#${event.target.id}`);
});


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
    meet: v("--action"), goodRing: v("--map-good"),
    pins: Array.from({ length: 8 }, (_, i) => v(`--c${i}`)),
  };
  return themeCache;
}

const hasCoords = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

// The places on the map: the exact matches (full dots), then the good places (hollow dots).
const mapPlaces = () => [...state.results, ...state.goodPlaces];

// What the map frames by itself: the exact matches and the first good places
// (not all of them — some are far away), plus the selected one.
function fitPlaces() {
  const good = state.goodPlaces.slice(0, GOOD_SHOWN);
  const selected = state.goodPlaces.find((g) => g.destination === state.selected);
  return [...state.results, ...good, ...(selected && !good.includes(selected) ? [selected] : [])].filter(hasCoords);
}
const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const px = (n) => n.toFixed(1);

const mapLayer = $("map-layer");
const mapSvg = $("map");
let shownView = null; // what the map shows right now: {k, tx, ty}
let shownMap = null;  // ...and its projection (to test what's in view)

// Behind the whole page (wide screens), or a block of its own (smaller screens,
// and the full-screen map on phones)?
const mapIsOverlay = () => document.body.classList.contains("map-open");
const mapIsBackground = () => getComputedStyle(mapLayer).position === "fixed" && !mapIsOverlay();

// The part of the map you can really see, [[left, top], [right, bottom]] in
// the map's pixels: right of the results on wide screens (the table covers the
// left), the whole block otherwise. Room is left on the sides for the labels.
function openArea() {
  const w = mapLayer.clientWidth;
  const h = mapLayer.clientHeight;
  if (!mapIsBackground()) {
    const side = Math.min(110, w * 0.18);
    // Full screen on a phone: keep clear of "← List" at the top and the place card at the bottom.
    return mapIsOverlay() ? [[side, 80], [w - side, h - 190]] : [[side, 50], [w - side, h - 60]];
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
  const destinations = fitPlaces();
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
  updateMapButton();
  const w = mapLayer.clientWidth;
  const h = mapLayer.clientHeight;
  if (!w || !h) return; // hidden (phones, until the "Map" button opens it)
  const T = themeColors();

  const origins = state.origins ?? [];
  const destinations = mapPlaces().filter(hasCoords);
  const selected = destinations.find((r) => r.destination === state.selected);
  const ready = selected && origins.length > 0 && origins.every(hasCoords);
  const priceOn = (r) => (r.isGood ? `from ${formatPrice(r.total, state.currency)}` : formatPrice(r.total, state.currency));

  shownView = state.mapView ?? autoView();
  const m = (shownMap = Geo.createMap(shownView, w, h));
  const onScreen = ([x, y]) => x > -40 && x < w + 40 && y > -40 && y < h + 40;

  let overlay = "";
  let labels = "";
  if (ready) {
    const pd = m.project(selected.lat, selected.lon);
    const pins = origins.map((o, i) => ({ o, i, p: m.project(o.lat, o.lon), color: T.pins[i % 8] }));
    const [middleX] = areaCentre(openArea());

    // 1. Every other result: a small dot you can hover (name + price) and
    //    click — full for an exact match, hollow for a good place.
    for (const r of destinations) {
      if (r.destination === selected.destination) continue;
      const [x, y] = m.project(r.lat, r.lon);
      if (!onScreen([x, y])) continue;
      const left = x > middleX; // the hover label goes on the side facing the middle
      const core = r.isGood
        ? `<circle class="dot-core" cx="${px(x)}" cy="${px(y)}" r="5.5" fill="#fff" stroke="${T.goodRing}" stroke-width="2.5"></circle>`
        : `<circle class="dot-core" cx="${px(x)}" cy="${px(y)}" r="5.5" fill="${T.meet}" stroke="#fff" stroke-width="2"></circle>`;
      overlay += `
        <g class="dest-dot${r.destination === mapPopup && !tripPageEl.hidden ? " is-open" : ""}" data-code="${esc(r.destination)}">
          <circle cx="${px(x)}" cy="${px(y)}" r="13" fill="transparent"></circle>
          ${core}
          <text class="dot-label" x="${px(x + (left ? -12 : 12))}" y="${px(y + 4)}" text-anchor="${left ? "end" : "start"}">${esc(r.destinationName)} · ${priceOn(r)}</text>
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
      // A good place in the list shows its price; once its page is open, "meet here".
      const text = selected.mapLabel ?? (selected.isGood && tripPageEl.hidden ? `${selected.destinationName} · ${priceOn(selected)}` : `${selected.destinationName} — meet here`);
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
  $("map-card").innerHTML = mapIsOverlay() ? mapCardHtml() : "";
  placeMapPopup(m, w, h);

  $("map-hint").textContent = ready && destinations.length > 1 ? "Drag to explore · click a dot to see another place" : `Drag to explore · ${ZOOM_KEY} + scroll to zoom`;
  $("map-legend").hidden = !ready || state.goodPlaces.length === 0;
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
  const r = mapPlaces().find((x) => x.destination === code);
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

// Clicking (not dragging) a dot selects that destination and shows its row
// (on the full-screen phone map, its card instead).
// On a trip's (or good place's) page, a dot opens its box instead (below), and
// a click elsewhere on the map closes it.
mapSvg.addEventListener("click", (event) => {
  if (dragged) return;
  const dot = event.target.closest(".dest-dot");
  if (!tripPageEl.hidden) setMapPopup(dot ? dot.dataset.code : null);
  else if (dot) selectDestination(dot.dataset.code, { scrollToRow: !mapIsOverlay() });
});

// --- On a trip's (or good place's) page: a dot opens a small box -------------
// The other places stay on the map as dots. Clicking one opens a box next to
// it with that place's dates and prices, and a button to its own page — so
// you can compare without leaving the page you're on. The box follows its dot
// when the map moves; ×, Escape or a click elsewhere on the map closes it.

let mapPopup = null; // the code of the place whose box is open, or null
const POPUP_WIDTH = 268;

function mapPopupHtml(r) {
  const label = (t, i) => esc(state.origins[i]?.label ?? t.origin);
  const head = `
    <button type="button" class="mp-close" aria-label="Close">×</button>
    <div class="mp-kind${r.isGood ? " is-good" : ""}">${r.isGood ? "GOOD PLACE" : "EXACT MATCH"}</div>
    <div class="mp-title">${esc(r.destinationName)}${r.country ? ` <span>${esc(r.country)}</span>` : ""}</div>`;
  if (r.isGood) {
    const each = r.travelers.map((t, i) => `<span class="gp-each-one">${label(t, i)} from ${formatPrice(t.price, state.currency)}</span>`).join(" · ");
    return `${head}
      <div class="mp-sub">Cheap for ${groupWords(r.travelers.length).you}, not on the same dates yet${r.directForAll ? " · direct flights" : ""}</div>
      <div class="mp-each">${each}</div>
      <div class="mp-total"><small>together from</small> <strong>${formatPrice(r.total, state.currency)}</strong></div>
      <button type="button" class="select-btn place-btn mp-go" data-dest="${esc(r.destination)}">Choose dates →</button>`;
  }
  const people = r.travelers.reduce((sum, t) => sum + t.count, 0);
  const each = r.travelers.map((t, i) => `<span class="gp-each-one">${label(t, i)} ${formatPrice(t.subtotal, state.currency)}</span>`).join(" · ");
  return `${head}
    <div class="mp-sub">${dayLabel(r.departDate)} → ${dayLabel(r.returnDate)} · ${nightsLabel(r.nights)}${r.daysApart ? " · someone a day apart" : ""}</div>
    <div class="mp-each">${each}</div>
    <div class="mp-total"><strong>${formatPrice(r.total, state.currency)}</strong> <small>${peopleLabel(people)}</small></div>
    <button type="button" class="select-btn mp-go" data-dest="${esc(r.destination)}">See this trip →</button>`;
}

function setMapPopup(code) {
  const r = code ? mapPlaces().find((x) => x.destination === code) : null;
  mapPopup = r ? code : null;
  $("map-popup").innerHTML = r ? mapPopupHtml(r) : "";
  renderMap();
}

function closeMapPopup() {
  mapPopup = null;
  $("map-popup").hidden = true;
  $("map-popup").innerHTML = "";
}

// Next to its dot — on the right, or on the left when there's no room — with
// its little arrow pointing at the dot. Hidden when the dot is out of view.
function placeMapPopup(m, w, h) {
  const box = $("map-popup");
  const r = mapPopup && !tripPageEl.hidden ? mapPlaces().find((x) => x.destination === mapPopup) : null;
  const [x, y] = hasCoords(r) ? m.project(r.lat, r.lon) : [-1, -1];
  const visibleLeft = mapIsBackground() ? document.querySelector(".map-col").getBoundingClientRect().left : 0; // the page covers the rest
  if (!r || x < visibleLeft || x > w || y < 0 || y > h) {
    box.hidden = true;
    return;
  }
  const right = x + 18 + POPUP_WIDTH <= w - 8 || x - 18 - POPUP_WIDTH < visibleLeft + 8;
  box.hidden = false;
  box.classList.toggle("is-left", !right);
  const top = clamp(y - box.offsetHeight / 2, 8, Math.max(8, h - box.offsetHeight - 8));
  box.style.left = `${Math.round(right ? x + 18 : x - 18 - POPUP_WIDTH)}px`;
  box.style.top = `${Math.round(top)}px`;
  box.style.setProperty("--arrow-y", `${Math.round(y - top)}px`);
}

$("map-popup").addEventListener("click", (event) => {
  if (event.target.closest(".mp-close")) setMapPopup(null);
  // (Its "See this trip" / "Choose dates" buttons open that page: sections 7d and 7e.)
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mapPopup) setMapPopup(null);
});

window.addEventListener("resize", redrawMapSoon);

// --- On phones: the map opens full screen over the list ---------------------
// The list stays easy to read; the "Map" button at the bottom of the screen
// opens the map with every result and the routes, plus a card for the
// selected place (tap another dot to compare, "Select" to open its trip).

const phoneQuery = window.matchMedia("(max-width: 860px)");

function updateMapButton() {
  $("map-open").hidden = !phoneQuery.matches || mapIsOverlay() || !tripPageEl.hidden || !mapPlaces().some(hasCoords);
}

function setMapOpen(open) {
  if (open === mapIsOverlay()) return;
  document.body.classList.toggle("map-open", open);
  state.mapView = null; // frame everything again, for the new size
  renderMap();
  $(open ? "map-close" : "map-open").focus({ preventScroll: true });
}

// The card at the bottom of the full-screen map: the selected place, its total, "Select".
function mapCardHtml() {
  const r = mapPlaces().find((x) => x.destination === state.selected);
  if (!r) return "";
  const people = state.origins.reduce((sum, o) => sum + o.count, 0);
  const title = `<div class="mc-title">${esc(r.destinationName)}${r.country ? ` <span>${esc(r.country)}</span>` : ""}</div>`;
  const hint = mapPlaces().length > 1 ? '<div class="mc-hint">Tap another dot to compare</div>' : "";
  if (r.isGood) {
    // A good place: everyone's lowest price there, and the way to its dates.
    const each = r.travelers.map((t, i) => `<span class="gp-each-one">${esc(state.origins[i]?.label ?? t.origin)} from ${formatPrice(t.price, state.currency)}</span>`).join(" · ");
    return `${title}
      <div class="mc-sub">A good place: ${each}</div>
      <div class="mc-bottom"><strong><small>from</small> ${formatPrice(r.total, state.currency)}</strong><button type="button" class="select-btn place-btn" data-dest="${esc(r.destination)}">Choose dates</button></div>
      ${hint}`;
  }
  if (state.trip) {
    // One destination: the weekend and option chosen in the list.
    const o = state.trip.windows[state.tripWindow]?.options[state.tripOption];
    if (o?.status !== "ok") return `${title}<div class="mc-sub">No date works for everyone yet — pick another one in the list.</div>`;
    return `${title}
      <div class="mc-sub">${dayLabel(o.departDate)} → ${dayLabel(o.returnDate)} · ${nightsLabel(o.nights)} · ${peopleLabel(people)}</div>
      <div class="mc-bottom"><strong>${formatPrice(o.total, state.currency)}</strong><button type="button" class="select-btn">Select</button></div>`;
  }
  return `${title}
    <div class="mc-sub">${formatDay(r.departDate)} – ${formatDay(r.returnDate)} · ${nightsLabel(r.nights)} · ${peopleLabel(people)}</div>
    <div class="mc-bottom"><strong>${formatPrice(r.total, state.currency)}</strong><button type="button" class="select-btn" data-dest="${esc(r.destination)}">Select</button></div>
    ${hint}`;
}

$("map-open").addEventListener("click", () => setMapOpen(true));
$("map-close").addEventListener("click", () => setMapOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && mapIsOverlay()) setMapOpen(false);
});
// Turning a tablet (or resizing a window) past the phone size closes it.
phoneQuery.addEventListener("change", () => (phoneQuery.matches ? renderMap() : setMapOpen(false)));

renderGapBar();
renderMap();
Geo.load().then(renderMap); // the countries arrive a moment later
