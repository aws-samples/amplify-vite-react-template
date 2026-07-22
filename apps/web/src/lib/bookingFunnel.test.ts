import { describe, expect, it } from "vitest";
import type { PricedQuote } from "./bookingApi";
import {
  amountDueCents,
  defaultQuoteChoice,
  decodeFunnelState,
  encodeFunnelState,
  formatDay,
  hoaMoneyLine,
  humanizeServiceEnum,
  hasRequestedPlan,
  isQuoteExpired,
  loadFunnelState,
  money,
  normalizePhone,
  quoteFieldNeeds,
  saveFunnelState,
  clearFunnelState,
  serviceOption,
  validateQuoteForm,
  FUNNEL_STORAGE_KEY,
  type QuoteFormFields,
  type StorageLike,
} from "./bookingFunnel";

const validFields: QuoteFormFields = {
  name: "Dana Whitfield",
  email: "dana@example.com",
  phone: "(413) 555-0123",
  service: "GENERAL_PEST",
  propertyKind: "RESIDENTIAL",
  street: "12 Elm St",
  city: "Ware",
  state: "MA",
  zip: "01082",
  sqft: "2400",
  nestCount: "",
  removalKind: "",
  removalCount: "",
  units: "",
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
    { date: "2026-07-21", priceCents: 24900 },
    { date: "2026-07-22", priceCents: 22900 },
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

  it("requires sqft in 100..50000 for every sqft-banded service", () => {
    // WASP_NEST (by nest count) and WILDLIFE (by animal count) are not here.
    for (const service of [
      "GENERAL_PEST",
      "RODENT",
      "ROACH",
      "TERMITE",
    ]) {
      expect(validateQuoteForm({ ...validFields, service, sqft: "" }).sqft).toBeTruthy();
      expect(validateQuoteForm({ ...validFields, service, sqft: "99" }).sqft).toBeTruthy();
      expect(validateQuoteForm({ ...validFields, service, sqft: "50001" }).sqft).toBeTruthy();
      expect(validateQuoteForm({ ...validFields, service, sqft: "100" })).toEqual({});
      expect(validateQuoteForm({ ...validFields, service, sqft: "50000" })).toEqual({});
    }
  });

  it("requires nestCount >= 1 for wasp nests at every property kind", () => {
    for (const propertyKind of ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"]) {
      const wasp = { ...validFields, service: "WASP_NEST", propertyKind, sqft: "" };
      expect(validateQuoteForm({ ...wasp, nestCount: "" }).nestCount).toBeTruthy();
      expect(validateQuoteForm({ ...wasp, nestCount: "0" }).nestCount).toBeTruthy();
      // Nest count alone prices it — no sqft/units error at any property kind.
      expect(validateQuoteForm({ ...wasp, nestCount: "2" })).toEqual({});
    }
  });

  it("requires what needs removed + how many for wildlife at every kind", () => {
    for (const propertyKind of ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"]) {
      const wild = { ...validFields, service: "WILDLIFE", propertyKind, sqft: "" };
      const missing = validateQuoteForm({ ...wild, removalKind: "", removalCount: "" });
      expect(missing.removalKind).toBeTruthy();
      expect(missing.removalCount).toBeTruthy();
      expect(missing.sqft).toBeUndefined();
      expect(missing.units).toBeUndefined();
      expect(
        validateQuoteForm({ ...wild, removalKind: "Raccoons", removalCount: "2" })
      ).toEqual({});
    }
  });

  it("COMMUNITY requires units for the sqft/unit-priced services", () => {
    const hoa = {
      ...validFields,
      propertyKind: "COMMUNITY",
      sqft: "",
      nestCount: "",
    };
    expect(validateQuoteForm({ ...hoa, units: "" }).units).toBeTruthy();
    expect(validateQuoteForm({ ...hoa, units: "0" }).units).toBeTruthy();
    expect(validateQuoteForm({ ...hoa, units: "48" })).toEqual({});
    // But a wasp-nest ask at a community prices by nests, not units.
    expect(
      validateQuoteForm({ ...hoa, service: "WASP_NEST", units: "", nestCount: "2" })
    ).toEqual({});
  });

  it("COMMERCIAL requires sqft for the sqft-priced services", () => {
    const biz = { ...validFields, propertyKind: "COMMERCIAL", nestCount: "" };
    // Wasp at a commercial property prices by nests — no sqft required.
    expect(
      validateQuoteForm({ ...biz, service: "WASP_NEST", sqft: "", nestCount: "2" })
    ).toEqual({});
    // A sqft-priced pest still needs sqft at a commercial property.
    expect(
      validateQuoteForm({ ...biz, service: "TERMITE", sqft: "" }).sqft
    ).toBeTruthy();
    expect(validateQuoteForm({ ...biz, service: "TERMITE", sqft: "3000" })).toEqual({});
  });
});

