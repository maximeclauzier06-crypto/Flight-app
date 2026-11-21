// ---------------------------------------------------------------------------
// Halfway Trips — the Account page (account.html)
//
// Signed out: your email → we send a link (and a code) → you're in.
// Signed in: your saved trips (each opens again: "See this trip"), your 5
// latest searches ("Search again"; the newest one's airports are filled in
// for you), "Sign out" and "Delete my account".
// Signing in and the database calls are in auth.js (window.htAuth).
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const today = new Date().toISOString().slice(0, 10);

// "Sat Nov 7", as on the home page
const WEEKDAY = new Intl.DateTimeFormat("en", { weekday: "short", timeZone: "UTC" });
const MONTH_DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso) => `${WEEKDAY.format(new Date(`${iso}T00:00:00Z`))} ${MONTH_DAY.format(new Date(`${iso}T00:00:00Z`))}`;
const price = (amount, currency) => new Intl.NumberFormat(undefined, { style: "currency", currency: (currency || "usd").toUpperCase(), maximumFractionDigits: 0 }).format(amount);

function showMessage(text, isError = false) {
  const box = $("acc-message");
  box.textContent = text;
  box.classList.toggle("is-error", isError);
  box.hidden = !text;
}

// Which view: signing in, or your account.
// Signed in, the page has two columns (styles.css, "is-in"): your account and
// "New price alert" on the left, your alerts, trips and searches on the right.
function render() {
  const user = htAuth.user();
  $("acc-page").classList.toggle("is-in", Boolean(user));
  $("acc-out").hidden = Boolean(user);
  $("acc-in").hidden = !user;
  $("acc-new").hidden = !user;
  $("acc-title").textContent = user ? "Your account" : "Sign in";
  $("acc-intro").hidden = Boolean(user);
  $("acc-who").hidden = !user;
  $("acc-signout").hidden = !user;
  if (user) {
    $("acc-who-email").textContent = user.email;
    $("af-small").textContent = `Emails go to ${user.email} · pause or stop any time · up to ${MAX_ALERTS} alerts`;
    resetAlertForm();
    loadAlerts();
    loadTrips();
    loadSearches();
  }
}


// ---- Signing in -------------------------------------------------------------

// (The email you typed is kept for this tab only, for the code that follows.)
const pendingEmail = {
  get: () => sessionStorage.getItem("ht-email") || "",
  set: (email) => (email ? sessionStorage.setItem("ht-email", email) : sessionStorage.removeItem("ht-email")),
};

function showCodeStep(email) {
  $("acc-email-form").hidden = Boolean(email);
  $("acc-code-form").hidden = !email;
  $("acc-sent-to").textContent = email;
  if (email) $("acc-code").focus();
}

const friendly = (error) =>
  error.status === 429 ? "Please wait a minute before asking for another email — and use the newest one you get."
  : /expired|invalid/i.test(error.message) ? "That code didn't work. If you asked for more than one email, only the newest one works — or ask for a new one."
  : error.message;

// "Send it again": after a minute (Supabase sends at most one email a minute
// to the same address). Asking again makes the email before stop working, so
// people are told to wait for it first, and to use the newest one.
const RESEND_AFTER_S = 60;
let resendTimer = 0;
function waitBeforeResend() {
  const button = $("acc-resend");
  const until = Date.now() + RESEND_AFTER_S * 1000;
  clearInterval(resendTimer);
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    button.disabled = left > 0;
    button.textContent = left > 0 ? `Send it again in ${left} s` : "Didn't get it? Send it again";
    if (left <= 0) clearInterval(resendTimer);
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

$("acc-email-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("acc-email").value.trim();
  const button = event.submitter;
  button.disabled = true;
  showMessage("");
  try {
    await htAuth.sendLink(email);
    pendingEmail.set(email);
    showCodeStep(email);
    waitBeforeResend();
  } catch (error) {
    showMessage(friendly(error), true);
  } finally {
    button.disabled = false;
  }
});

$("acc-resend").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  showMessage("");
  try {
    await htAuth.sendLink(pendingEmail.get());
    showMessage("We sent you a new email. Use that one: the link and code in the earlier email no longer work.");
    waitBeforeResend();
  } catch (error) {
    showMessage(friendly(error), true);
    button.disabled = false;
  }
});

$("acc-code-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showMessage("");
  try {
    await htAuth.verifyCode(pendingEmail.get(), $("acc-code").value.trim());
    pendingEmail.set("");
    render();
  } catch (error) {
    showMessage(friendly(error), true);
  } finally {
    button.disabled = false;
  }
});

