import { describe, expect, it } from "vitest";
import type { PricedQuote } from "./bookingApi";
import {
  amountDueCents,
  decodeFunnelState,
  encodeFunnelState,
  formatDay,
  humanizeServiceEnum,
  isQuoteExpired,
  loadFunnelState,
  money,
  normalizePhone,
  saveFunnelState,
  clearFunnelState,
  serviceOption,
  validateQuoteForm,
  windowLabel,
  FUNNEL_STORAGE_KEY,
  type QuoteFormFields,
  type StorageLike,
} from "./bookingFunnel";

const validFields: QuoteFormFields = {
  name: "Dana Whitfield",
  email: "dana@example.com",
  phone: "(413) 555-0123",
  service: "GENERAL_PEST",
  street: "12 Elm St",
  city: "Ware",
  state: "MA",
  zip: "01082",
  sqft: "2400",
  nestCount: "",
};

function fakeStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

const pricedQuote: PricedQuote = {
  bookingId: "bk-1",
  decision: "PRICED",
  service: "General pest control — one-time treatment",
  recurringOffer: {
    frequency: "QUARTERLY",
    monthlyCents: 4500,
    initialFeeCents: 9900,
  },
  days: [
    { date: "2026-07-21", windows: ["MORNING", "AFTERNOON"], priceCents: 24900 },
    { date: "2026-07-22", windows: ["AFTERNOON"], priceCents: 22900 },
  ],
  expiresAt: "2026-07-17T12:00:00.000Z",
  terms: { version: "2026-07-16", text: "The terms." },
};

// ── validateQuoteForm — mirrors the server's /quote rules ───────────

describe("validateQuoteForm", () => {
  it("passes a complete, valid form", () => {
    expect(validateQuoteForm(validFields)).toEqual({});
  });

  it("requires name, email, service, and address parts with server-matching keys", () => {
    const errors = validateQuoteForm({
      ...validFields,
      name: "  ",
      email: "not-an-email",
      service: "",
      street: "",
      city: "",
      state: "",
    });
    expect(Object.keys(errors).sort()).toEqual(
      [
        "address.city",
        "address.state",
        "address.street",
        "email",
        "name",
        "service",
      ].sort()
    );
  });

  it("accepts the emails the server accepts and rejects the ones it rejects", () => {
    expect(validateQuoteForm({ ...validFields, email: "a.b+c@d-e.co.uk" })).toEqual({});
    expect(validateQuoteForm({ ...validFields, email: "a@b" }).email).toBeTruthy();
    expect(validateQuoteForm({ ...validFields, email: "a b@c.com" }).email).toBeTruthy();
  });

  it("phone is optional, but garbage phone is an error", () => {
    expect(validateQuoteForm({ ...validFields, phone: "" })).toEqual({});
    expect(validateQuoteForm({ ...validFields, phone: "call me" }).phone).toBeTruthy();
  });

  it("requires sqft in 100..50000 only for sqft services", () => {
    for (const service of ["GENERAL_PEST", "RODENT", "ROACH"]) {
      expect(validateQuoteForm({ ...validFields, service, sqft: "" }).sqft).toBeTruthy();
      expect(validateQuoteForm({ ...validFields, service, sqft: "99" }).sqft).toBeTruthy();
      expect(validateQuoteForm({ ...validFields, service, sqft: "50001" }).sqft).toBeTruthy();
      expect(validateQuoteForm({ ...validFields, service, sqft: "100" })).toEqual({});
      expect(validateQuoteForm({ ...validFields, service, sqft: "50000" })).toEqual({});
    }
    expect(
      validateQuoteForm({ ...validFields, service: "TERMITE", sqft: "" })
    ).toEqual({});
  });

  it("requires nestCount >= 1 only for wasp nests", () => {
    const wasp = { ...validFields, service: "WASP_NEST", sqft: "" };
    expect(validateQuoteForm({ ...wasp, nestCount: "" }).nestCount).toBeTruthy();
    expect(validateQuoteForm({ ...wasp, nestCount: "0" }).nestCount).toBeTruthy();
    expect(validateQuoteForm({ ...wasp, nestCount: "2" })).toEqual({});
  });
});

// ── normalizePhone — mirrors the server ─────────────────────────────

