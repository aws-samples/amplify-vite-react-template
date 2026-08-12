import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lead-id stitching contract. A lead and the money it produces happen on
 * different pages — the form is submitted on /contact, the card is charged
 * minutes later on /book — so the id has to outlive the component that learned
 * it. These tests pin the two halves that make the GA4 ↔ CRM join work:
 * every later event carries `lead_id`, and the user property is set so GA4
 * also attributes the page views from *before* the lead existed.
 *
 * analytics.ts caches the id in module state (the click tracker fires on every
 * click, so it must not hit storage each time), which means each test needs a
 * fresh module — hence resetModules + dynamic import rather than a top import.
 */

const gtagMock = vi.fn();

function fakeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
}

const clarityMock = vi.fn();
const replaceStateMock = vi.fn();

/** The vitest environment is node; analytics.ts touches only these surfaces. */
function stubBrowser(
  storage: unknown = fakeSessionStorage(),
  location: { pathname: string; href: string; search?: string; hash?: string } = {
    pathname: "/contact",
    href: "https://www.pestbuzzkill.com/contact",
  }
) {
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", {
    gtag: gtagMock,
    clarity: clarityMock,
    history: { replaceState: replaceStateMock },
    location: { search: "", hash: "", ...location },
  });
  vi.stubGlobal("document", { title: "Contact | BuzzKill" });
}

async function freshModule() {
  vi.resetModules();
  return import("./analytics");
}

/** Params of the Nth `gtag('event', …)` call, ignoring `set` calls. */
function eventParams(n = 0): Record<string, unknown> {
  const events = gtagMock.mock.calls.filter((c) => c[0] === "event");
  return (events[n]?.[2] ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  gtagMock.mockClear();
  clarityMock.mockClear();
  replaceStateMock.mockClear();
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lead id persistence", () => {
  it("stores the lead id under bk_lead_id and sets it as a GA4 user property", async () => {
    const { setLeadId, readLeadId } = await freshModule();

    setLeadId("lead-123");

    expect(readLeadId()).toBe("lead-123");
    expect(sessionStorage.getItem("bk_lead_id")).toBe("lead-123");
    expect(gtagMock).toHaveBeenCalledWith("set", "user_properties", { lead_id: "lead-123" });
  });

  it("reads a lead id left in storage by an earlier page load", async () => {
    sessionStorage.setItem("bk_lead_id", "lead-from-earlier");
    const { readLeadId } = await freshModule();

    expect(readLeadId()).toBe("lead-from-earlier");
  });

  it("ignores an empty lead id — a failed submit must not clear a real one", async () => {
    const { setLeadId, readLeadId } = await freshModule();
    setLeadId("lead-123");

    setLeadId(undefined);

    expect(readLeadId()).toBe("lead-123");
  });

  it("takes the newest lead — unlike attribution, last write wins", async () => {
    const { setLeadId, readLeadId } = await freshModule();

    setLeadId("lead-first");
    setLeadId("lead-second");

    expect(readLeadId()).toBe("lead-second");
  });

  it("still tracks in a storage-disabled browser (private mode)", async () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    stubBrowser(throwing);
    const { setLeadId, readLeadId } = await freshModule();

    setLeadId("lead-123");

    // Cache-only, but the current page still reports the lead.
    expect(readLeadId()).toBe("lead-123");
    expect(gtagMock).toHaveBeenCalledWith("set", "user_properties", { lead_id: "lead-123" });
  });
});