// For testing: a password, on a test account (auth.js, 2c). Only on your own
// computer, or with #password at the end of the address.
$("acc-password-form").hidden = !(["localhost", "127.0.0.1"].includes(location.hostname) || location.hash === "#password");
$("acc-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  showMessage("");
  try {
    await htAuth.signInWithPassword($("acc-test-email").value.trim(), $("acc-test-password").value);
    $("acc-test-password").value = "";
    render();
  } catch (error) {
    showMessage(/invalid/i.test(error.message) ? "Wrong email or password." : error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("acc-again").addEventListener("click", () => {
  clearInterval(resendTimer);
  pendingEmail.set("");
  showCodeStep("");
  showMessage("");
  $("acc-email").focus();
});

$("acc-signout").addEventListener("click", async () => {
  await htAuth.signOut();
  showMessage("You're signed out.");
  render();
});


// ---- Your saved trips -------------------------------------------------------

let trips = [];

// Where a saved trip leads: the home page, filled in with it, searching
// straight away (in the currency it was saved in).
//  - a trip still to come: "See this trip" — its own page, with today's prices
//    and the price you saved it at (app.js, section 9);
//  - a good place: "Choose your dates" — its coming weekends (or weeks);
//  - a trip whose dates have passed: "Find new dates" — the same kind of stay.
function tripLink(t) {
  const q = new URLSearchParams();
  for (const o of t.origins) q.append("from", `${o.code}:${o.label}:${o.count || 1}`);
  q.set("to", t.destination);
  q.set("name", t.destination_name);
  if (t.kind === "trip" && t.depart_date > today) {
    q.set("depart", t.depart_date);
    q.set("return", t.return_date);
    q.set("open", "1");
    if (t.total != null) q.set("was", String(t.total));
  } else {
    q.set("stay", t.nights === 2 ? "weekend" : t.nights === 3 ? "long" : "week");
  }
  if (t.currency) q.set("cur", t.currency);
  q.set("go", "1");
  return `index.html?${q}`;
}

const CHEVRON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>';

// One saved trip: the whole card opens it; "Remove" sits on top.
function tripHtml(t) {
  const from = t.origins.map((o) => esc(o.label)).join(" + ");
  const passed = t.kind === "trip" && t.depart_date <= today;
  const when = t.kind === "place" ? "A good place · dates to choose"
    : `${day(t.depart_date)} – ${day(t.return_date)}${passed ? " · these dates have passed" : ""}`;
  const go = t.kind === "place" ? "Choose your dates" : passed ? "Find new dates" : "See this trip";
  const total = t.total == null ? "" : `<div class="acc-trip-price">${t.kind === "place" ? '<span class="acc-from">from</span> ' : ""}${price(t.total, t.currency)}<small>when you saved it</small></div>`;
  return `
    <div class="acc-trip${passed ? " is-past" : ""}">
      <div class="acc-trip-main">
        <div class="r-name">${esc(t.destination_name)}${t.country ? ` <span>${esc(t.country)}</span>` : ""}</div>
        <div class="acc-trip-when">${when}</div>
        <div class="acc-trip-from">From ${from}</div>
      </div>
      ${total}
      <div class="acc-trip-actions">
        <a class="acc-trip-open" href="${esc(tripLink(t))}">${go}${CHEVRON}</a>
        <button type="button" class="acc-link-btn acc-remove" data-remove="${esc(t.id)}">Remove</button>
      </div>
    </div>`;
}

function renderTrips() {
  $("acc-trips").innerHTML = trips.length
    ? trips.map(tripHtml).join("")
    : '<p class="acc-empty">Nothing saved yet. On a trip\'s page, press <b>♡ Save</b> to keep it here — with the price you saw.</p>';
}

async function loadTrips() {
  $("acc-trips").innerHTML = '<p class="acc-empty">Loading your trips…</p>';
  try {
    trips = await htAuth.rest("saved_trips?select=*&order=created_at.desc");
    renderTrips();
  } catch (error) {
    $("acc-trips").innerHTML = `<p class="acc-empty">Your trips couldn't be loaded: ${esc(error.message)}</p>`;
  }
}

$("acc-trips").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  button.disabled = true;
  try {
    await htAuth.rest(`saved_trips?id=eq.${encodeURIComponent(button.dataset.remove)}`, { method: "DELETE" });
    trips = trips.filter((t) => t.id !== button.dataset.remove);
    renderTrips();
  } catch (error) {
    button.disabled = false;
    showMessage(error.message, true);
  }
});


// ---- Your latest searches ---------------------------------------------------

// The 5 newest searches you made while signed in (app.js keeps them, section
// 9), each with "Search again". The airports of the newest one are also
// filled in for you when you open the search.

const STAY_WORDS = { weekend: "Weekend", long: "Long weekend", week: "Full week" };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

function searchWhen(s) {
  if (s.depart) return `${day(s.depart)} – ${day(s.return)}${s.depart <= today ? " · these dates have passed" : ""}`;
  return STAY_WORDS[s.stay] ?? `${s.nights} night${s.nights === 1 ? "" : "s"}`;
}

// "searched today", "searched yesterday", "searched 3 days ago", or "searched Nov 2"
function searchedAgo(iso) {
  const days = daysBetween(iso.slice(0, 10), today);
  if (days <= 0) return "searched today";
  if (days === 1) return "searched yesterday";
  return `searched ${days < 7 ? `${days} days ago` : MONTH_DAY.format(new Date(iso))}`;
}

// The same search again (dates that have passed: the same number of nights instead)
function searchLink(s) {
  const q = new URLSearchParams();
  for (const o of s.origins) q.append("from", `${o.code}:${o.label}:${o.count || 1}`);
  if (s.to) {
    q.set("to", s.to);
    q.set("name", s.toName || s.to);
  }
  if (s.depart && s.depart > today) {
    q.set("depart", s.depart);
    q.set("return", s.return);
  } else if (s.stay in STAY_WORDS) {
    q.set("stay", s.stay);
  } else {
    q.set("nights", String(s.nights || daysBetween(s.depart, s.return)));
  }
  q.set("go", "1");
  return `index.html?${q}`.replace(/%3A/gi, ":");
}

function searchHtml(s, index) {
  const from = s.origins.map((o) => esc(o.label) + (o.count > 1 ? ` ×${o.count}` : "")).join(" + ");
  return `
    <div class="acc-search">
      <div class="acc-search-main">
        <div class="acc-search-what">${from} <span class="acc-arrow">→</span> ${esc(s.to ? s.toName || s.to : "Anywhere")}</div>
        <div class="acc-search-when">${esc(searchWhen(s))} · ${esc(searchedAgo(s.at))}</div>
      </div>
      <span class="acc-search-end">
        <button type="button" class="acc-link-btn acc-make-alert" data-search="${index}">Make an alert</button>
        <a class="acc-trip-open" href="${esc(searchLink(s))}">Search again${CHEVRON}</a>
      </span>
    </div>`;
}

let latest = []; // your latest searches, newest first (for "Make an alert" and "Fill in my latest search")

async function loadSearches() {
  const box = $("acc-searches");
  try {
    const [profile] = await htAuth.rest("profiles?select=*");
    const searches = profile?.searches ?? [];
    const airports = profile?.airports ?? [];
    latest = searches;
    $("af-latest").hidden = searches.length === 0;
    if (!formTouched && !editing && searches.length) fillFromSearch(searches[0], { quiet: true });
    if (searches.length) {
      box.innerHTML = `${searches.map(searchHtml).join("")}
        <p class="acc-searches-note">We fill in the airports of the newest one for you when you open the search. <button type="button" class="acc-link-btn" id="acc-forget">Forget them all</button></p>`;
    } else if (airports.length) {
      // (from before the latest searches were kept: only the airports)
      box.innerHTML = `<p><b>${airports.map((a) => esc(a.label)).join(" + ")}</b> — the airports of your last search. We fill them in for you when you open the search. <button type="button" class="acc-link-btn" id="acc-forget">Forget them</button></p>`;
    } else {
      box.innerHTML = '<p class="acc-empty">None yet. Your next searches show up here, so you can run them again in one tap.</p>';
    }
  } catch (error) {
    box.innerHTML = `<p class="acc-empty">Your latest searches couldn't be loaded: ${esc(error.message)}</p>`;
  }
}

$("acc-searches").addEventListener("click", async (event) => {
  const make = event.target.closest(".acc-make-alert");
  if (make) return fillFromSearch(latest[Number(make.dataset.search)], { open: true });
  if (event.target.id !== "acc-forget") return;
  event.target.disabled = true;
  try {
    await htAuth.rest(`profiles?user_id=eq.${encodeURIComponent(htAuth.user().id)}`, { method: "DELETE" });
    loadSearches();
  } catch (error) {
    event.target.disabled = false;
    showMessage(error.message, true);
  }
});


// ---- Your price alerts --------------------------------------------------------

// An alert (table price_alerts, supabase/alerts.sql): everyone's airports,
// where (or Anywhere), the kind of trip, the months you'd leave in and the
// most you'd pay in total. Every morning the price-alerts function checks it
// with the same search as the home page and emails you when a trip is under
// your price; right after you make or change one, it's checked once straight
// away. On the left, the form ("New price alert", or changing one); on the
// right, your alerts with what the last check found.

const MAX_ALERTS = 5;
const MONTHS_AHEAD = 4; // the months a search covers (FLEXIBLE_SEARCH_MONTHS in search-flights)
const CURRENCIES = ["usd", "eur", "gbp", "sek", "nok", "dkk", "chf", "pln", "cad", "aud", "nzd", "jpy", "rub", "try", "inr", "brl", "mxn"];
const AUTOCOMPLETE_URL = "https://autocomplete.travelpayouts.com/places2"; // (as on the home page: public, no key)
const MONTH_YEAR = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const MONTH_ONLY = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const BELL_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"></path><path d="M10 20a2 2 0 0 0 4 0"></path></svg>';

let alerts = [];
let editing = null;      // the id of the alert being changed (null: making a new one)
let formTouched = false; // (once you've typed something, nothing fills the form in for you)

const track = (name, data) => {
  try {
    window.umami?.track(name, data);
  } catch {}
};
const peopleOf = (origins) => origins.reduce((sum, o) => sum + (o.count || 1), 0);
const forPeople = (n) => (n === 2 ? "for both of you" : `for all ${n} of you`);
const monthWords = (iso) => MONTH_ONLY.format(new Date(`${iso}T00:00:00Z`));
const monthsWords = (a) => (a.month_from === a.month_to ? monthWords(a.month_from) : `${monthWords(a.month_from)} – ${monthWords(a.month_to)}`);
const stayWords = (a) => STAY_WORDS[a.stay] ?? `${a.nights} night${a.nights === 1 ? "" : "s"}`;

// The months you can choose: this one and the next three ("2026-11-01" ...)
function comingMonths() {
  const now = new Date();
  return Array.from({ length: MONTHS_AHEAD }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)).toISOString().slice(0, 10));
}

