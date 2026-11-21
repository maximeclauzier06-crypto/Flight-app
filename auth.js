// ---------------------------------------------------------------------------
// Halfway Trips — accounts (on every page)
//
// Signing in needs no password: we email you a link (or a code), through
// Supabase Auth. Once you're in, Supabase gives this page a "session" (a token
// that proves who you are, renewed every hour), kept in this browser's storage
// until you sign out. With it the page can read and write YOUR rows in two
// small tables — your saved trips and your last airports — and nobody else's:
// the database's own rules (supabase/accounts.sql) check the token.
//
// Used by account.html (account.js) and the home page (app.js) through
// window.htAuth. On every page it also turns "Sign in" in the top bar into
// "Account" when you're signed in.
// ---------------------------------------------------------------------------

(() => {
  const SUPABASE_URL = "https://xlmxbyrcgftxmfzlglkr.supabase.co";
  // The public "anon" key (the same one as in app.js): safe in frontend code.
  const ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhsbXhieXJjZ2Z0eG1memxnbGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5MTIxNjUsImV4cCI6MjEwNTQ4ODE2NX0.--mD9VzcBZfB6ncOu35_rr3h1ZdrNzeI83KymRbPrFE";
  const STORE_KEY = "ht-session"; // where the session is kept (localStorage)

  // The session: { access_token, refresh_token, expires_at (seconds), user: { id, email } }.
  // (Storage can be off, e.g. in some private windows: then you just can't stay signed in.)
  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || null;
    } catch {
      return null;
    }
  }
  function saveSession(session) {
    try {
      if (session) localStorage.setItem(STORE_KEY, JSON.stringify(session));
      else localStorage.removeItem(STORE_KEY);
    } catch {}
    updateNav();
  }

  // Supabase Auth answers (sign-in, renew) all have the same shape.
  const sessionFrom = (json) => ({
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Number(json.expires_at) || Math.floor(Date.now() / 1000) + Number(json.expires_in || 3600),
    user: { id: json.user?.id, email: json.user?.email },
  });

  async function call(path, { method = "POST", body, token, prefer } = {}) {
    const headers = { apikey: ANON_KEY, "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(`${SUPABASE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
      const error = new Error(json?.msg || json?.error_description || json?.message || `Something went wrong (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  // A token that is valid for at least another minute (renewed when needed),
  // or null when you're signed out (or the session could not be renewed).
  let renewing = null;
  async function token() {
    const session = readSession();
    if (!session) return null;
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    renewing ??= call("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } })
      .then((json) => {
        const next = sessionFrom(json);
        saveSession(next);
        return next.access_token;
      })
      .catch((error) => {
        if (error.status >= 400 && error.status < 500) saveSession(null); // the session is over: signed out
        return null;
      })
      .finally(() => (renewing = null));
    return renewing;
  }

  // 1. Send the email with the link (and the code). The link brings you back to account.html.
  function sendLink(email) {
    const back = new URL("account.html", location.href).href;
    return call(`/auth/v1/otp?redirect_to=${encodeURIComponent(back)}`, { body: { email, create_user: true } });
  }

  // 2a. You typed the code from the email.
  async function verifyCode(email, code) {
    const json = await call("/auth/v1/verify", { body: { type: "email", email, token: code } });
    saveSession(sessionFrom(json));
  }

  // 2c. For testing only: an account made with a password in Supabase (README,
  // "Setting up accounts"). The form for it shows on your own computer
  // (localhost), or with #password at the end of the Account page's address.
  async function signInWithPassword(email, password) {
    const json = await call("/auth/v1/token?grant_type=password", { body: { email, password } });
    saveSession(sessionFrom(json));
  }

  // 2b. You came back from the link: the session is in the address, after "#".
  // Returns true (signed in), false (no link here), or throws the link's error.
  async function fromLink() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const clean = () => history.replaceState(null, "", location.pathname + location.search);
    if (hash.get("error")) {
      clean();
      throw new Error(hash.get("error_code") === "otp_expired" ? "This link no longer works: it was already used, or a newer email replaced it. Use the newest email, or ask for a new one below." : hash.get("error_description") || "This link didn't work.");
    }
    if (!hash.get("access_token")) return false;
    clean();
    const user = await call("/auth/v1/user", { method: "GET", token: hash.get("access_token") });
    saveSession(sessionFrom({ ...Object.fromEntries(hash), user }));
    return true;
  }

  async function signOut() {
    const session = readSession();
    saveSession(null);
    if (session) await call("/auth/v1/logout", { token: session.access_token }).catch(() => {}); // (signed out here anyway)
  }

  // Your rows in the database: rest("saved_trips?select=*"), rest("saved_trips", { method: "POST", body }) ...
  async function rest(path, options = {}) {
    const access = await token();
    if (!access) throw new Error("You're signed out. Sign in again on the Account page.");
    return call(`/rest/v1/${path}`, { method: "GET", ...options, token: access });
  }

  // One of our Supabase Edge Functions, e.g. fn("price-alerts", { action: "check", id }):
  // with your sign-in token when you're signed in, otherwise (or `anonymous`) the public key.
  async function fn(name, body, { anonymous = false } = {}) {
    const access = anonymous ? null : await token();
    return call(`/functions/v1/${name}`, { body, token: access || ANON_KEY });
  }

  // "Sign in" in the top bar (and the phones' menu) says "Account" once you're in.
  function updateNav() {
    const signedIn = Boolean(readSession());
    document.querySelectorAll(".nav-account").forEach((link) => (link.textContent = signedIn ? "Account" : "Sign in"));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", updateNav);
  else updateNav();
  // Signed in or out in another tab: follow.
  addEventListener("storage", (event) => event.key === STORE_KEY && updateNav());

  window.htAuth = {
    user: () => readSession()?.user ?? null,
    signedIn: () => Boolean(readSession()),
    sendLink,
    verifyCode,
    signInWithPassword,
    fromLink,
    signOut,
    rest,
    fn,
  };
})();