describe("lead id stitching onto events", () => {
  it("omits lead_id before the session has produced a lead", async () => {
    const { trackScrollDepth } = await freshModule();

    trackScrollDepth(50);

    expect(eventParams()).not.toHaveProperty("lead_id");
  });

  it("stamps lead_id onto every event once the lead exists", async () => {
    const { setLeadId, trackButtonClick, trackScrollDepth } = await freshModule();
    setLeadId("lead-123");

    trackButtonClick("footer_phone", "Call us", "tel:");
    trackScrollDepth(75);

    expect(eventParams(0).lead_id).toBe("lead-123");
    expect(eventParams(1).lead_id).toBe("lead-123");
  });

  it("lets an explicit lead_id win over the stored one", async () => {
    const { setLeadId, trackFormSubmit } = await freshModule();
    setLeadId("lead-stored");

    trackFormSubmit("contact", "success", { lead_id: "lead-explicit" });

    expect(eventParams().lead_id).toBe("lead-explicit");
  });

  it("carries the lead through to the purchase that closes it", async () => {
    const { trackGenerateLead, trackPurchase } = await freshModule();

    trackGenerateLead("contact", "lead-123");
    trackPurchase("bk-9", 24900);

    const purchase = eventParams(1);
    expect(purchase.lead_id).toBe("lead-123");
    expect(purchase.transaction_id).toBe("bk-9");
    // Same id under the dimension form_submit already uses, so the funnel
    // steps and the revenue join without a rename in Explore.
    expect(purchase.booking_id).toBe("bk-9");
    expect(purchase.value).toBe(249);
    expect(purchase.currency).toBe("USD");
  });

  it("tags Clarity too, so the lead's recording is filterable", async () => {
    const { setLeadId } = await freshModule();

    setLeadId("lead-123");

    expect(clarityMock).toHaveBeenCalledWith("set", "lead_id", "lead-123");
  });

  it("registers the lead as a user property, not just an event param", async () => {
    // Event scope only covers events after the lead existed; the user property
    // is what lets GA4 attribute the earlier page views to the same lead.
    const { trackGenerateLead } = await freshModule();

    trackGenerateLead("talk_to_expert", "lead-123");

    expect(gtagMock).toHaveBeenCalledWith("set", "user_properties", { lead_id: "lead-123" });
  });
});

describe("lead id from an emailed link", () => {
  it("adopts ?bk_lid so the visit is attributed from its very first event", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote?bk_lid=L-77&utm_medium=email",
      search: "?bk_lid=L-77&utm_medium=email",
    });
    const { captureLandingParams, readLeadId, trackPageview } = await freshModule();

    captureLandingParams();
    trackPageview("/quote?bk_lid=L-77&utm_medium=email");

    expect(readLeadId()).toBe("L-77");
    // The page_view that OPENS the visit already names the lead.
    expect(eventParams().lead_id).toBe("L-77");
  });

  it("lets the emailed link override a lead left over from an earlier visit", async () => {
    const storage = fakeSessionStorage();
    storage.setItem("bk_lead_id", "L-old");
    stubBrowser(storage, {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote?bk_lid=L-new",
      search: "?bk_lid=L-new",
    });
    const { captureLandingParams, readLeadId } = await freshModule();

    captureLandingParams();

    expect(readLeadId()).toBe("L-new");
  });

  it("is a no-op when the link carries no lead", async () => {
    const { captureLandingParams, readLeadId } = await freshModule();

    captureLandingParams();

    expect(readLeadId()).toBeUndefined();
    expect(replaceStateMock).not.toHaveBeenCalled();
  });
});

