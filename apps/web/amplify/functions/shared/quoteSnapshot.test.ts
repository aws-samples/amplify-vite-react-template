import { describe, expect, it } from "vitest";
import {
  parseQuoteSnapshot,
  serializeQuoteSnapshot,
  type QuoteSnapshot,
} from "./quoteSnapshot";

const OFFER = { frequency: "MONTHLY", monthlyCents: 4500, initialFeeCents: 19900 };
const DAY = { date: "2026-08-10", priceCents: 24900 };

describe("parseQuoteSnapshot", () => {
  it("reads a snapshot written by the funnel", () => {
    const raw = JSON.stringify({
      days: [DAY],
      baseCents: 24900,
      serviceLabel: "Ant & Spider Control",
      recurringOffer: OFFER,
    });
    expect(parseQuoteSnapshot(raw)).toEqual<QuoteSnapshot>({
      days: [DAY],
      baseCents: 24900,
      recurringOffer: OFFER,
      serviceLabel: "Ant & Spider Control",
    });
  });

  it("accepts an already-parsed object, not just a string", () => {
    expect(parseQuoteSnapshot({ days: [DAY] }).days).toEqual([DAY]);
  });

  it.each([null, undefined, "", "not json", "[]", "3", {}, []])(
    "returns an empty snapshot for %p rather than throwing",
    (raw) => {
      expect(parseQuoteSnapshot(raw)).toEqual({
        days: null,
        baseCents: null,
        recurringOffer: null,
      });
    }
  );

  describe("recurringOffer is all-or-nothing", () => {
    // The bug this module exists for: a partial offer used to satisfy /book's
    // `!stored.recurringOffer` guard and then yield `undefined` as the amount
    // charged to the card.
    it.each([
      ["initialFeeCents missing", { frequency: "MONTHLY", monthlyCents: 4500 }],
      ["monthlyCents missing", { frequency: "MONTHLY", initialFeeCents: 19900 }],
      ["frequency missing", { monthlyCents: 4500, initialFeeCents: 19900 }],
      ["frequency empty", { ...OFFER, frequency: "  " }],
      ["initialFeeCents null", { ...OFFER, initialFeeCents: null }],
      ["initialFeeCents a string", { ...OFFER, initialFeeCents: "19900" }],
      ["initialFeeCents NaN", { ...OFFER, initialFeeCents: Number.NaN }],
      ["initialFeeCents fractional", { ...OFFER, initialFeeCents: 199.5 }],
      ["offer is not an object", "MONTHLY"],
    ])("drops the offer entirely when %s", (_label, recurringOffer) => {
      expect(parseQuoteSnapshot({ recurringOffer }).recurringOffer).toBeNull();
    });

    it("keeps a complete offer", () => {
      expect(parseQuoteSnapshot({ recurringOffer: OFFER }).recurringOffer).toEqual(OFFER);
    });
  });

  describe("days", () => {
    it("drops only the unusable entries", () => {
      const snapshot = parseQuoteSnapshot({
        days: [DAY, { date: "2026-08-11" }, { priceCents: 100 }, null, "x"],
      });
      expect(snapshot.days).toEqual([DAY]);
    });

    it("collapses an all-malformed list to null so callers refuse the day", () => {
      expect(parseQuoteSnapshot({ days: [{ date: "2026-08-11" }] }).days).toBeNull();
    });

    it("collapses an empty list to null", () => {
      expect(parseQuoteSnapshot({ days: [] }).days).toBeNull();
    });

    it("preserves the slot and factors the pricer stamped", () => {
      const stamped = {
        ...DAY,
        slot: { technicianId: "tech-1", claimMinutes: 75 },
        factors: ["zone B"],
      };
      expect(parseQuoteSnapshot({ days: [stamped] }).days).toEqual([stamped]);
    });

    it("does not let a malformed price survive via the spread", () => {
      expect(parseQuoteSnapshot({ days: [{ ...DAY, priceCents: "24900" }] }).days).toBeNull();
    });

    describe("planInitialFeeCents is CHARGED, so it is validated not carried", () => {
      it("keeps a well-formed per-day plan fee", () => {
        const day = { ...DAY, planInitialFeeCents: 12700 };
        expect(parseQuoteSnapshot({ days: [day] }).days).toEqual([day]);
      });

      it.each([["24900"], [NaN], [Infinity], [149.5], [null], [0], [-100]])(
        "drops %p rather than letting it reach a charge amount",
        (bad) => {
          const parsed = parseQuoteSnapshot({
            days: [{ ...DAY, planInitialFeeCents: bad }],
          });
          // The day itself survives on its priceCents; only the bad fee is
          // dropped, so /book falls back to the offer's flat initialFeeCents.
          expect(parsed.days).toEqual([DAY]);
          expect(parsed.days![0].planInitialFeeCents).toBeUndefined();
        }
      );
    });
  });

  describe("flags and labels", () => {
    it("treats only literal true as set", () => {
      const snapshot = parseQuoteSnapshot({ planOnly: "yes", offSeason: 1 });
      expect(snapshot.planOnly).toBeUndefined();
      expect(snapshot.offSeason).toBeUndefined();
    });

    it("carries planOnly and offSeason through", () => {
      const snapshot = parseQuoteSnapshot({ planOnly: true, offSeason: true });
      expect(snapshot.planOnly).toBe(true);
      expect(snapshot.offSeason).toBe(true);
    });

    it("carries a contact-only quote's message", () => {
      const snapshot = parseQuoteSnapshot({ contactMessage: "We'll call you." });
      expect(snapshot.contactMessage).toBe("We'll call you.");
      expect(snapshot.days).toBeNull();
    });

    it("ignores a blank serviceLabel", () => {
      expect(parseQuoteSnapshot({ serviceLabel: "   " }).serviceLabel).toBeUndefined();
    });
  });

  it("accepts zero cents (a fully discounted day is still a real day)", () => {
    expect(parseQuoteSnapshot({ days: [{ date: "2026-08-10", priceCents: 0 }] }).days).toEqual([
      { date: "2026-08-10", priceCents: 0 },
    ]);
  });
});

describe("serializeQuoteSnapshot", () => {
  it("round-trips through parse", () => {
    const snapshot = {
      days: [DAY],
      baseCents: 24900,
      serviceLabel: "Ant & Spider Control",
      recurringOffer: OFFER,
      planOnly: true,
    };
    expect(parseQuoteSnapshot(serializeQuoteSnapshot(snapshot))).toEqual({
      days: [DAY],
      baseCents: 24900,
      serviceLabel: "Ant & Spider Control",
      recurringOffer: OFFER,
      planOnly: true,
    });
  });

  it("produces a string, because a.json() model fields reject an object", () => {
    expect(typeof serializeQuoteSnapshot({ days: [DAY] })).toBe("string");
  });

  it("omits false flags rather than storing them", () => {
    const written = JSON.parse(serializeQuoteSnapshot({ days: [DAY], planOnly: false }));
    expect("planOnly" in written).toBe(false);
  });
});