// The currency to start with: the one you chose on the home page (this
// device), the one of your newest saved trip, or a guess from your time zone.
function startCurrency() {
  try {
    const picked = localStorage.getItem("ht-currency");
    if (CURRENCIES.includes(picked)) return picked;
  } catch {}
  if (trips[0]?.currency) return trips[0].currency;
  let zone = "";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {}
  const byZone = { "Europe/Stockholm": "sek", "Europe/Oslo": "nok", "Europe/Copenhagen": "dkk", "Europe/London": "gbp", "Europe/Zurich": "chf", "Europe/Warsaw": "pln" };
  return byZone[zone] ?? (zone.startsWith("Europe/") ? "eur" : zone.startsWith("America/") ? "usd" : "eur");
}


// --- The form: airports (with suggestions, as on the home page) -------------

function suggestPlaces(term) {
  const params = new URLSearchParams({ locale: "en", term });
  params.append("types[]", "city");
  params.append("types[]", "airport");
  return fetch(`${AUTOCOMPLETE_URL}?${params}`)
    .then((response) => response.json())
    .then((items) => items.slice().sort((a, b) => b.weight - a.weight).slice(0, 6))
    .catch(() => []);
}
const describePlace = (item) =>
  item.type === "airport" ? `${item.name}, ${item.city_name ?? ""} · ${item.country_name}`.replace(", ·", " ·") : `${item.name} (city — all airports) · ${item.country_name}`;

