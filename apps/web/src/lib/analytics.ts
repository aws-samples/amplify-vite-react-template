// The GA4 property is selected once in index.html (env-driven, see
// VITE_GA_ID). gtag() events route to that configured property automatically,
// so no measurement ID is needed here.

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    clarity?: (...args: unknown[]) => void;
  }
}

/**
 * Event taxonomy (GA4). Kept small and reused everywhere with structured
 * params, rather than one throwaway event name per button — that's what
 * lets `page_path` × `button_id` be pivoted into a full site click-map in
 * GA4 Explore, and keeps GENERATE_LEAD/PURCHASE recognizable to GA4's
 * standard event set (so Google Ads can import them as conversions).
 */
export const GA_EVENTS = {
  CTA_CLICK: "cta_click",
  SCROLL_DEPTH: "scroll_depth",
  FORM_SUBMIT: "form_submit",
  GENERATE_LEAD: "generate_lead",
  PURCHASE: "purchase",
} as const;

export type GAEventName = (typeof GA_EVENTS)[keyof typeof GA_EVENTS];

function gtag(...args: unknown[]) {
  if (typeof window === "undefined" || !window.gtag) return;
  window.gtag(...args);
}

/** Microsoft Clarity (loaded in index.html). No-op until its tag is ready. */
function clarity(...args: unknown[]) {
  if (typeof window === "undefined" || !window.clarity) return;
  window.clarity(...args);
}

/**
 * URL params that must never reach GA4 or Clarity.
 *
 * `lead` is a capability: it names a CRM lead, prefills their contact and
 * address details into the funnel, and decides whose booking a payment
 * converts. `request`/`token` do the same for a saved quote. An analytics
 * property is read by more people than the funnel is, retains data for months,
 * and surfaces raw URLs inside session replays — so a token that reaches it is
 * effectively published. The funnel already strips these from the address bar
 * (QuotePage), but that happens in a lazily-loaded page's effect, which is not
 * guaranteed to win the race against the first page_view.
 *
 * `bk_lid` is not secret, just noise: it identifies the lead for `lead_id`,
 * which is its own dimension now, so leaving it in `page_path` would fragment
 * the Pages report into one row per lead.
 */
const REDACTED_QUERY_PARAMS = ["lead", "token", "request", "bk_lid"];

/** `/track/<token>` is a private "on my way" link — the secret IS the path. */
function maskSecretPathSegments(pathname: string): string {
  return pathname.replace(/^\/track\/[^/]+/, "/track/(token)");
}

