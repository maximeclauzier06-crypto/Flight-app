// ---------------------------------------------------------------------------
// Halfway Trips — the Account page (account.html)
//
// Signed out: your email → we send a link (and a code) → you're in.
// Signed in: your saved trips (each opens again: "See this trip"), your airports (the
// ones the search bar fills in for you), "Sign out" and "Delete my account".
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
function render() {
  const user = htAuth.user();
  $("acc-out").hidden = Boolean(user);
  $("acc-in").hidden = !user;
  $("acc-title").textContent = user ? "Your account" : "Sign in";
  $("acc-intro").textContent = user
    ? "The trips you saved and your airports, on any device where you sign in."
    : "No password: we email you a link. Your account keeps the trips you save and your airports, on any device.";
  if (user) {
    $("acc-who-email").textContent = user.email;
    loadTrips();
    loadAirports();
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


// ---- Your airports ----------------------------------------------------------

async function loadAirports() {
  const box = $("acc-airports");
  try {
    const [profile] = await htAuth.rest("profiles?select=airports");
    const airports = profile?.airports ?? [];
    box.innerHTML = airports.length
      ? `<b>${airports.map((a) => esc(a.label)).join(" + ")}</b> — the airports of your last search. We fill them in for you when you open the search. <button type="button" class="acc-link-btn" id="acc-forget">Forget them</button>`
      : "None yet. After your next search, its airports are filled in for you whenever you come back.";
  } catch (error) {
    box.textContent = `Your airports couldn't be loaded: ${error.message}`;
  }
}

$("acc-airports").addEventListener("click", async (event) => {
  if (event.target.id !== "acc-forget") return;
  event.target.disabled = true;
  try {
    await htAuth.rest(`profiles?user_id=eq.${encodeURIComponent(htAuth.user().id)}`, { method: "DELETE" });
    loadAirports();
  } catch (error) {
    event.target.disabled = false;
    showMessage(error.message, true);
  }
});


// ---- Deleting the account ---------------------------------------------------

$("acc-delete").addEventListener("click", async (event) => {
  if (!confirm("Delete your account, your saved trips and your airports? This can't be undone.")) return;
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
})();