// Typing in `input` shows matching places in `list`; picking one keeps its
// code and name on the input (data-code, data-label).
function withSuggestions(input, list) {
  let items = [];
  let active = -1;
  let asked = 0;
  let timer = 0;
  const close = () => {
    list.innerHTML = "";
    items = [];
    active = -1;
  };
  const pick = (item) => {
    input.value = `${item.name} (${item.code})`;
    input.dataset.code = item.code;
    input.dataset.label = item.type === "airport" ? item.city_name || item.name : item.name;
    close();
    updateFormWords();
  };
  const show = () => {
    list.innerHTML = items.map((item, i) => `<li role="option" class="${i === active ? "active" : ""}"><span class="code">${esc(item.code)}</span> — <span class="detail">${esc(describePlace(item))}</span></li>`).join("");
    [...list.children].forEach((li, i) => li.addEventListener("mousedown", (event) => {
      event.preventDefault();
      pick(items[i]);
    }));
  };
  input.addEventListener("input", () => {
    delete input.dataset.code;
    delete input.dataset.label;
    const term = input.value.trim();
    clearTimeout(timer);
    if (term.length < 2) return close();
    timer = setTimeout(() => {
      const mine = ++asked;
      suggestPlaces(term).then((found) => {
        if (mine !== asked) return;
        items = found;
        active = -1;
        show();
      });
    }, 200);
  });
  input.addEventListener("keydown", (event) => {
    if (!items.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      show();
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      pick(items[active]);
    } else if (event.key === "Escape") {
      close();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
}

const placeValue = (place) => (place?.code ? `${place.label} (${place.code})` : "");

// One "Who's travelling" row: the airport, and how many people leave from it.
function addPerson(place = null, count = 1) {
  const row = document.createElement("div");
  row.className = "af-person";
  row.innerHTML = `
    <div class="af-place"><input type="text" class="af-input af-wide" placeholder="City or airport" autocomplete="off" aria-label="Departure"><ul class="suggestions" role="listbox"></ul></div>
    <span class="af-count" aria-label="People"><button type="button" data-step="-1" aria-label="One person less">−</button><b>${count}</b><button type="button" data-step="1" aria-label="One person more">+</button></span>
    <button type="button" class="af-remove" aria-label="Remove this departure">×</button>`;
  const input = row.querySelector("input");
  if (place?.code) {
    input.value = placeValue(place);
    input.dataset.code = place.code;
    input.dataset.label = place.label;
  }
  withSuggestions(input, row.querySelector(".suggestions"));
  $("af-people").append(row);
  updateFormWords();
  return input;
}

function readPeople() {
  return [...$("af-people").children].map((row) => {
    const input = row.querySelector("input");
    return { code: input.dataset.code ?? "", label: input.dataset.label ?? input.value.trim(), count: Number(row.querySelector(".af-count b").textContent) };
  });
}

$("af-people").addEventListener("click", (event) => {
  const row = event.target.closest(".af-person");
  if (!row) return;
  const step = event.target.closest("[data-step]");
  if (step) {
    const b = row.querySelector(".af-count b");
    b.textContent = String(Math.min(9, Math.max(1, Number(b.textContent) + Number(step.dataset.step))));
  }
  if (event.target.closest(".af-remove") && $("af-people").children.length > 2) row.remove();
  formTouched = true;
  updateFormWords();
});
$("af-add").addEventListener("click", () => {
  if ($("af-people").children.length < 8) addPerson().focus();
});
$("af-latest").addEventListener("click", () => latest[0] && fillFromSearch(latest[0]));


// --- The form: the other choices ---------------------------------------------

function setChip(attribute, value) {
  document.querySelectorAll(`#alert-form [data-${attribute}]`).forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset[attribute] === value)));
  if (attribute === "to") $("af-city-box").hidden = value !== "city";
  if (attribute === "stay") $("af-nights-box").hidden = value !== "nights";
}
const chipValue = (attribute) => document.querySelector(`#alert-form [data-${attribute}][aria-pressed="true"]`)?.dataset[attribute];