describe("address-bar cleanup", () => {
  it("removes bk_lid from the address bar once captured", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?bk_lid=1",
      search: "?bk_lid=1",
    });
    const { captureLandingParams, readLeadId } = await freshModule();

    captureLandingParams();

    expect(readLeadId()).toBe("1");
    expect(replaceStateMock).toHaveBeenCalledWith({}, "", "/quote/instant");
  });

  /** The whole point: the visitor sees a bare URL. */
  it("leaves the address bar bare after an email click", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?utm_source=front&utm_medium=email&utm_campaign=onground_marketing&bk_lid=1",
      search:
        "?utm_source=front&utm_medium=email&utm_campaign=onground_marketing&bk_lid=1",
    });
    const { captureLandingParams } = await freshModule();

    captureLandingParams();

    expect(replaceStateMock).toHaveBeenCalledWith({}, "", "/quote/instant");
  });

  /**
   * The load-bearing pair. Erasing the utm params means GA4 can no longer parse
   * the campaign off the URL, so both defences have to hold or the session
   * silently reports as direct/none.
   */
  it("pushes the campaign to GA4 explicitly before erasing the params", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?utm_source=front&utm_medium=email&utm_campaign=onground_marketing&utm_content=cta_button",
      search:
        "?utm_source=front&utm_medium=email&utm_campaign=onground_marketing&utm_content=cta_button",
    });
    const { captureLandingParams } = await freshModule();

    captureLandingParams();

    expect(gtagMock).toHaveBeenCalledWith("set", "campaign", {
      source: "front",
      medium: "email",
      name: "onground_marketing",
      content: "cta_button",
    });
  });

  it("reports the original landing URL as the first page_view's page_location", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?utm_source=front&utm_medium=email&bk_lid=1",
      search: "?utm_source=front&utm_medium=email&bk_lid=1",
    });
    const { captureLandingParams, trackPageview } = await freshModule();

    captureLandingParams();
    // The address bar is bare by now, so page_path is bare too — but
    // page_location must still carry the campaign for GA4's own parsing.
    trackPageview("/quote/instant");

    const first = eventParams(0);
    expect(first.page_path).toBe("/quote/instant");
    expect(first.page_location).toBe(
      "https://www.pestbuzzkill.com/quote/instant?utm_source=front&utm_medium=email"
    );
    // bk_lid is redacted from the URL but reported as its own dimension.
    expect(first.page_location).not.toContain("bk_lid");
    expect(first.lead_id).toBe("1");
  });

  it("uses the real URL for page_views after the first — landing is consumed once", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?utm_source=front",
      search: "?utm_source=front",
    });
    const { captureLandingParams, trackPageview } = await freshModule();
    captureLandingParams();

    trackPageview("/quote/instant");
    trackPageview("/services/termite");

    expect(eventParams(0).page_location).toContain("utm_source=front");
    // A genuine navigation reports itself, not the stale landing URL.
    expect(eventParams(1).page_location).toBe(
      "https://www.pestbuzzkill.com/quote/instant?utm_source=front"
    );
  });

  /**
   * gclid becomes the _gcl_aw cookie that carries Google Ads click attribution,
   * and gtag.js loads async — it may still be reading the URL when the cleanup
   * runs. The explicit campaign push covers GA4 but not that cookie.
   */
  it("keeps gclid in the address bar so Ads attribution is not at risk", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?utm_source=google&gclid=xyz&bk_lid=1",
      search: "?utm_source=google&gclid=xyz&bk_lid=1",
    });
    const { captureLandingParams } = await freshModule();

    captureLandingParams();

    const [, , url] = replaceStateMock.mock.calls[0] as [unknown, unknown, string];
    expect(url).toBe("/quote/instant?gclid=xyz");
  });

  it("does not touch the address bar when there is nothing to hide", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/services/termite",
      href: "https://www.pestbuzzkill.com/services/termite",
    });
    const { captureLandingParams } = await freshModule();

    captureLandingParams();

    expect(replaceStateMock).not.toHaveBeenCalled();
  });

  /**
   * `lead` is read from the address bar by QuotePage's own effect, which runs
   * after this. Removing it here would break form prefill and, worse, which
   * lead a payment converts. It's kept out of analytics by redaction instead.
   */
  it("keeps the lead capability token in the address bar for QuotePage", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote?lead=CAPABILITY&bk_lid=1",
      search: "?lead=CAPABILITY&bk_lid=1",
    });
    const { captureLandingParams } = await freshModule();

    captureLandingParams();

    const [, , url] = replaceStateMock.mock.calls[0] as [unknown, unknown, string];
    expect(url).toBe("/quote?lead=CAPABILITY");
  });

  /** The hash carries the saved-quote resume capability. */
  it("preserves the hash", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote?bk_lid=1#request=bk-1&token=abc",
      search: "?bk_lid=1",
      hash: "#request=bk-1&token=abc",
    });
    const { captureLandingParams } = await freshModule();

    captureLandingParams();

    const [, , url] = replaceStateMock.mock.calls[0] as [unknown, unknown, string];
    expect(url).toBe("/quote#request=bk-1&token=abc");
  });
});

