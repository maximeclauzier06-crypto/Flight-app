// ---------------------------------------------------------------------------
// Halfway Trips — price alerts (Supabase Edge Function "price-alerts")
//
// Someone signed in makes an alert on the Account page: everyone's airports,
// where (or anywhere), the kind of trip, the months they'd leave in, and the
// most they'd pay in total (table price_alerts, supabase/alerts.sql). Every
// morning this function checks each alert with the SAME search as the site
// (it asks the search-flights function, so it uses the same remembered prices
// and limits), and emails the person (through Resend) when a trip is under
// their price — at most once a day, and only when the trip is new or cheaper
// than in the last email ("once a week": at most one email a week).
//
// It answers four kinds of requests (POST, JSON body or ?query):
//   { action: "run" }            the morning check of the alerts that are due.
//                                Sent by Supabase Cron, with the header
//                                x-alerts-secret = the ALERTS_CRON_SECRET secret.
//   { action: "check", id }      check one alert now (right after it's made or
//                                changed on the Account page). Needs that
//                                person's sign-in token (Authorization header).
//   { action: "pause", id, token }  the email's "Pause it" and "Stop this alert"
//   { action: "stop", id, token }   links (and the inbox's own Unsubscribe
//                                button): no sign-in, the alert's own token.
//
// Setup (README, "Setting up price alerts"): deploy this function with "Verify
// JWT" OFF (the email links and the inbox's Unsubscribe button come without a
// sign-in; the function checks everything itself), add the Edge Function
// Secrets RESEND_API_KEY and ALERTS_CRON_SECRET, and a Cron job.
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are there
// already (Supabase provides them to every function).
// ---------------------------------------------------------------------------

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SITE = (Deno.env.get("SITE_URL") ?? "https://halfwaytrips.com").replace(/\/$/, "");
const FROM = Deno.env.get("ALERTS_FROM") ?? "Halfway Trips <alerts@halfwaytrips.com>";

const PER_RUN = 4;              // alerts checked per Cron run (each one is a search: ~5–20 s)
const RUN_BUDGET_MS = 100_000;  // no new check after this (Edge Functions stop at ~150 s)
const MAX_MATCHES = 3;          // trips under your price kept (and emailed): the cheapest
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Origin = { code: string; label: string; count: number };
type Alert = {
  id: string; user_id: string; origins: Origin[];
  destination: string | null; destination_name: string | null;
  stay: "weekend" | "long" | "week" | "nights"; nights: number;
  month_from: string; month_to: string; max_total: number; currency: string;
  max_gap_hours: number; direct_only: boolean; frequency: "daily" | "weekly";
  active: boolean; token: string;
  checked_at: string | null; emailed_at: string | null; emailed_sig: string | null; emailed_total: number | null;
};
type Match = {
  destination: string; name: string; country: string;
  depart: string; return: string; total: number;
  legs: Array<{ origin: string; count: number; subtotal: number }>;
};


// ---- The database (with the service key: this function sees every alert) ----