$("alert-form").addEventListener("click", (event) => {
  const chip = event.target.closest(".af-chip");
  if (!chip) return;
  const [attribute] = Object.keys(chip.dataset);
  setChip(attribute, chip.dataset[attribute]);
  if (attribute === "to" && chip.dataset.to === "city") $("af-city").focus();
  formTouched = true;
});
$("alert-form").addEventListener("input", () => {
  formTouched = true;
  updateFormWords();
});
withSuggestions($("af-city"), $("af-city-box").querySelector(".suggestions"));

// "in total, for all 3 of you" and "≈ 667 kr each"
function updateFormWords() {
  const n = peopleOf(readPeople());
  const total = Number($("af-price").value);
  $("af-for").textContent = `in total, ${forPeople(n)}`;
  $("af-each").textContent = total > 0 ? `≈ ${price(total / n, $("af-currency").value)} each` : "The most you'd pay for everyone's flights together";
}

function fillMonths(from, to) {
  const months = comingMonths();
  for (const id of ["af-from", "af-to"]) $(id).innerHTML = months.map((m) => `<option value="${m}">${MONTH_YEAR.format(new Date(`${m}T00:00:00Z`))}</option>`).join("");
  $("af-from").value = months.includes(from) ? from : months[0];
  $("af-to").value = months.includes(to) ? to : months.at(-1);
}

// Back to an empty "New price alert"
function resetAlertForm() {
  editing = null;
  formTouched = false;
  $("af-title").textContent = "New price alert";
  $("af-submit").textContent = "Create the alert";
  $("af-cancel").hidden = true;
  $("af-error").hidden = true;
  $("af-people").innerHTML = "";
  addPerson();
  addPerson();
  setChip("to", "any");
  $("af-city").value = "";
  delete $("af-city").dataset.code;
  setChip("stay", "weekend");
  $("af-nights").value = "5";
  fillMonths();
  $("af-price").value = "";
  if (!$("af-currency").options.length) $("af-currency").innerHTML = CURRENCIES.map((c) => `<option value="${c}">${c.toUpperCase()}</option>`).join("");
  $("af-currency").value = startCurrency();
  $("af-gap").checked = true;
  $("af-direct").checked = false;
  document.querySelector('input[name="af-often"][value="daily"]').checked = true;
  if (latest[0]) fillFromSearch(latest[0], { quiet: true });
  updateFormWords();
}

