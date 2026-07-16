/**
 * First-touch ad attribution, shared by the whole site.
 *
 * `App.tsx` calls `captureAttribution()` on mount so the ad's
 * utm/gclid/referrer params are stashed on the landing page — the visitor
 * usually converts from a different page than the ad dropped them on, so
 * reading the URL at submit time would credit everything to the form's
 * own page. The booking funnel (`bookingApi.requestQuote`) reads it back
 * with `readAttribution()` and sends it with the quote request so website
 * customers keep their lead source.
 */

export type Attribution = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  gclid?: string;
  referrer?: string;
  landingPage?: string;
};

const ATTRIBUTION_KEY = "bk_attribution";

/**
 * First-touch attribution. Captured on the landing page and kept for the
 * session — first touch wins, so a value already in storage is never
 * overwritten.
 */
export function captureAttribution(): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionStorage.getItem(ATTRIBUTION_KEY)) return;
    const q = new URLSearchParams(window.location.search);
    const a: Attribution = {
      source: q.get("utm_source") ?? undefined,
      medium: q.get("utm_medium") ?? undefined,
      campaign: q.get("utm_campaign") ?? undefined,
      term: q.get("utm_term") ?? undefined,
      content: q.get("utm_content") ?? undefined,
      gclid: q.get("gclid") ?? undefined,
      referrer: document.referrer || undefined,
      landingPage: window.location.pathname + window.location.search,
    };
    sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(a));
  } catch {
    // Private-mode / storage-disabled browsers still get to book.
  }
}

/** The captured first-touch attribution, or `undefined` when none exists. */
export function readAttribution(): Attribution | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = sessionStorage.getItem(ATTRIBUTION_KEY);
    return raw ? (JSON.parse(raw) as Attribution) : undefined;
  } catch {
    return undefined;
  }
}