async function db(path: string, { method = "GET", body, prefer }: { method?: string; body?: unknown; prefer?: string } = {}) {
  const headers: Record<string, string> = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`database ${response.status}: ${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

// The email address someone signed in with (from Supabase Auth itself, so an
// alert can only ever email its own owner).
async function emailOf(userId: string): Promise<string | null> {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!response.ok) return null;
  return (await response.json())?.email ?? null;
}


// ---- The search: the same one the site makes --------------------------------

const TRIP_STAYS = new Set(["weekend", "long", "week"]);

function searchUrl(a: Alert): string {
  const q = new URLSearchParams({
    origins: a.origins.map((o) => o.code).join(","),
    counts: a.origins.map((o) => o.count || 1).join(","),
    currency: a.currency,
    maxGapHours: String(a.max_gap_hours),
    mode: "flexible",
    nights: String(a.nights),
    flexNights: "0",
  });
  if (a.destination) {
    q.set("destination", a.destination);
    if (TRIP_STAYS.has(a.stay)) q.set("trip", a.stay);
  } else if (a.stay === "weekend" || a.stay === "long") {
    q.set("weekendOnly", "true");
  }
  return `${SUPABASE_URL}/functions/v1/search-flights?${q}`;
}

// The first day after a month: "2027-03-01" -> "2027-04-01"
function monthAfter(firstDay: string): string {
  const d = new Date(`${firstDay}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// Every trip in the search's answer that fits the alert (its months, direct
// flights if asked), cheapest first. (Anywhere: the search gives each place's
// cheapest dates in the coming months — a place whose cheapest dates are
// outside the alert's months is left out.)
// deno-lint-ignore no-explicit-any
function fittingTrips(a: Alert, found: any): Match[] {
  // deno-lint-ignore no-explicit-any
  const trips: any[] = found.mode === "trip"
    // deno-lint-ignore no-explicit-any
    ? (found.windows ?? []).flatMap((w: any) => w.options ?? []).filter((o: any) => o.status === "ok" && o.total != null)
      // deno-lint-ignore no-explicit-any
      .map((o: any) => ({ ...o, destination: found.destination?.code, destinationName: found.destination?.name, country: found.destination?.country }))
    : found.results ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const until = monthAfter(a.month_to);
  const seen = new Set<string>();
  return trips
    .filter((t) => t.departDate > today && t.departDate >= a.month_from && t.departDate < until)
    // deno-lint-ignore no-explicit-any
    .filter((t) => !a.direct_only || (t.travelers ?? []).every((l: any) => l.transfers === 0))
    .map((t) => ({
      destination: t.destination,
      name: t.destinationName ?? t.destination,
      country: t.country ?? "",
      depart: t.departDate,
      return: t.returnDate,
      total: Math.round(t.total),
      // deno-lint-ignore no-explicit-any
      legs: (t.travelers ?? []).map((l: any) => ({ origin: l.origin, count: l.count, subtotal: Math.round(l.subtotal) })),
    }))
    .filter((m) => !seen.has(sig(m)) && seen.add(sig(m)))
    .sort((x, y) => x.total - y.total);
}

const sig = (m: Match) => `${m.destination}|${m.depart}|${m.return}`;

// Email now? Only with a trip under the price; "daily": at most once a day,
// and only when the best trip is new or cheaper than in the last email;
// "weekly": at most once a week.
function shouldEmail(a: Alert, best: Match | undefined, now: number): boolean {
  if (!best) return false;
  if (!a.emailed_at) return true;
  const since = now - Date.parse(a.emailed_at);
  if (a.frequency === "weekly") return since >= 6.5 * DAY;
  return since >= 20 * HOUR && (sig(best) !== a.emailed_sig || best.total < Number(a.emailed_total));
}

// Check one alert: search, keep what was found, email if it's time.
async function checkAlert(a: Alert) {
  const now = Date.now();
  const update: Record<string, unknown> = { checked_at: new Date(now).toISOString(), last_error: null };
  try {
    const response = await fetch(searchUrl(a), {
      headers: { Authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
      signal: AbortSignal.timeout(60_000),
    });
    const found = await response.json();
    if (!response.ok || found.error) throw new Error(`search: ${found.error ?? found.message ?? response.status}`);
    if ((found.currency ?? "").toLowerCase() !== a.currency) throw new Error(`search: prices came in ${found.currency}, not ${a.currency}`);
    const trips = fittingTrips(a, found);
    const matches = trips.filter((t) => t.total <= a.max_total);
    Object.assign(update, {
      cheapest_total: trips[0]?.total ?? null,
      matches: matches.slice(0, MAX_MATCHES),
      match_count: matches.length,
    });
    if (a.active && shouldEmail(a, matches[0], now)) {
      const to = await emailOf(a.user_id);
      if (!to) throw new Error("no email address for this account");
      await sendAlertEmail(a, matches.slice(0, MAX_MATCHES), to);
      Object.assign(update, { emailed_at: update.checked_at, emailed_sig: sig(matches[0]), emailed_total: matches[0].total });
    }
  } catch (error) {
    update.last_error = String(error instanceof Error ? error.message : error).slice(0, 300);
  }
  const [row] = await db(`price_alerts?id=eq.${a.id}`, { method: "PATCH", body: update, prefer: "return=representation" });
  return row;
}


// ---- The email ----------------------------------------------------------------

const LOCALE: Record<string, string> = { sek: "sv-SE", nok: "nb-NO", dkk: "da-DK", eur: "fr-FR", gbp: "en-GB", usd: "en-US", chf: "de-CH", pln: "pl-PL", cad: "en-CA", aud: "en-AU", nzd: "en-NZ", jpy: "ja-JP", try: "tr-TR", inr: "en-IN", brl: "pt-BR", mxn: "es-MX", rub: "ru-RU" };
const price = (amount: number, currency: string) =>
  new Intl.NumberFormat(LOCALE[currency] ?? "en", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(amount);
const DAY_NAME = new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) => DAY_NAME.format(new Date(`${iso}T00:00:00Z`)).replace(",", "");
const MONTH_NAME = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
const month = (iso: string) => MONTH_NAME.format(new Date(`${iso}T00:00:00Z`));
const esc = (text: unknown) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STAY_WORDS: Record<string, string> = { weekend: "weekend", long: "long weekend", week: "full week" };
const stayWords = (a: Alert) => STAY_WORDS[a.stay] ?? `${a.nights}-night`;
const people = (a: Alert) => a.origins.reduce((sum, o) => sum + (o.count || 1), 0);
const fromWords = (a: Alert) => a.origins.map((o) => o.label + (o.count > 1 ? ` ×${o.count}` : "")).join(" + ");
const forAll = (a: Alert) => (people(a) === 2 ? "for both of you" : `for all ${people(a)} of you`);
const months = (a: Alert) => (a.month_from === a.month_to ? month(a.month_from) : `${month(a.month_from)} – ${month(a.month_to)}`);
const ruleWords = (a: Alert) =>
  `${fromWords(a)} → ${a.destination ? a.destination_name || a.destination : "Anywhere"} · ${stayWords(a)} · leaving ${months(a)} · up to ${price(a.max_total, a.currency)}`;

// The trip's own page on the site (the same link as a saved trip's)
function tripLink(a: Alert, m: Match): string {
  const q = new URLSearchParams();
  for (const o of a.origins) q.append("from", `${o.code}:${o.label}:${o.count || 1}`);
  q.set("to", m.destination);
  q.set("name", m.name);
  q.set("depart", m.depart);
  q.set("return", m.return);
  q.set("open", "1");
  q.set("cur", a.currency);
  q.set("go", "1");
  return `${SITE}/?${q}`.replace(/%3A/gi, ":");
}
const actionLink = (a: Alert, action: "pause" | "stop") => `${SITE}/account.html?alert=${a.id}&t=${a.token}&do=${action}`;
const oneClickStop = (a: Alert) => `${SUPABASE_URL}/functions/v1/price-alerts?action=stop&id=${a.id}&t=${a.token}`;

function emailHtml(a: Alert, matches: Match[]): string {
  const [best, ...more] = matches;
  const label = (code: string) => a.origins.find((o) => o.code === code)?.label ?? code;
  const legRows = best.legs.map((l) => `
                <tr><td style="padding:8px 16px 0;">From ${esc(label(l.origin))} · ${l.count} traveller${l.count === 1 ? "" : "s"}</td><td align="right" style="padding:8px 16px 0; font-weight:800;">${esc(price(l.subtotal, a.currency))}</td></tr>`).join("");
  const moreRows = more.map((m) => `
                <tr><td style="padding:6px 0;"><a href="${esc(tripLink(a, m))}" style="color:#A8461C; font-weight:800; text-decoration:none;">${esc(m.name)}</a> · ${esc(day(m.depart))} – ${esc(day(m.return))}</td><td align="right" style="padding:6px 0; font-weight:800;">${esc(price(m.total, a.currency))}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>${esc(best.name)} for ${esc(price(best.total, a.currency))}</title>
  <style>
    @font-face { font-family: 'Outfit'; font-weight: 500 700; src: url('${SITE}/fonts/outfit-latin.woff2') format('woff2'); }
    @font-face { font-family: 'Manrope'; font-weight: 400 800; src: url('${SITE}/fonts/manrope-latin.woff2') format('woff2'); }
    @media (max-width: 520px) { .card { padding: 26px 20px 24px !important; } }
  </style>
</head>
<body style="margin:0; padding:0; background:#F5EEE3;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:#F5EEE3;">Under your price: ${esc(fromWords(a))}, ${esc(day(best.depart))} – ${esc(day(best.return))}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5EEE3;">
    <tr>
      <td align="center" style="padding:32px 16px 40px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:0 4px 20px;"><a href="${SITE}" style="text-decoration:none;"><img src="${SITE}/images/email-logo.png" width="196" height="40" alt="Halfway Trips" style="display:block; border:0; font-family:Arial, Helvetica, sans-serif; font-size:22px; font-weight:bold; color:#2A1D16;"></a></td>
          </tr>
          <tr>
            <td class="card" style="background:#FFFFFF; border-radius:20px; padding:32px 32px 28px; font-family:'Manrope', Arial, Helvetica, sans-serif; color:#2A1D16;">
              <div style="display:inline-block; padding:5px 12px; border-radius:999px; background:#E7F1E4; color:#3D7A3A; font-size:12px; font-weight:800; letter-spacing:0.6px;">&#10003; UNDER YOUR PRICE</div>
              <h1 style="margin:14px 0 8px; font-family:'Outfit', Arial, Helvetica, sans-serif; font-size:28px; line-height:1.2; font-weight:700; color:#2A1D16;">${esc(best.name)} for ${esc(price(best.total, a.currency))}, ${esc(forAll(a))}</h1>
              <p style="margin:0 0 20px; font-size:15px; line-height:1.55; color:#6A5E56;">${esc(day(best.depart))} – ${esc(day(best.return))} · your price was ${esc(price(a.max_total, a.currency))}.</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-radius:14px; background:#F6F0E7; font-size:15px; color:#2A1D16;">${legRows}
                <tr><td style="padding:12px 16px 12px; font-weight:800;">In total</td><td align="right" style="padding:12px 16px 12px; font-family:'Outfit', Arial, Helvetica, sans-serif; font-size:20px; font-weight:700;">${esc(price(best.total, a.currency))}</td></tr>
              </table>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
                <tr><td style="border-radius:999px; background:#F2B33D;"><a href="${esc(tripLink(a, best))}" style="display:inline-block; padding:14px 28px; border-radius:999px; font-family:'Outfit', Arial, Helvetica, sans-serif; font-size:17px; font-weight:700; color:#2B1608; text-decoration:none;">See this trip &rarr;</a></td></tr>
              </table>${more.length ? `
              <div style="height:1px; line-height:1px; font-size:1px; background:#ECE3D6; margin:26px 0 18px;">&nbsp;</div>
              <p style="margin:0 0 6px; font-size:14px; font-weight:800;">Also under your price</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px; color:#2A1D16;">${moreRows}
              </table>` : ""}
              <p style="margin:18px 0 0; font-size:12.5px; line-height:1.5; color:#6A5E56;">These are the latest prices we've seen. Aviasales shows the live price before you book, and it can be a little different.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 8px 0; font-family:Arial, Helvetica, sans-serif; font-size:13px; line-height:1.6; color:#6A5E56;">
              <p style="margin:0 0 8px;"><b style="color:#2A1D16;">Your alert:</b> ${esc(ruleWords(a))}.</p>
              <p style="margin:0 0 12px;"><a href="${SITE}/account.html" style="color:#A8461C; font-weight:bold;">Change it</a> · <a href="${esc(actionLink(a, "pause"))}" style="color:#A8461C; font-weight:bold;">Pause it</a> · <a href="${esc(actionLink(a, "stop"))}" style="color:#A8461C; font-weight:bold;">Stop this alert</a></p>
              <p style="margin:0;">You get this because you made this price alert on <a href="${SITE}" style="color:#A8461C; font-weight:bold; text-decoration:none;">halfwaytrips.com</a>. ${a.frequency === "weekly" ? "At most one email a week for it." : "At most one email a day for it."}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function emailText(a: Alert, matches: Match[]): string {
  const [best, ...more] = matches;
  return [
    `${best.name} for ${price(best.total, a.currency)}, ${forAll(a)}`,
    `${day(best.depart)} – ${day(best.return)} · your price was ${price(a.max_total, a.currency)}.`,
    "",
    `See this trip: ${tripLink(a, best)}`,
    ...(more.length ? ["", "Also under your price:", ...more.map((m) => `- ${m.name}, ${day(m.depart)} – ${day(m.return)}: ${price(m.total, a.currency)} — ${tripLink(a, m)}`)] : []),
    "",
    "These are the latest prices we've seen. Aviasales shows the live price before you book, and it can be a little different.",
    "",
    `Your alert: ${ruleWords(a)}.`,
    `Change it: ${SITE}/account.html`,
    `Pause it: ${actionLink(a, "pause")}`,
    `Stop this alert: ${actionLink(a, "stop")}`,
  ].join("\n");
}

async function sendAlertEmail(a: Alert, matches: Match[], to: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is missing (Edge Function Secrets)");
  const best = matches[0];
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: `${best.name} for ${price(best.total, a.currency)} — your ${stayWords(a)} alert`,
      html: emailHtml(a, matches),
      text: emailText(a, matches),
      // The inbox's own "Unsubscribe" button: one click stops this alert.
      headers: { "List-Unsubscribe": `<${oneClickStop(a)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    }),
  });
  if (!response.ok) throw new Error(`Resend ${response.status}: ${(await response.text()).slice(0, 160)}`);
}