describe("quoteFieldNeeds", () => {
  const needs = (over: Partial<ReturnType<typeof quoteFieldNeeds>>) => ({
    sqft: false,
    nestCount: false,
    units: false,
    removalKind: false,
    removalCount: false,
    lotHalfAcres: false,
    ...over,
  });

  it("residential follows the service catalog", () => {
    expect(quoteFieldNeeds("TERMITE", "RESIDENTIAL")).toEqual(needs({ sqft: true }));
    expect(quoteFieldNeeds("WASP_NEST", "RESIDENTIAL")).toEqual(
      needs({ nestCount: true })
    );
  });

  it("wasp prices by nest count at EVERY property kind", () => {
    for (const kind of ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"]) {
      expect(quoteFieldNeeds("WASP_NEST", kind)).toEqual(needs({ nestCount: true }));
    }
  });

  it("wildlife prices by what + how many at EVERY property kind", () => {
    for (const kind of ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"]) {
      expect(quoteFieldNeeds("WILDLIFE", kind)).toEqual(
        needs({ removalKind: true, removalCount: true })
      );
    }
  });

  it("GL-17: mosquito plans need yard size only, at EVERY property kind", () => {
    for (const kind of ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"]) {
      expect(quoteFieldNeeds("MOSQUITO", kind)).toEqual(needs({ lotHalfAcres: true }));
      expect(quoteFieldNeeds("MOSQUITO_TICK", kind)).toEqual(
        needs({ lotHalfAcres: true })
      );
    }
  });

  it("community is a per-unit plan quote for the sqft/unit-priced services", () => {
    expect(quoteFieldNeeds("RODENT", "COMMUNITY")).toEqual(needs({ units: true }));
  });

  it("commercial is sqft-banded for the sqft-priced services", () => {
    expect(quoteFieldNeeds("RODENT", "COMMERCIAL")).toEqual(needs({ sqft: true }));
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
  it("humanizeServiceEnum prefers catalog labels, falls back to lowercased words", () => {
    expect(humanizeServiceEnum("WASP_NEST")).toBe("Wasp / hornet nest removal");
    expect(humanizeServiceEnum("SOMETHING_NEW")).toBe("something new");
  });
  it("service catalog knows which inputs each service needs", () => {
    expect(serviceOption("GENERAL_PEST")?.needsSqft).toBe(true);
    expect(serviceOption("WASP_NEST")?.needsNestCount).toBe(true);
    expect(serviceOption("GENERAL_PEST")?.offersRecurring).toBe(true);
    expect(serviceOption("RODENT")?.offersRecurring).toBe(false);
    // Termite is sqft-banded; wildlife prices by animal count, not sqft.
    expect(serviceOption("TERMITE")?.needsSqft).toBe(true);
    expect(serviceOption("WILDLIFE")?.needsSqft).toBe(false);
    expect(serviceOption("BOGUS")).toBeUndefined();
  });
});

describe("hoaMoneyLine", () => {
  it("says the first month is charged today, then the monthly price", () => {
    expect(
      hoaMoneyLine({
        frequency: "QUARTERLY",
        monthlyCents: 16000,
        initialFeeCents: 16000,
      })
    ).toBe(
      "Your first month ($160) is charged today to lock in your first visit, then $160/mo."
    );
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
      selection: { date: "2026-07-21", recurring: true },
    };
    expect(decodeFunnelState(encodeFunnelState(state))).toEqual(state);
  });

  it("keeps the planOnly flag through a round trip (community quotes)", () => {
    const state = {
      quote: { ...pricedQuote, planOnly: true },
      selection: { date: "2026-07-21", recurring: true },
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
      selection: { date: "2026-07-21", recurring: "yes" },
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
      amountDueCents(pricedQuote, { date: "2026-07-22", recurring: false })
    ).toBe(22900);
  });
  it("recurring pays the plan's initial fee", () => {
    expect(
      amountDueCents(pricedQuote, { date: "2026-07-21", recurring: true })
    ).toBe(9900);
  });
  it("null when the day is gone or no plan was offered", () => {
    expect(
      amountDueCents(pricedQuote, { date: "2026-08-01", recurring: false })
    ).toBeNull();
    expect(
      amountDueCents(
        { ...pricedQuote, recurringOffer: null },
        { date: "2026-07-21", recurring: true }
      )
    ).toBeNull();
  });
});

describe("requested plan presentation", () => {
  it("keeps an explicitly requested cadence plan-first across response storage", () => {
    const monthlyQuote: PricedQuote = {
      ...pricedQuote,
      service: "General pest control — Monthly plan",
      requestedFrequency: "MONTHLY",
      recurringOffer: {
        frequency: "MONTHLY",
        monthlyCents: 9400,
        initialFeeCents: 25400,
      },
    };

    expect(hasRequestedPlan(monthlyQuote)).toBe(true);
    expect(defaultQuoteChoice(monthlyQuote)).toBe("PLAN");
    const storage = fakeStorage();
    saveFunnelState(storage, { quote: monthlyQuote });
    expect(loadFunnelState(storage)?.quote.requestedFrequency).toBe("MONTHLY");
  });

  it("does not turn an optional plan offer into a requested plan", () => {
    expect(hasRequestedPlan(pricedQuote)).toBe(false);
    expect(defaultQuoteChoice(pricedQuote)).toBe("ONE_TIME");
  });
});

// ── GL-17 — date-less off-season selections ─────────────────────────

describe("off-season (date-less) funnel selections", () => {
  const offSeasonQuote: PricedQuote = {
    ...pricedQuote,
    days: [],
    offSeason: true,
    offSeasonMessage: "Mosquito season runs April–October.",
    recurringOffer: {
      frequency: "MONTHLY",
      monthlyCents: 11900,
      initialFeeCents: 11900,
    },
  };

  it("round-trips a null date selection for an off-season quote", () => {
    const storage = fakeStorage();
    saveFunnelState(storage, {
      quote: offSeasonQuote,
      selection: { date: null, recurring: true },
    });
    const loaded = loadFunnelState(storage);
    expect(loaded?.selection).toEqual({
      date: null,
      recurring: true,
    });
  });

  it("REJECTS a null-date selection on a normal quote — it cannot price", () => {
    const storage = fakeStorage();
    saveFunnelState(storage, {
      quote: pricedQuote,
      selection: { date: null, recurring: true },
    });
    // The quote survives; the impossible selection is treated as absent.
    const loaded = loadFunnelState(storage);
    expect(loaded?.quote.bookingId).toBe("bk-1");
    expect(loaded?.selection).toBeUndefined();
  });

  it("charges the plan's first month today with no day on the board", () => {
    expect(
      amountDueCents(offSeasonQuote, {
        date: null,
        recurring: true,
      })
    ).toBe(11900);
  });
});