function setPeople(origins) {
  $("af-people").innerHTML = "";
  for (const o of origins) addPerson(o, o.count || 1);
}
function setCity(code, name) {
  setChip("to", code ? "city" : "any");
  $("af-city").value = code ? placeValue({ code, label: name || code }) : "";
  if (code) Object.assign($("af-city").dataset, { code, label: name || code });
  else delete $("af-city").dataset.code;
}

// "Make an alert" on a latest search, or "Fill in my latest search"
function fillFromSearch(s, { quiet = false, open = false } = {}) {
  if (!s) return;
  setPeople(s.origins);
  setCity(s.to, s.toName);
  if (s.stay in STAY_WORDS) setChip("stay", s.stay);
  else {
    setChip("stay", "nights");
    $("af-nights").value = String(s.nights || daysBetween(s.depart, s.return) || 5);
  }
  const month = s.depart && s.depart > today ? `${s.depart.slice(0, 7)}-01` : null;
  fillMonths(month ?? undefined, month ?? undefined);
  updateFormWords();
  if (!quiet) {
    formTouched = true;
    openForm();
    $("af-price").focus();
  } else if (open) openForm();
}

// Your alert back in the form, to change it
function fillFromAlert(a) {
  editing = a.id;
  formTouched = true;
  $("af-title").textContent = "Change your alert";
  $("af-submit").textContent = "Save the changes";
  $("af-cancel").hidden = false;
  $("af-error").hidden = true;
  setPeople(a.origins);
  setCity(a.destination, a.destination_name);
  setChip("stay", a.stay);
  $("af-nights").value = String(a.nights);
  fillMonths(a.month_from, a.month_to);
  $("af-price").value = String(Math.round(a.max_total));
  $("af-currency").value = a.currency;
  $("af-gap").checked = a.max_gap_hours > 0;
  $("af-direct").checked = a.direct_only;
  document.querySelector(`input[name="af-often"][value="${a.frequency}"]`).checked = true;
  updateFormWords();
  openForm();
}

// (phones: the form opens from its button; elsewhere it's always open)
function openForm() {
  $("acc-new").classList.add("is-open");
  $("acc-new").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("acc-new-open").addEventListener("click", () => {
  $("acc-new").classList.add("is-open");
  $("af-people").querySelector("input")?.focus();
});
$("af-cancel").addEventListener("click", () => {
  resetAlertForm();
  $("acc-new").classList.remove("is-open");
});

// The form → a row for the database (or the reason it can't be one)
function alertFromForm() {
  const origins = readPeople();
  if (origins.some((o) => !o.code)) throw new Error("Pick every departure from the list that opens while you type (or remove an empty one with ×).");
  if (new Set(origins.map((o) => o.code)).size !== origins.length) throw new Error("Two departures are the same place: use the + on that one for more people instead.");
  const to = chipValue("to") === "city" ? $("af-city").dataset.code : null;
  if (chipValue("to") === "city" && !to) throw new Error("Pick the city from the list that opens while you type — or choose Anywhere.");
  if (to && origins.some((o) => o.code === to)) throw new Error("The city you're going to is also a departure: pick another one.");
  const stay = chipValue("stay");
  const nights = stay === "nights" ? Number($("af-nights").value) : { weekend: 2, long: 3, week: 7 }[stay];
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) throw new Error("The number of nights: a whole number from 1 to 30.");
  const [from, until] = [$("af-from").value, $("af-to").value];
  if (until < from) throw new Error("The last month comes before the first one.");
  const total = Math.round(Number($("af-price").value));
  if (!(total > 0)) throw new Error("Your price: the most you'd pay in total, for everyone (for example 2000).");
  return {
    origins: origins.map(({ code, label, count }) => ({ code, label, count })),
    destination: to,
    destination_name: to ? $("af-city").dataset.label : null,
    stay,
    nights,
    month_from: from,
    month_to: until,
    max_total: total,
    currency: $("af-currency").value,
    max_gap_hours: $("af-gap").checked ? 3 : 0,
    direct_only: $("af-direct").checked,
    frequency: document.querySelector('input[name="af-often"]:checked').value,
  };
}

// What the last check found, wiped when an alert changes
const FRESH = { checked_at: null, cheapest_total: null, matches: null, match_count: null, emailed_at: null, emailed_sig: null, emailed_total: null, last_error: null };

