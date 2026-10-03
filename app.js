// ---------------------------------------------------------------------------
// Flight Plan — the page's behaviour
//
// How it fits together:
//   * You pick two airports (live autocomplete) and when you want to travel.
//   * The page asks our small Supabase Edge Function (supabase/functions/
//     search-flights) for matching destinations. That function holds the
//     Travelpayouts token safely on the server — this file never sees it.
//   * The results fill the table; the globe on the right shows the selected
//     destination (geo.js draws the globe).
//
// Sections:  1 Settings · 2 Small helpers · 3 Airport autocomplete ·
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
  origins: null,     // { a: {label, lat, lon}, b: {...} }
  sort: "cheapest",  // cheapest | fastest | stops
  selected: null,    // destination code of the highlighted row
  maxGapHours: 3,    // the arrival/return time rule used by the last search
  debug: null,       // the function's report on the last search (counts, failures...)
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

const originAInput = $("origin-a");
const originBInput = $("origin-b");
setupAutocomplete(originAInput, $("origin-a-suggestions"));
setupAutocomplete(originBInput, $("origin-b-suggestions"));


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

// Prices come back already converted, so a new currency means a new search.
currencySelect.addEventListener("change", () => {
  if (state.lastSearch) runSearch(state.lastSearch.codeA, state.lastSearch.codeB, state.lastSearch.params);
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

// Calls the Edge Function and returns { results, origins, debug }.
async function callSearchFunction(codeA, codeB, params) {
  const query = new URLSearchParams({ originA: codeA, originB: codeB, ...params });
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
  if (json.results.length > 0 && !("a" in json.results[0])) {
    throw new Error("The deployed search-flights function is running older code — redeploy supabase/functions/search-flights/index.ts in your Supabase dashboard.");
  }
  return json;
}

// Turns the function's `debug` block into a plain-English reason for "nothing found".
function explainEmptyResult(debug, gapHours) {
  if (!debug) return "No shared destinations found.";
  if (!debug.originAOk || !debug.originBOk) {
    const broken = !debug.originAOk ? debug.originA : debug.originB;
    const reason = !debug.originAOk ? debug.originAError : debug.originBError;
    return `Travelpayouts rejected the request for ${esc(broken)}${reason ? ` (${esc(reason)})` : ""} — likely the token isn't set correctly in Edge Function Secrets.`;
  }
  // Did Travelpayouts simply not answer? Then "no results" would be misleading.
  const tp = debug.travelpayouts;
  if (tp && tp.calls > 0 && tp.failed / tp.calls >= 0.1) {
    return `The flight-data service didn't answer ${tp.failed} of ${tp.calls} requests. That is a temporary glitch, not proof that there are no flights — press <strong>Find destinations</strong> again in a moment.`;
  }
  if (!debug.candidatesConsidered) {
    return `No overlap: ${esc(debug.originA)} found ${debug.originADestinationsFound} destinations, ${esc(debug.originB)} found ${debug.originBDestinationsFound}. Try two origins with more cached search volume, like STO and LON.`;
  }
  if (debug.rejectedByTimeGap > 0 && gapHours > 0) {
    return `There are ${debug.rejectedByTimeGap} dates where you both have a fare, but your arrival or return times are more than ${gapHours} hours apart. Open <strong>When</strong> and allow a bigger gap, or try other dates.`;
  }
  const foundNeither = !debug.candidatesWithOriginAData && !debug.candidatesWithOriginBData;
  const hint = foundNeither
    ? "Travelpayouts has no cached fares at all for that stay length on either side — try a different trip length."
    : "Both sides have some cached fares, they just never land on the same day — try a more common trip length (a full week tends to have more cached data than an odd number of nights).";
  return `Found ${debug.candidatesConsidered} destination${debug.candidatesConsidered === 1 ? "" : "s"} you can both reach, but no cached fare matches your dates. ${hint}`;
}

async function runSearch(codeA, codeB, params) {
  state.lastSearch = { codeA, codeB, params };
  state.maxGapHours = Number(params.maxGapHours);
  state.debug = null;
  updateWarning();
  showMessage("Searching… (this can take a few seconds)");
  searchButton.disabled = true;

  try {
    const json = await callSearchFunction(codeA, codeB, params);

    // Names and positions for the two starting points (for the globe's labels).
    const fromServer = (side) => json.origins?.[side] ?? {};
    const pick = (input, side) => ({
      label: input.dataset.label || fromServer(side).name || input.value,
      lat: Number(input.dataset.lat) || fromServer(side).lat,
      lon: Number(input.dataset.lon) || fromServer(side).lon,
    });
    state.origins = { a: pick(originAInput, "a"), b: pick(originBInput, "b") };

    state.results = json.results;
    state.debug = json.debug;
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
  const codeA = originAInput.dataset.code;
  const codeB = originBInput.dataset.code;
  if (!codeA || !codeB) return showMessage("Pick an airport or city from the dropdown for both fields.", true);

  let params;
  try {
    params = collectSearchParams();
  } catch (error) {
    return showMessage(esc(error.message), true);
  }
  setWhenOpen(false);
  runSearch(codeA, codeB, params);
});


// ===========================================================================
// 7. THE RESULTS TABLE
// ===========================================================================

const BIG = 1e9;
const travelMinutes = (r) => (r.a && r.b ? r.a.outMinutes + r.b.outMinutes : BIG);
const stopCount = (r) => (r.a && r.b ? r.a.transfers + r.b.transfers : BIG);

function sortedResults() {
  const list = [...state.results];
  if (state.sort === "fastest") list.sort((x, y) => travelMinutes(x) - travelMinutes(y) || x.total - y.total);
  else if (state.sort === "stops") list.sort((x, y) => stopCount(x) - stopCount(y) || x.total - y.total);
  else list.sort((x, y) => x.total - y.total);
  return list;
}

const TAG_FOR_SORT = { cheapest: "CHEAPEST", fastest: "FASTEST", stops: "FEWEST STOPS" };

// One traveller's block inside a row: price, duration, stops, flight times.
function travelerHtml(kind, cityLabel, leg, price, currency) {
  const you = kind === "you";
  const head = `<span class="dot ${you ? "dot-you" : "dot-them"}"></span><span class="who">${you ? "You" : "Them"} · ${esc(cityLabel)}</span><span class="traveler-price">${formatPrice(price, currency)}</span>`;
  if (!leg) return `<div class="traveler"><div class="traveler-head">${head}</div><div class="times">Flight details not available</div></div>`;

  const meta = leg.timesKnown
    ? `<span class="traveler-meta">· ≈${durationLabel(leg.outMinutes)} · <span class="${leg.transfers === 0 ? "direct" : ""}">${stopsLabel(leg.transfers)}</span></span>`
    : `<span class="traveler-meta">· <span class="${leg.transfers === 0 ? "direct" : ""}">${stopsLabel(leg.transfers)}</span></span>`;

  const times = leg.timesKnown
    ? `Out <strong>${hhmm(leg.outDepart)} → ≈${hhmm(leg.outArrive)}</strong>${dayShiftMarker(leg.outDepart, leg.outArrive)} · Back <strong>${hhmm(leg.retDepart)} → ≈${hhmm(leg.retArrive)}</strong>${dayShiftMarker(leg.retDepart, leg.retArrive)}`
    : "Flight times not available for this fare";

  return `<div class="traveler"><div class="traveler-head">${head}${meta}</div><div class="times">${times}</div></div>`;
}

function rowHtml(r, index, currency) {
  const gapNote =
    r.arrivalGapHours != null
      ? `<div class="gap-note">Your arrivals are <b>≈${hoursLabel(r.arrivalGapHours)}</b> apart · your return flights <b>≈${hoursLabel(r.returnGapHours)}</b> apart</div>`
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
        ${travelerHtml("you", state.origins.a.label, r.a, r.priceA, currency)}
        ${travelerHtml("them", state.origins.b.label, r.b, r.priceB, currency)}
        ${gapNote}
      </div>
      <div class="total-cell">
        <div class="total">${formatPrice(r.total, currency)}</div>
        <div class="total-sub">both of you</div>
        <span class="select-btn">Select</span>
      </div>
    </div>`;
}

function renderTable() {
  const list = sortedResults();
  if (!list.some((r) => r.destination === state.selected)) state.selected = list[0].destination;

  const currency = state.lastSearch.params.currency;
  rowsEl.innerHTML = list.map((r, i) => rowHtml(r, i, currency)).join("");

  const gapText = state.maxGapHours > 0 ? ` · arrivals and returns within ${state.maxGapHours}h of each other` : "";
  const d = state.debug;
  const checkedText = d && d.sharedDestinations ? ` (checked ${d.candidatesConsidered} of the ${d.sharedDestinations} you can both reach)` : "";
  $("results-subtitle").textContent = `Showing ${list.length} destination${list.length === 1 ? "" : "s"}${checkedText} · same dates for both of you${gapText}`;
  updateWarning();
  renderGlobe();
}

// A small notice when Travelpayouts didn't answer some requests, so a short
// list isn't mistaken for "that's all there is".
function updateWarning() {
  const box = $("results-warning");
  const tp = state.debug?.travelpayouts;
  if (tp && tp.failed > 0 && state.results.length > 0) {
    box.innerHTML = `<span>Heads-up: the flight-data service didn't answer ${tp.failed} of ${tp.calls} requests, so a few options may be missing.</span><button type="button" id="retry-search">Try again</button>`;
    box.hidden = false;
  } else {
    box.innerHTML = "";
    box.hidden = true;
  }
}

$("results-warning").addEventListener("click", (event) => {
  if (event.target.id === "retry-search" && state.lastSearch) runSearch(state.lastSearch.codeA, state.lastSearch.codeB, state.lastSearch.params);
});

function selectDestination(code) {
  if (code === state.selected) return;
  state.selected = code;
  rowsEl.querySelectorAll(".row").forEach((row) => row.classList.toggle("is-selected", row.dataset.code === code));
  renderGlobe();
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

function renderGlobe() {
  const svg = $("globe");
  const labelsEl = $("globe-labels");
  const R = GLOBE_RADIUS;

  const selected = state.results.find((r) => r.destination === state.selected);
  const a = state.origins?.a;
  const b = state.origins?.b;
  const havePlaces = selected && a && b && [a.lat, a.lon, b.lat, b.lon, selected.lat, selected.lon].every((n) => Number.isFinite(n));

  // No search yet (or no positions): a calm empty globe over the Atlantic.
  const points = havePlaces ? [a, b, { lat: selected.lat, lon: selected.lon }] : [];
  const g = Geo.createGlobe(points, R, havePlaces ? null : { lat: 35, lon: -30 });
  const { cx, cy } = g;

  let overlay = "";
  let labels = "";
  if (havePlaces) {
    const dest = { lat: selected.lat, lon: selected.lon };
    const pa = g.project(a.lat, a.lon);
    const pb = g.project(b.lat, b.lon);
    const pd = g.project(dest.lat, dest.lon);

    overlay += `<path d="${g.arc(a, dest)}" stroke="#FFC9A8" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none"></path>`;
    overlay += `<path d="${g.arc(b, dest)}" stroke="#FFC9A8" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 7" fill="none"></path>`;

    const origin = (p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="17" fill="none" stroke="#fff" stroke-width="2" opacity="0.5"></circle><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="7" fill="#fff" stroke="#5B3FA8" stroke-width="3"></circle>`;
    const meeting = (p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="40" fill="#FFC9A8" opacity="0.14"></circle><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="25" fill="#FFC9A8" opacity="0.28"></circle><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="10" fill="#FFC9A8" stroke="#fff" stroke-width="3"></circle>`;
    if (pa.visible) overlay += origin(pa);
    if (pb.visible) overlay += origin(pb);
    if (pd.visible) overlay += meeting(pd);

    // Labels: the left-most traveller's label goes left, the other goes right.
    const leftFirst = pa.x <= pb.x;
    const label = (p, text, transform, dx, dy, extraClass = "") =>
      p.visible ? `<div class="globe-label${extraClass}" style="left:${(p.x + dx).toFixed(0)}px;top:${(p.y + dy).toFixed(0)}px;transform:${transform}">${esc(text)}</div>` : "";
    labels += label(pa, `${a.label} · You`, leftFirst ? "translate(-100%,-50%)" : "translate(0,-50%)", leftFirst ? -20 : 20, 0);
    labels += label(pb, `${b.label} · Them`, leftFirst ? "translate(0,-50%)" : "translate(-100%,-50%)", leftFirst ? 20 : -20, 0);
    labels += label(pd, `${selected.destinationName} — meet here`, "translate(-50%,0)", 0, 30, " is-dest");
  }

  // A thin orbit ring behind the globe, a satellite dot, then the globe itself.
  const rx = R + 40, ry = R * 0.3, th = 0.35, rot = (-20 * Math.PI) / 180;
  const sx = cx + rx * Math.cos(th) * Math.cos(rot) - ry * Math.sin(th) * Math.sin(rot);
  const sy = cy + rx * Math.cos(th) * Math.sin(rot) + ry * Math.sin(th) * Math.cos(rot);

  svg.innerHTML = `
    <defs>
      <radialGradient id="ocean" cx="35%" cy="28%" r="85%"><stop offset="0" stop-color="#7B5BD0"></stop><stop offset="1" stop-color="#2E1B6B"></stop></radialGradient>
      <clipPath id="globe-clip"><circle cx="${cx}" cy="${cy}" r="${R}"></circle></clipPath>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(-20 ${cx} ${cy})" stroke="rgba(91,63,168,0.35)" stroke-width="2" fill="none"></ellipse>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#ocean)"></circle>
    <g clip-path="url(#globe-clip)">
      <path d="${g.dots}" stroke="#FFD9C7" stroke-width="3.6" stroke-linecap="round" fill="none" opacity="0.95"></path>
      ${overlay}
    </g>
    <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="rgba(255,255,255,0.16)" stroke-width="2"></circle>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="7" fill="#FFC9A8"></circle>`;
  labelsEl.innerHTML = labels;
}

renderGlobe();
