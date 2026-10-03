// ---------------------------------------------------------------------------
// Flight Plan — the page's behaviour
//
// How it fits together:
//   * You pick two or more departures (live autocomplete, with how many people leave
//     from each) and when you want to travel.
//   * The page asks our small Supabase Edge Function (supabase/functions/
//     search-flights) for matching destinations. That function holds the
//     Travelpayouts token safely on the server — this file never sees it.
//   * The results fill the table; the globe on the right shows the selected
//     destination (geo.js draws the globe).
//
// Sections:  1 Settings · 2 Small helpers · 3 Airport autocomplete + 3b Departures ·
//            4 Currency · 5 The "When" pop-up · 6 Searching ·
//            7 The results table · 8 The globe
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

const GLOBE_RADIUS = 210; // size of the globe window, in pixels

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
  const cols = n <= 3 ? n : n === 4 ? 2 : n <= 6 ? 3 : 4;
  originsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
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
  $("flex-nights-field").hidden = specific; // "±1 night" only makes sense with flexible dates
  $("when-summary").textContent = describeWhen();
}

function describeWhen() {
  if (isSpecificMode()) {
    return departDateInput.value && returnDateInput.value ? `${formatDay(departDateInput.value)} – ${formatDay(returnDateInput.value)}` : "Pick your dates";
  }
  if (durationSelect.value === "weekend") return "Weekend · Flexible";
  if (durationSelect.value === "week") return "Full week · Flexible";
  return `${$("custom-nights").value || "?"} nights · Flexible`;
}

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