describe("normalizePhone", () => {
  it("normalizes 10-digit US numbers", () => {
    expect(normalizePhone("(413) 555-0123")).toBe("+14135550123");
  });
  it("normalizes 1-prefixed numbers", () => {
    expect(normalizePhone("1-413-555-0123")).toBe("+14135550123");
  });
  it("keeps valid E.164 as-is", () => {
    expect(normalizePhone("+14135550123")).toBe("+14135550123");
  });
  it("returns null for the unsalvageable", () => {
    expect(normalizePhone("555-0123")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

// ── Formatting ──────────────────────────────────────────────────────

describe("money", () => {
  it("keeps whole dollars whole, like the server's money()", () => {
    expect(money(24900)).toBe("$249");
    expect(money(9950)).toBe("$99.50");
    expect(money(0)).toBe("$0");
  });
});

describe("formatDay", () => {
  it("renders the calendar date, not a UTC-shifted one", () => {
    // new Date("2026-07-21") is UTC midnight = July 20 in US timezones;
    // the funnel must show the 21st.
    expect(formatDay("2026-07-21")).toBe("Tue, Jul 21");
  });
  it("passes through non-ISO strings untouched", () => {
    expect(formatDay("soon")).toBe("soon");
  });
});

describe("labels", () => {
  it("windowLabel humanizes the two windows", () => {
    expect(windowLabel("MORNING")).toBe("Morning");
    expect(windowLabel("AFTERNOON")).toBe("Afternoon");
  });
  it("humanizeServiceEnum prefers catalog labels, falls back to lowercased words", () => {
    expect(humanizeServiceEnum("WASP_NEST")).toBe("Wasp / hornet nest removal");
    expect(humanizeServiceEnum("SOMETHING_NEW")).toBe("something new");
  });
  it("service catalog knows which inputs each service needs", () => {
    expect(serviceOption("GENERAL_PEST")?.needsSqft).toBe(true);
    expect(serviceOption("WASP_NEST")?.needsNestCount).toBe(true);
    expect(serviceOption("GENERAL_PEST")?.offersRecurring).toBe(true);
    expect(serviceOption("RODENT")?.offersRecurring).toBe(false);
    expect(serviceOption("BOGUS")).toBeUndefined();
  });
});

// ── Expiry ──────────────────────────────────────────────────────────

describe("isQuoteExpired", () => {
  const now = Date.parse("2026-07-16T12:00:00Z");
  it("is fresh before expiresAt and expired after", () => {
    expect(isQuoteExpired("2026-07-17T12:00:00Z", now)).toBe(false);
    expect(isQuoteExpired("2026-07-16T11:59:59Z", now)).toBe(true);
  });
  it("treats unparseable dates as expired (fail closed)", () => {
    expect(isQuoteExpired("not a date", now)).toBe(true);
  });
});

// ── sessionStorage codec ────────────────────────────────────────────

describe("funnel state codec", () => {
  it("round-trips a quote with a selection", () => {
    const state = {
      quote: pricedQuote,
      selection: { date: "2026-07-21", window: "MORNING" as const, recurring: true },
    };
    expect(decodeFunnelState(encodeFunnelState(state))).toEqual(state);
  });

  it("returns null for absent, corrupt, or wrong-shaped payloads", () => {
    expect(decodeFunnelState(null)).toBeNull();
    expect(decodeFunnelState("{not json")).toBeNull();
    expect(decodeFunnelState(JSON.stringify({ quote: { decision: "CONTACT" } }))).toBeNull();
    expect(decodeFunnelState(JSON.stringify({}))).toBeNull();
  });

  it("drops an invalid selection but keeps the valid quote", () => {
    const raw = JSON.stringify({
      quote: pricedQuote,
      selection: { date: "2026-07-21", window: "EVENING", recurring: true },
    });
    expect(decodeFunnelState(raw)).toEqual({ quote: pricedQuote });
  });

  it("save/load/clear go through the injected storage", () => {
    const storage = fakeStorage();
    const state = { quote: pricedQuote };
    saveFunnelState(storage, state);
    expect(storage.store.has(FUNNEL_STORAGE_KEY)).toBe(true);
    expect(loadFunnelState(storage)).toEqual(state);
    clearFunnelState(storage);
    expect(loadFunnelState(storage)).toBeNull();
  });

  it("swallows storage failures instead of breaking the funnel", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    expect(() => saveFunnelState(throwing, { quote: pricedQuote })).not.toThrow();
    expect(loadFunnelState(throwing)).toBeNull();
    expect(() => clearFunnelState(throwing)).not.toThrow();
  });
});

// ── Amount due — same rule as the server's /book ────────────────────

describe("amountDueCents", () => {
  it("one-time pays the selected day's price", () => {
    expect(
      amountDueCents(pricedQuote, { date: "2026-07-22", window: "AFTERNOON", recurring: false })
    ).toBe(22900);
  });
  it("recurring pays the plan's initial fee", () => {
    expect(
      amountDueCents(pricedQuote, { date: "2026-07-21", window: "MORNING", recurring: true })
    ).toBe(9900);
  });
  it("null when the day is gone or no plan was offered", () => {
    expect(
      amountDueCents(pricedQuote, { date: "2026-08-01", window: "MORNING", recurring: false })
    ).toBeNull();
    expect(
      amountDueCents(
        { ...pricedQuote, recurringOffer: null },
        { date: "2026-07-21", window: "MORNING", recurring: true }
      )
    ).toBeNull();
  });
});
