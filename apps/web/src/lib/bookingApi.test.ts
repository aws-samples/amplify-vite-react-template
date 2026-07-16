import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestQuote, type QuoteRequest } from "./bookingApi";
import { captureAttribution, readAttribution } from "./leadIntake";

/**
 * The attribution half of the funnel contract: `captureAttribution()` runs
 * on the landing page, and `requestQuote` must carry the captured object
 * on the POST /quote payload (and omit the key entirely when the session
 * has none) so website customers keep their lead source.
 */

const quoteInput: QuoteRequest = {
  name: "Dana Whitfield",
  email: "dana@example.com",
  service: "GENERAL_PEST",
  address: { street: "12 Elm St", city: "Ware", state: "MA", zip: "01082" },
  sqft: 2400,
};

function fakeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

/**
 * The vitest environment is node; leadIntake only touches these three
 * browser surfaces, so stub exactly those.
 */
function stubBrowser(search: string, pathname = "/lp/quote") {
  vi.stubGlobal("sessionStorage", fakeSessionStorage());
  vi.stubGlobal("window", { location: { search, pathname } });
  vi.stubGlobal("document", { referrer: "https://www.google.com/" });
}

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    bookingId: "bk-1",
    decision: "CONTACT",
    message: "We'll call you within the hour.",
  }),
}));

function sentPayload(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body));
}

beforeEach(() => {
  vi.stubEnv("VITE_BOOKING_API_URL", "https://booking.test");
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("requestQuote attribution", () => {
  it("carries the captured first-touch attribution on the /quote payload", async () => {
    stubBrowser("?utm_source=google&utm_medium=cpc&utm_campaign=wasps&gclid=abc123");
    captureAttribution();

    const result = await requestQuote(quoteInput);
    expect(result.ok).toBe(true);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://booking.test/quote");

    const payload = sentPayload();
    expect(payload.name).toBe("Dana Whitfield");
    expect(payload.attribution).toEqual({
      source: "google",
      medium: "cpc",
      campaign: "wasps",
      gclid: "abc123",
      referrer: "https://www.google.com/",
      landingPage:
        "/lp/quote?utm_source=google&utm_medium=cpc&utm_campaign=wasps&gclid=abc123",
    });
  });

  it("omits the attribution key entirely when the session has none", async () => {
    stubBrowser("");
    // No captureAttribution() call — a direct visit that never landed on
    // an instrumented page, or a storage-disabled browser.
    expect(readAttribution()).toBeUndefined();

    await requestQuote(quoteInput);

    expect("attribution" in sentPayload()).toBe(false);
  });

  it("first touch wins — a later page load never overwrites the ad's params", () => {
    stubBrowser("?utm_source=google&gclid=abc123");
    captureAttribution();

    // Same session, new page: capture runs again with no params.
    (window as unknown as { location: { search: string; pathname: string } }).location = {
      search: "",
      pathname: "/quote",
    };
    captureAttribution();

    expect(readAttribution()).toMatchObject({
      source: "google",
      gclid: "abc123",
      landingPage: "/lp/quote?utm_source=google&gclid=abc123",
    });
  });
});