describe("the full journey after the email click", () => {
  /**
   * The whole point of the emailed link: one click, then every page and every
   * interaction for the rest of the visit stays tied to that lead — through to
   * the money. Campaign attribution is session-scoped in GA4 and set once from
   * the landing page, so only `lead_id` has to be carried by this code.
   */
  it("keeps the lead attached across pages, clicks and the purchase", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote/instant",
      href: "https://www.pestbuzzkill.com/quote/instant?utm_source=front&utm_medium=email&utm_campaign=onground_marketing&bk_lid=1",
      search:
        "?utm_source=front&utm_medium=email&utm_campaign=onground_marketing&bk_lid=1",
    });
    const {
      captureLandingParams,
      trackPageview,
      trackButtonClick,
      trackScrollDepth,
      trackFormSubmit,
      trackPurchase,
    } = await freshModule();

    captureLandingParams();
    trackPageview("/quote/instant"); // landed from the email
    trackScrollDepth(50);
    trackButtonClick("quote_cta_primary", "Get my price", "/quote");
    trackPageview("/services/termite"); // wandered off
    trackPageview("/book"); // came back to convert
    trackFormSubmit("book", "success", { booking_id: "bk-9" });
    trackPurchase("bk-9", 24900);

    const events = gtagMock.mock.calls.filter((c) => c[0] === "event");
    expect(events).toHaveLength(7);
    // Not one event in the visit is anonymous.
    for (const [, , params] of events) {
      expect((params as Record<string, unknown>).lead_id).toBe("1");
    }
  });
});

describe("capability redaction", () => {
  /**
   * ?lead=<token> prefills a lead's contact details and decides whose booking a
   * payment converts, and /track/<token> is a private tracking link. Neither
   * may reach GA4 or Clarity — an analytics property is read by more people
   * than the funnel is and keeps data for months.
   */
  it("drops the lead capability token from page_path and page_location", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote?lead=SECRET123&utm_source=email",
      search: "?lead=SECRET123&utm_source=email",
    });
    const { trackPageview } = await freshModule();

    trackPageview("/quote?lead=SECRET123&utm_source=email");

    const params = eventParams();
    expect(params.page_path).toBe("/quote?utm_source=email");
    expect(params.page_location).toBe(
      "https://www.pestbuzzkill.com/quote?utm_source=email"
    );
    expect(JSON.stringify(params)).not.toContain("SECRET123");
  });

  it("drops the saved-quote resume capability from the hash", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote#request=bk-1&token=SECRET456",
    });
    const { trackPageview } = await freshModule();

    trackPageview("/quote");

    expect(JSON.stringify(eventParams())).not.toContain("SECRET456");
  });

  it("masks the private tracking token in the path", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/track/SECRET789",
      href: "https://www.pestbuzzkill.com/track/SECRET789",
    });
    const { trackPageview, trackButtonClick } = await freshModule();

    trackPageview("/track/SECRET789");
    trackButtonClick("track_call", "Call", "tel:");

    // Still one reportable row per tracking page, without the capability.
    expect(eventParams(0).page_path).toBe("/track/(token)");
    expect(eventParams(1).page_path).toBe("/track/(token)");
    expect(JSON.stringify(gtagMock.mock.calls)).not.toContain("SECRET789");
  });

  it("keeps bk_lid out of page_path so the Pages report isn't one row per lead", async () => {
    stubBrowser(fakeSessionStorage(), {
      pathname: "/quote",
      href: "https://www.pestbuzzkill.com/quote?bk_lid=L-77",
      search: "?bk_lid=L-77",
    });
    const { trackPageview } = await freshModule();

    trackPageview("/quote?bk_lid=L-77");

    expect(eventParams().page_path).toBe("/quote");
  });

  it("leaves ordinary campaign params alone — GA4 needs them", async () => {
    const { sanitizeAnalyticsPath } = await freshModule();

    expect(
      sanitizeAnalyticsPath("/quote?utm_source=buzzkill&utm_medium=email&gclid=abc")
    ).toBe("/quote?utm_source=buzzkill&utm_medium=email&gclid=abc");
  });
});