// ---- The four kinds of requests --------------------------------------------

// The morning check: the active alerts not checked yet today, oldest first.
async function runDue() {
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10); // (a plain date: midnight UTC)
  const due: Alert[] = await db(`price_alerts?select=*&active=eq.true&or=(checked_at.is.null,checked_at.lt.${today})&order=checked_at.asc.nullsfirst&limit=${PER_RUN}`);
  let checked = 0;
  for (const a of due) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) break;
    await checkAlert(a);
    checked++;
  }
  return { checked, due: due.length };
}

// "check": one alert, for its owner (the token says who's asking).
async function checkOne(id: string, authorization: string) {
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: authorization } });
  if (!who.ok) return answer({ error: "Sign in again on the Account page." }, 401);
  const user = await who.json();
  const [a]: Alert[] = await db(`price_alerts?select=*&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}`);
  if (!a) return answer({ error: "This alert doesn't exist (any more)." }, 404);
  // (checked less than a minute ago: what we have is fresh)
  if (a.checked_at && Date.now() - Date.parse(a.checked_at) < 60_000) return answer({ alert: a });
  return answer({ alert: await checkAlert(a) });
}

// "pause" / "stop" from an email: the alert's id and its own token.
async function byToken(action: "pause" | "stop", id: string, token: string) {
  const where = `price_alerts?id=eq.${encodeURIComponent(id)}&token=eq.${encodeURIComponent(token)}`;
  const rows = action === "stop"
    ? await db(where, { method: "DELETE", prefer: "return=representation" })
    : await db(where, { method: "PATCH", body: { active: false }, prefer: "return=representation" });
  return rows?.length ? answer({ ok: true, action }) : answer({ error: "This alert was already stopped, or the link is old." }, 404);
}

const isId = (text: string) => /^[0-9a-f-]{36}$/i.test(text);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, string> = {};
    if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("application/json")) body = await req.json().catch(() => ({}));
    const get = (name: string) => String(body[name] ?? url.searchParams.get(name) ?? "");
    const action = get("action");

    if (action === "run") {
      const secret = Deno.env.get("ALERTS_CRON_SECRET");
      if (!secret || req.headers.get("x-alerts-secret") !== secret) return answer({ error: "Not allowed" }, 401);
      return answer(await runDue());
    }
    if (action === "check") {
      const id = get("id");
      const authorization = req.headers.get("authorization") ?? "";
      if (!isId(id) || !authorization.startsWith("Bearer ")) return answer({ error: "Give an alert id, and sign in." }, 400);
      return await checkOne(id, authorization);
    }
    if (action === "pause" || action === "stop") {
      const id = get("id");
      const token = get("token") || get("t");
      if (!isId(id) || !isId(token)) return answer({ error: "This link isn't complete." }, 400);
      return await byToken(action, id, token);
    }
    return answer({ error: 'action must be "run", "check", "pause" or "stop"' }, 400);
  } catch (error) {
    return answer({ error: String(error instanceof Error ? error.message : error) }, 500);
  }
});