/** A path (with optional query) safe to report. */
export function sanitizeAnalyticsPath(pathWithQuery: string): string {
  const [rawPath, rawQuery] = pathWithQuery.split("?");
  const path = maskSecretPathSegments(rawPath);
  if (!rawQuery) return path;
  const params = new URLSearchParams(rawQuery);
  for (const key of REDACTED_QUERY_PARAMS) params.delete(key);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The full URL, same redaction. The hash goes entirely — it carries the
 *  saved-quote resume capability (`#request=…&token=…`) and nothing we report on. */
export function sanitizeAnalyticsUrl(href: string): string {
  try {
    const url = new URL(href);
    url.pathname = maskSecretPathSegments(url.pathname);
    for (const key of REDACTED_QUERY_PARAMS) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** The current path, redacted — the `page_path` on every event below. */
function currentPath(): string {
  return typeof window === "undefined"
    ? ""
    : maskSecretPathSegments(window.location.pathname);
}

/**
 * The URL the visit landed on, kept because the address bar gets cleaned before
 * the first page_view fires (see captureLandingParams). Consumed once: the
 * first page_view reports the real landing URL so GA4 can parse the campaign
 * off it exactly as it would have; every later page_view is a genuine
 * navigation and reports its own URL.
 */
let landingHref: string | undefined;

function consumeLandingHref(): string | undefined {
  const href = landingHref;
  landingHref = undefined;
  return href;
}

const LEAD_ID_KEY = "bk_lead_id";

/**
 * The session's lead id, cached in module state so the hot path (a cta_click
 * on every single click) isn't a sessionStorage read each time. `undefined`
 * means "not read yet"; `null` means "read, nothing stored".
 */
let leadIdCache: string | null | undefined;

/** The lead id this session has produced, or `undefined` when none has. */
export function readLeadId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (leadIdCache !== undefined) return leadIdCache ?? undefined;
  try {
    leadIdCache = sessionStorage.getItem(LEAD_ID_KEY);
  } catch {
    // Private-mode / storage-disabled browsers still get to convert.
    leadIdCache = null;
  }
  return leadIdCache ?? undefined;
}

/**
 * Remember the lead id for the rest of the session. Called from
 * trackGenerateLead, so every form that reports a lead gets this for free.
 *
 * Persisted in sessionStorage alongside the first-touch attribution (see
 * lib/leadIntake) because the lead and the conversion happen on different
 * pages: someone submits the contact form, browses, then books minutes later
 * on /book — reading the id from component state at purchase time would find
 * nothing, so the revenue would never join back to the lead.
 *
 * Two writes, doing different jobs:
 *  - storage → `trackEvent` stamps `lead_id` on every LATER event (event-scoped,
 *    so any single event can be traced to the CRM record).
 *  - user property → GA4 attributes the lead to the whole user, including the
 *    page views from BEFORE the form was submitted (user-scoped, so Explore can
 *    replay the full path that produced the lead). The event param can't do this.
 *
 * Last write wins, unlike attribution: first touch is the ad that paid for the
 * visit, but the newest lead is the one the session is actually working on.
 */
export function setLeadId(leadId: string | undefined): void {
  if (!leadId || typeof window === "undefined") return;
  leadIdCache = leadId;
  try {
    sessionStorage.setItem(LEAD_ID_KEY, leadId);
  } catch {
    /* Cache-only still covers the rest of this page. */
  }
  gtag("set", "user_properties", { lead_id: leadId });
  // Clarity gets it as a filterable custom tag: GA4 tells you what a lead did,
  // Clarity lets you watch the recording of them doing it — through to the
  // moment they left, which is the part GA4 can't show you.
  clarity("set", "lead_id", leadId);
}

/** The GA4 campaign field each utm param feeds. */
const CAMPAIGN_FIELDS: [utmParam: string, ga4Field: string][] = [
  ["utm_source", "source"],
  ["utm_medium", "medium"],
  ["utm_campaign", "name"],
  ["utm_term", "term"],
  ["utm_content", "content"],
  ["utm_id", "id"],
];

/**
 * Params erased from the address bar once captured.
 *
 * `gclid` is deliberately NOT here. gtag turns it into the `_gcl_aw` cookie
 * that carries Google Ads click attribution, and gtag.js loads async — it may
 * still be reading the URL when this runs. Explicitly setting the campaign
 * (below) covers GA4 but does nothing for that cookie, so removing gclid could
 * silently break Ads conversion attribution. It also never appears on an email
 * link, so keeping it costs nothing.
 */
const CLEANED_QUERY_PARAMS = [...CAMPAIGN_FIELDS.map(([utm]) => utm), "bk_lid"];

/**
 * Read everything the landing URL carries, hand it to the tags, then clean the
 * address bar so the visitor just sees `/quote/instant`.
 *
 * Campaign attribution normally works by gtag parsing `utm_*` out of the page
 * URL — so erasing them would report the session as direct/none. gtag.js also
 * loads async, so it may parse the URL *after* this function runs, which makes
 * the naive "delete and hope" version fail intermittently rather than cleanly.
 * Two defences, deliberately redundant because the failure is silent:
 *
 *  1. `gtag('set','campaign',…)` — the values are pushed to GA4 explicitly, so
 *     they no longer depend on the URL surviving at all.
 *  2. `landingHref` — the original URL is kept and reported as the first
 *     page_view's `page_location`, so GA4's own parsing sees what it always saw.
 *
 * `bk_lid` becomes `lead_id`. The URL wins over a stored id on purpose —
 * clicking a specific lead's link is an explicit signal about who this visit is.
 *
 * NOT removed: `lead` (QuotePage reads it from the address bar in a later
 * effect; removing it breaks form prefill and which lead a payment converts),
 * `gclid` (see above), and the hash (saved-quote resume tokens).
 *
 * Must run before the first page_view AND before `captureAttribution()` reads
 * the same params for the CRM's lead source — see main.tsx.
 */
export function captureLandingParams(): void {
  if (typeof window === "undefined") return;
  try {
    landingHref = window.location.href;
    const params = new URLSearchParams(window.location.search);

    const campaign: Record<string, string> = {};
    for (const [utmParam, ga4Field] of CAMPAIGN_FIELDS) {
      const value = params.get(utmParam);
      if (value) campaign[ga4Field] = value;
    }
    if (Object.keys(campaign).length > 0) gtag("set", "campaign", campaign);

    const leadId = params.get("bk_lid");
    if (leadId) setLeadId(leadId);

    // Nothing to hide — leave the address bar (and its history entry) alone.
    if (!CLEANED_QUERY_PARAMS.some((key) => params.has(key))) return;

    for (const key of CLEANED_QUERY_PARAMS) params.delete(key);
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`
    );
  } catch {
    /* Nothing to attribute; the visit still tracks. */
  }
}

/**
 * SPA page view. Sends an explicit `page_view` event (not a repeat `config`
 * call) with the title and full URL captured at send time, so GA4's Page
 * title dimension reflects the page the user is actually on rather than
 * whatever `document.title` happened to be when the tag initialized.
 * AnalyticsTracker defers this to the next frame so SEO.tsx has set the title.
 */
export function trackPageview(path: string) {
  trackEvent("page_view" as GAEventName, {
    page_path: sanitizeAnalyticsPath(path),
    page_location:
      typeof window === "undefined"
        ? ""
        : sanitizeAnalyticsUrl(consumeLandingHref() ?? window.location.href),
    page_title: typeof document === "undefined" ? "" : document.title,
  });
}

export function trackEvent(name: GAEventName, params?: Record<string, unknown>) {
  // Once the session has a lead id, every event carries it — so the join to the
  // CRM record isn't limited to the one event that happened to create the lead.
  // An explicit lead_id in params still wins.
  const leadId = readLeadId();
  gtag("event", name, leadId ? { lead_id: leadId, ...params } : params);
}

/** Every button/link click, site-wide. `button_id` must be unique within a page — combined with `page_path` (auto-filled) it's the full site click-map. */
export function trackButtonClick(buttonId: string, buttonText: string, destination: string) {
  trackEvent(GA_EVENTS.CTA_CLICK, {
    page_path: currentPath(),
    button_id: buttonId,
    button_text: buttonText.slice(0, 120),
    destination,
  });
}

/** Fired once per threshold per page view by ScrollDepthTracker. */
export function trackScrollDepth(percent: 25 | 50 | 75 | 90 | 100) {
  trackEvent(GA_EVENTS.SCROLL_DEPTH, {
    page_path: currentPath(),
    percent,
  });
}

/** Every form submit attempt — fired on both success and failure so drop-off is visible in the funnel. */
export function trackFormSubmit(formId: string, status: "success" | "error", extra?: Record<string, unknown>) {
  trackEvent(GA_EVENTS.FORM_SUBMIT, {
    page_path: currentPath(),
    form_id: formId,
    status,
    ...extra,
  });
}

/** GA4 standard "generate_lead" — carries the CRM lead id so a GA session can be cross-referenced with the actual CRM record, and so Google Ads can import it as a conversion. */
export function trackGenerateLead(formId: string, leadId: string | undefined) {
  // Before the event, so this lead also rides on everything that follows it.
  setLeadId(leadId);
  trackEvent(GA_EVENTS.GENERATE_LEAD, {
    page_path: currentPath(),
    form_id: formId,
    lead_id: leadId,
  });
}

/** GA4 standard "purchase" — fired on a completed/paid booking so Google Ads can import it as a conversion with real value. */
export function trackPurchase(bookingId: string, amountCents: number) {
  trackEvent(GA_EVENTS.PURCHASE, {
    page_path: currentPath(),
    transaction_id: bookingId,
    // The same id under the dimension the funnel's form_submit events already
    // use, so booking steps and revenue join in Explore without a rename.
    // `lead_id` rides along from trackEvent when the session produced a lead —
    // that is what ties revenue back to the CRM lead that generated it.
    booking_id: bookingId,
    value: amountCents / 100,
    currency: "USD",
  });
}

/**
 * Google Ads conversion labels (from Google Ads → Conversions → event snippet).
 * These are separate from the GA4 events above: firing with `send_to` routes
 * the hit to the Ads account only, so it never affects GA4 data.
 */
export const ADS_CONVERSIONS = {
  QUOTE_COMPLETED: "AW-18345277313/bc0bCMeQp9ccEIHv2qtE",
  BOOKING_CONFIRMED: "AW-18345277313/9E1wCNLNwNccEIHv2qtE",
  // CALL_CLICK: "AW-18345277313/<label>",         // add when created in Google Ads
} as const;

/** Fire a Google Ads conversion. `sendTo` is the full "AW-<id>/<label>". */
export function trackAdsConversion(sendTo: string, params?: Record<string, unknown>) {
  gtag("event", "conversion", { send_to: sendTo, ...params });
}
