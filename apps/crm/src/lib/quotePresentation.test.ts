import { describe, expect, it } from "vitest";
import { summarizeQuote, type QuoteRow } from "./quotePresentation";

/**
 * The office's one-line answer to "what did we quote this customer?".
 *
 * The regression this guards: the panel read `serviceLabel` raw — the
 * canonical ONE-TIME name — and printed it beside the plan's MONTHLY rate. A
 * quarterly lead read "General pest control — one-time treatment — $39.00/mo",
 * and a customer who had paid $174 read "…— one-time treatment — $72.00/mo".
 * Label and price contradicted each other and neither was the money.
 */

const FUNNEL = "https://staging.example.com/quote";

/** A quarterly GPC quote as booking-public actually stores it: the label is
 *  the one-time name, the plan rides alongside in `recurringOffer`. */
const quarterlyQuoteJson = JSON.stringify({
  serviceLabel: "General pest control — one-time treatment",
  baseCents: 36000,
  recurringOffer: {
    frequency: "QUARTERLY",
    monthlyCents: 3900,
    initialFeeCents: 14900,
  },
  days: [{ date: "2026-08-06", priceCents: 36000, planInitialFeeCents: 14200 }],
});

const QUOTED_PLAN: QuoteRow = {
  id: "br1",
  status: "QUOTED",
  quoteJson: quarterlyQuoteJson,
  service: "GENERAL_PEST",
  recurringPreference: "QUARTERLY",
  monthlyCents: 3900,
  cancelToken: "tok",
};

describe("summarizeQuote — the service label", () => {
  it("names the plan the customer asked for, not the stored one-time label", () => {
    const s = summarizeQuote(QUOTED_PLAN, FUNNEL)!;
    expect(s.service).toBe("General pest control — Quarterly plan");
    expect(s.service).not.toMatch(/one-time/i);
  });

  it("keeps the one-time label when no plan was requested", () => {
    const s = summarizeQuote(
      { ...QUOTED_PLAN, recurringPreference: null },
      FUNNEL
    )!;
    expect(s.service).toBe("General pest control — one-time treatment");
  });

  it("describes a BOOKED row by what was bought, not what was asked for", () => {
    // They browsed one-time and bought the plan at checkout: `recurring` is
    // the settled fact, and `recurringPreference` never caught up.
    const s = summarizeQuote(
      {
        ...QUOTED_PLAN,
        status: "BOOKED",
        recurring: true,
        recurringPreference: null,
        amountCents: 14200,
      },
      FUNNEL
    )!;
    expect(s.service).toBe("General pest control — Quarterly plan");
  });
});

describe("summarizeQuote — the money", () => {
  it("shows what was actually charged, then the ongoing rate", () => {
    const s = summarizeQuote(
      { ...QUOTED_PLAN, status: "BOOKED", recurring: true, amountCents: 14200 },
      FUNNEL
    )!;
    // The old row showed "$39.00/mo" alone — never the $142 that left the card.
    expect(s.price).toBe("$142.00 paid");
    expect(s.priceNote).toBe("then $39.00/mo");
  });

  it("shows the first-visit fee, not the monthly, on an unbooked plan quote", () => {
    const s = summarizeQuote(QUOTED_PLAN, FUNNEL)!;
    expect(s.price).toBe("$149.00 first visit");
    expect(s.priceNote).toBe("then $39.00/mo");
  });

  it("shows a one-time quote as one-time, with no monthly tail", () => {
    const s = summarizeQuote(
      { ...QUOTED_PLAN, recurringPreference: null, monthlyCents: null },
      FUNNEL
    )!;
    expect(s.price).toBe("$360.00 one-time");
    expect(s.priceNote).toBeNull();
  });

  it("marks a still-clearing payment as processing, never as paid", () => {
    const s = summarizeQuote(
      {
        ...QUOTED_PLAN,
        status: "PROCESSING",
        recurring: true,
        amountCents: 14200,
      },
      FUNNEL
    )!;
    expect(s.price).toBe("$142.00 processing");
    expect(s.statusLabel).toBe("payment processing");
  });

  it("states no price rather than a wrong one when the quote carries none", () => {
    const s = summarizeQuote(
      { id: "br2", status: "QUOTED", quoteJson: null, service: "GENERAL_PEST" },
      FUNNEL
    )!;
    expect(s.price).toBeNull();
    expect(s.priceNote).toBeNull();
  });
});

describe("summarizeQuote — status and the resume link", () => {
  it("offers the resume link only while the quote is still bookable", () => {
    expect(summarizeQuote(QUOTED_PLAN, FUNNEL)!.bookLink).toBe(
      `${FUNNEL}#request=br1&token=tok`
    );
    expect(
      summarizeQuote({ ...QUOTED_PLAN, status: "BOOKED" }, FUNNEL)!.bookLink
    ).toBeNull();
  });

  it("shows nothing at all for a contact-only enquiry", () => {
    expect(summarizeQuote({ ...QUOTED_PLAN, status: "CONTACT" }, FUNNEL)).toBeNull();
  });
});