// Turns the pop-up's choices into the options sent to the search function.
function collectSearchParams() {
  const common = { currency: currencySelect.value, maxGapHours: $("max-gap").value };

  if (isSpecificMode()) {
    if (!departDateInput.value || !returnDateInput.value) throw new Error("Pick both a depart and a return date, or switch to flexible dates.");
    if (returnDateInput.value <= departDateInput.value) throw new Error("The return date needs to be after the depart date.");
    return { ...common, mode: "specific", departDate: departDateInput.value, returnDate: returnDateInput.value };
  }

  const flexible = { ...common, mode: "flexible", flexNights: $("flex-nights").checked ? "1" : "0" };
  if (durationSelect.value === "weekend") return { ...flexible, nights: "2", weekendOnly: "true" };
  if (durationSelect.value === "week") return { ...flexible, nights: "7" };

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
  state.lastSearch = { origins, params };
  state.maxGapHours = Number(params.maxGapHours);
  state.debug = null;
  updateWarning();
  showMessage("Searching… (this can take a few seconds)");
  searchButton.disabled = true;

  try {
    const json = await callSearchFunction(origins, params);

    // Names and positions for the departures (for the table and the globe's labels).
    state.origins = origins.map((o, i) => {
      const server = json.origins?.[i] ?? {};
      return { label: o.label || server.name || o.code, lat: o.lat ?? server.lat, lon: o.lon ?? server.lon, count: o.count };
    });
    state.results = json.results;
    state.debug = json.debug;
    state.currency = json.currency || params.currency; // what the prices are really in
    state.selected = null;

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

function rowHtml(r, index, currency) {
  const n = r.travelers.length;
  const people = r.travelers.reduce((total, t) => total + t.count, 0);
  const gapNote =
    r.arrivalGapHours != null
      ? n === 2
        ? `<div class="gap-note">Your arrivals are <b>≈${hoursLabel(r.arrivalGapHours)}</b> apart · your return flights <b>≈${hoursLabel(r.returnGapHours)}</b> apart</div>`
        : `<div class="gap-note">Everyone arrives within <b>≈${hoursLabel(r.arrivalGapHours)}</b> of each other · return flights within <b>≈${hoursLabel(r.returnGapHours)}</b></div>`
      : "";
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
        <div class="total-sub">${people === 2 ? "both of you" : `${people} travellers`}</div>
        <span class="select-btn">Select</span>
      </div>
    </div>`;
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
  renderGlobe();
  if (scrollToRow) rowsEl.querySelector(`.row[data-code="${CSS.escape(code)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

rowsEl.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (row) selectDestination(row.dataset.code);
});
rowsEl.addEventListener("keydown", (event) => {
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
// 8. THE GLOBE
// ===========================================================================

// The globe's colours come from the variables at the top of styles.css
// (--ocean-a, --land, --pin0 ... --pin7, ...), so changing the theme there
// re-colours the globe too.
function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const v = (name) => style.getPropertyValue(name).trim();
  return {
    oceanA: v("--ocean-a"), oceanB: v("--ocean-b"), land: v("--land"), orbit: v("--orbit"),
    meet: v("--peach"), accent: v("--accent"),
    pins: Array.from({ length: 8 }, (_, i) => v(`--pin${i}`)),
  };
}

const hasCoords = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

function renderGlobe() {
  const svg = $("globe");
  const labelsEl = $("globe-labels");
  const R = GLOBE_RADIUS;
  const T = themeColors();

  const origins = state.origins ?? [];
  const destinations = state.results.filter(hasCoords);
  const selected = destinations.find((r) => r.destination === state.selected);
  const ready = selected && origins.length > 0 && origins.every(hasCoords);

  // The view fits every departure AND every result, so all the options are on
  // the globe at once and it doesn't jump around when you pick another one.
  // No search yet: a calm empty globe over the Atlantic.
  const g = ready
    ? Geo.createGlobe([...origins, ...destinations.map((r) => ({ lat: r.lat, lon: r.lon }))], R)
    : Geo.createGlobe([], R, { lat: 35, lon: -30 });
  const { cx, cy } = g;
  const inside = (p) => p.visible && Math.hypot(p.x - cx, p.y - cy) <= R - 4;

  let overlay = "";
  let labels = "";
  if (ready) {
    const dest = { lat: selected.lat, lon: selected.lon };
    const pd = g.project(dest.lat, dest.lon);
    const pins = origins.map((o, i) => ({ o, i, p: g.project(o.lat, o.lon), color: T.pins[i % 8] }));

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

    // 2. The selected destination: flight paths from every departure, then the pins.
    for (const { o, color } of pins) {
      overlay += `<path d="${g.arc(o, dest)}" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none" opacity="0.95"></path>`;
    }
    for (const { p, color } of pins) {
      if (!p.visible) continue;
      overlay += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="17" fill="none" stroke="${color}" stroke-width="2" opacity="0.5"></circle><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="${color}" stroke="${T.accent}" stroke-width="3"></circle>`;
    }
    if (pd.visible) {
      overlay += `<circle cx="${pd.x.toFixed(1)}" cy="${pd.y.toFixed(1)}" r="40" fill="${T.meet}" opacity="0.14"></circle><circle cx="${pd.x.toFixed(1)}" cy="${pd.y.toFixed(1)}" r="25" fill="${T.meet}" opacity="0.28"></circle><circle cx="${pd.x.toFixed(1)}" cy="${pd.y.toFixed(1)}" r="10" fill="${T.meet}" stroke="#fff" stroke-width="3"></circle>`;
    }

    // Labels: departures left of the meeting point get their label on the left,
    // the others on the right; labels on one side are nudged apart.
    const place = (side) => {
      const group = pins.filter((pin) => pin.p.visible && (pin.p.x <= pd.x) === (side === "left")).sort((a, b) => a.p.y - b.p.y);
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
    if (pd.visible) {
      labels += `<div class="globe-label is-dest" style="left:${pd.x.toFixed(0)}px;top:${(pd.y + 30).toFixed(0)}px;transform:translate(-50%,0)">${esc(selected.destinationName)} — meet here</div>`;
    }
  }

  // A thin orbit ring behind the globe, a satellite dot, then the globe itself.
  const rx = R + 40, ry = R * 0.3, th = 0.35, rot = (-20 * Math.PI) / 180;
  const sx = cx + rx * Math.cos(th) * Math.cos(rot) - ry * Math.sin(th) * Math.sin(rot);
  const sy = cy + rx * Math.cos(th) * Math.sin(rot) + ry * Math.sin(th) * Math.cos(rot);

  svg.innerHTML = `
    <defs>
      <radialGradient id="ocean" cx="35%" cy="28%" r="85%"><stop offset="0" stop-color="${T.oceanA}"></stop><stop offset="1" stop-color="${T.oceanB}"></stop></radialGradient>
      <clipPath id="globe-clip"><circle cx="${cx}" cy="${cy}" r="${R}"></circle></clipPath>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(-20 ${cx} ${cy})" stroke="${T.orbit}" stroke-width="2" fill="none"></ellipse>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#ocean)"></circle>
    <g clip-path="url(#globe-clip)">
      <path d="${g.dots}" stroke="${T.land}" stroke-width="3.6" stroke-linecap="round" fill="none" opacity="0.95"></path>
      ${overlay}
    </g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2" pointer-events="none"></circle>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="7" fill="${T.meet}"></circle>`;
  labelsEl.innerHTML = labels;
  $("map-hint").hidden = !(ready && destinations.length > 1);
}

// Clicking a dot on the globe selects that destination (and shows its row).
$("globe").addEventListener("click", (event) => {
  const dot = event.target.closest(".dest-dot");
  if (dot) selectDestination(dot.dataset.code, { scrollToRow: true });
});

renderGlobe();
