// The GA4 property is selected once in index.html (env-driven, see
// VITE_GA_ID). gtag() events route to that configured property automatically,
// so no measurement ID is needed here.

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
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

/**
 * SPA page view. Sends an explicit `page_view` event (not a repeat `config`
 * call) with the title and full URL captured at send time, so GA4's Page
 * title dimension reflects the page the user is actually on rather than
 * whatever `document.title` happened to be when the tag initialized.
 * AnalyticsTracker defers this to the next frame so SEO.tsx has set the title.
 */
export function trackPageview(path: string) {
  trackEvent("page_view" as GAEventName, {
    page_path: path,
    page_location: typeof window === "undefined" ? "" : window.location.href,
    page_title: typeof document === "undefined" ? "" : document.title,
  });
}

export function trackEvent(name: GAEventName, params?: Record<string, unknown>) {
  gtag("event", name, params);
}

/** Every button/link click, site-wide. `button_id` must be unique within a page — combined with `page_path` (auto-filled) it's the full site click-map. */
export function trackButtonClick(buttonId: string, buttonText: string, destination: string) {
  trackEvent(GA_EVENTS.CTA_CLICK, {
    page_path: typeof window === "undefined" ? "" : window.location.pathname,
    button_id: buttonId,
    button_text: buttonText.slice(0, 120),
    destination,
  });
}

/** Fired once per threshold per page view by ScrollDepthTracker. */
export function trackScrollDepth(percent: 25 | 50 | 75 | 90 | 100) {
  trackEvent(GA_EVENTS.SCROLL_DEPTH, {
    page_path: typeof window === "undefined" ? "" : window.location.pathname,
    percent,
  });
}

/** Every form submit attempt — fired on both success and failure so drop-off is visible in the funnel. */
export function trackFormSubmit(formId: string, status: "success" | "error", extra?: Record<string, unknown>) {
  trackEvent(GA_EVENTS.FORM_SUBMIT, {
    page_path: typeof window === "undefined" ? "" : window.location.pathname,
    form_id: formId,
    status,
    ...extra,
  });
}

/** GA4 standard "generate_lead" — carries the CRM lead id so a GA session can be cross-referenced with the actual CRM record, and so Google Ads can import it as a conversion. */
export function trackGenerateLead(formId: string, leadId: string | undefined) {
  trackEvent(GA_EVENTS.GENERATE_LEAD, {
    page_path: typeof window === "undefined" ? "" : window.location.pathname,
    form_id: formId,
    lead_id: leadId,
  });
}

/** GA4 standard "purchase" — fired on a completed/paid booking so Google Ads can import it as a conversion with real value. */
export function trackPurchase(bookingId: string, amountCents: number) {
  trackEvent(GA_EVENTS.PURCHASE, {
    page_path: typeof window === "undefined" ? "" : window.location.pathname,
    transaction_id: bookingId,
    value: amountCents / 100,
    currency: "USD",
  });
}