$("alert-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("af-submit");
  let row;
  try {
    row = alertFromForm();
  } catch (error) {
    $("af-error").textContent = error.message;
    $("af-error").hidden = false;
    return;
  }
  $("af-error").hidden = true;
  button.disabled = true;
  try {
    let saved;
    if (editing) {
      [saved] = await htAuth.rest(`price_alerts?id=eq.${encodeURIComponent(editing)}`, { method: "PATCH", body: { ...row, ...FRESH }, prefer: "return=representation" });
      alerts = alerts.map((a) => (a.id === saved.id ? saved : a));
    } else {
      [saved] = await htAuth.rest("price_alerts", { method: "POST", body: row, prefer: "return=representation" });
      alerts.push(saved);
    }
    track(editing ? "alert-change" : "alert-create", { kind: row.destination ? "city" : "anywhere", to: row.destination ?? "anywhere", stay: row.stay, travellers: peopleOf(row.origins), currency: row.currency, direct: row.direct_only, often: row.frequency });
    resetAlertForm();
    $("acc-new").classList.remove("is-open");
    checkNow(saved.id);
    $("acc-alerts").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    $("af-error").textContent = /up to 5/.test(error.message) ? `You can have up to ${MAX_ALERTS} price alerts. Delete one to make a new one.` : `Couldn't save it: ${error.message}`;
    $("af-error").hidden = false;
  } finally {
    button.disabled = false;
  }
});


// --- The list: your alerts ----------------------------------------------------

const checking = new Set(); // alerts being checked right now

// Right after making (or changing, or turning on) an alert: one check straight away
async function checkNow(id) {
  checking.add(id);
  renderAlerts();
  try {
    const { alert } = await htAuth.fn("price-alerts", { action: "check", id });
    if (alert) alerts = alerts.map((a) => (a.id === id ? alert : a));
  } catch {
    // (the check function isn't set up yet, or didn't answer: the morning check will do it)
  } finally {
    checking.delete(id);
    renderAlerts();
  }
}

function checkedWords(a) {
  if (!a.checked_at) return "Not checked yet · we look every morning";
  const when = a.checked_at.slice(0, 10) === today
    ? `today at ${TIME.format(new Date(a.checked_at))}`
    : MONTH_DAY.format(new Date(a.checked_at));
  const emailed = a.emailed_at && a.emailed_at.slice(0, 10) === a.checked_at.slice(0, 10) ? " · we emailed you" : "";
  return `Checked ${when}${emailed}`;
}

function alertLink(a, m) {
  const q = new URLSearchParams();
  for (const o of a.origins) q.append("from", `${o.code}:${o.label}:${o.count || 1}`);
  q.set("to", m.destination);
  q.set("name", m.name);
  q.set("depart", m.depart);
  q.set("return", m.return);
  q.set("open", "1");
  q.set("cur", a.currency);
  q.set("go", "1");
  return `index.html?${q}`.replace(/%3A/gi, ":");
}

function alertHtml(a) {
  const from = a.origins.map((o) => esc(o.label) + (o.count > 1 ? ` ×${o.count}` : "")).join(" + ");
  const n = peopleOf(a.origins);
  const rule = [
    stayWords(a),
    `leaving ${monthsWords(a)}`,
    `up to ${price(a.max_total, a.currency)} ${n === 2 ? "for both" : `for all ${n}`}`,
    a.max_gap_hours ? `everyone within ${a.max_gap_hours} h` : "",
    a.direct_only ? "direct flights only" : "",
    a.frequency === "weekly" ? "one email a week" : "",
  ].filter(Boolean).join(" · ");
  const best = a.matches?.[0];
  let tag;
  let body = "";
  if (checking.has(a.id)) {
    tag = '<span class="acc-tag is-watch">Checking…</span>';
    body = '<div class="acc-alert-near">Looking at the prices for you…</div>';
  } else if (!a.active) {
    tag = '<span class="acc-tag is-paused">Paused</span>';
  } else if (best) {
    tag = `<span class="acc-tag is-found">✓ Found ${a.checked_at?.slice(0, 10) === today ? "today" : ""}</span>`;
    const others = (a.match_count ?? 1) - 1;
    body = `
      <div class="acc-alert-hit">
        <div><b>${esc(best.name)}</b> <small>${esc(day(best.depart))} – ${esc(day(best.return))}${others > 0 ? ` · and ${others} more under your price` : ""}</small></div>
        <div class="acc-alert-price">${price(best.total, a.currency)}</div>
        <a class="acc-trip-open" href="${esc(alertLink(a, best))}">See this trip${CHEVRON}</a>
      </div>`;
  } else {
    tag = '<span class="acc-tag is-watch">Watching</span>';
    if (a.checked_at && a.cheapest_total != null) body = `<div class="acc-alert-near">Cheapest right now: <b>${price(a.cheapest_total, a.currency)}</b> — ${price(a.cheapest_total - a.max_total, a.currency)} above your price</div>`;
    else if (a.checked_at && !a.last_error) body = '<div class="acc-alert-near">No trip for these choices right now — we look again every morning.</div>';
  }
  const problem = a.last_error && !checking.has(a.id) ? '<div class="acc-alert-problem">The last check didn\'t work out; we\'ll try again tomorrow morning.</div>' : "";
  return `
    <div class="acc-alert${best && a.active && !checking.has(a.id) ? " is-found" : ""}" data-alert="${esc(a.id)}">
      <div class="acc-alert-top">
        <div class="acc-alert-what">${from} <span class="acc-arrow">→</span> ${esc(a.destination ? a.destination_name || a.destination : "Anywhere")}</div>
        ${tag}
      </div>
      <div class="acc-alert-rule">${esc(rule)}</div>
      ${body}${problem}
      <div class="acc-alert-foot">
        <span>${a.active ? esc(checkedWords(a)) : "No emails while it's paused"}</span>
        <span class="acc-alert-actions">
          <button type="button" class="acc-link-btn" data-do="edit">Edit</button>
          <button type="button" class="acc-link-btn" data-do="${a.active ? "pause" : "resume"}">${a.active ? "Pause" : "Turn on"}</button>
          <button type="button" class="acc-link-btn acc-remove" data-do="delete">Delete</button>
        </span>
      </div>
    </div>`;
}

function renderAlerts() {
  $("acc-alert-count").textContent = alerts.length ? `${alerts.length} of ${MAX_ALERTS}` : "";
  $("acc-alerts").innerHTML = alerts.length
    ? alerts.map(alertHtml).join("")
    : `<p class="acc-empty">No alerts yet. Make one on the left — or with <b>Make an alert</b> on one of your latest searches below — and we'll email you when a trip is under your price.</p>`;
}

async function loadAlerts() {
  $("acc-alerts").innerHTML = '<p class="acc-empty">Loading your alerts…</p>';
  try {
    alerts = await htAuth.rest("price_alerts?select=*&order=created_at.asc");
    renderAlerts();
  } catch (error) {
    // (before supabase/alerts.sql is run, the table doesn't exist yet)
    $("acc-alerts").innerHTML = /price_alerts|relation|schema cache/i.test(error.message)
      ? '<p class="acc-empty">Price alerts are coming soon.</p>'
      : `<p class="acc-empty">Your alerts couldn't be loaded: ${esc(error.message)}</p>`;
  }
}

$("acc-alerts").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-do]");
  if (!button) return;
  const a = alerts.find((x) => x.id === button.closest("[data-alert]").dataset.alert);
  if (!a) return;
  const action = button.dataset.do;
  if (action === "edit") return fillFromAlert(a);
  if (action === "delete" && !confirm("Delete this price alert? You won't get emails for it any more.")) return;
  button.disabled = true;
  try {
    const where = `price_alerts?id=eq.${encodeURIComponent(a.id)}`;
    if (action === "delete") {
      await htAuth.rest(where, { method: "DELETE" });
      alerts = alerts.filter((x) => x.id !== a.id);
      if (editing === a.id) resetAlertForm();
    } else {
      const [saved] = await htAuth.rest(where, { method: "PATCH", body: { active: action === "resume" }, prefer: "return=representation" });
      alerts = alerts.map((x) => (x.id === a.id ? saved : x));
      if (action === "resume") checkNow(a.id);
    }
    renderAlerts();
  } catch (error) {
    button.disabled = false;
    showMessage(error.message, true);
  }
});

// The email's "Pause it" / "Stop this alert" links: account.html?alert=ID&t=TOKEN&do=pause
// (no sign-in needed: the alert's own token says it's yours)
async function alertFromEmail() {
  const q = new URLSearchParams(location.search);
  const [id, token, action] = [q.get("alert"), q.get("t"), q.get("do")];
  if (!id || !token || !["pause", "stop"].includes(action)) return;
  history.replaceState(null, "", location.pathname + location.hash);
  try {
    await htAuth.fn("price-alerts", { action, id, token }, { anonymous: true });
    showMessage(action === "stop" ? "Your price alert is stopped: no more emails for it." : "Your price alert is paused: no emails until you turn it on again here.");
    if (htAuth.user()) loadAlerts();
  } catch (error) {
    showMessage(error.message, true);
  }
}


// ---- Deleting the account ---------------------------------------------------

$("acc-delete").addEventListener("click", async (event) => {
  if (!confirm("Delete your account, your price alerts, your saved trips and your latest searches? This can't be undone.")) return;
  event.target.disabled = true;
  try {
    await htAuth.rest("rpc/delete_my_account", { method: "POST", body: {} });
    await htAuth.signOut();
    showMessage("Your account and everything in it are deleted.");
    render();
  } catch (error) {
    event.target.disabled = false;
    showMessage(error.message, true);
  }
});


// ---- On arrival -------------------------------------------------------------

(async () => {
  try {
    if (await htAuth.fromLink()) showMessage("");
  } catch (error) {
    showMessage(error.message, true);
  }
  if (!htAuth.user() && pendingEmail.get()) showCodeStep(pendingEmail.get());
  render();
  alertFromEmail();
})();
