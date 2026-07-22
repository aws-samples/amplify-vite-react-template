import { describe, expect, it } from "vitest";
import {
  discountFor,
  normalizeCode,
  promoLabel,
  resolvePromo,
  type PromoRow,
} from "./promo";

const NOW = Date.UTC(2026, 6, 21); // 2026-07-21

function code(overrides: Partial<PromoRow> = {}): PromoRow {
  return {
    id: "p1",
    code: "SAVE20",
    kind: "PERCENT",
    percentOff: 20,
    active: true,
    ...overrides,
  };
}

/** A one-row client whose lookup returns `row` for any code (or none). */
function clientWith(row: PromoRow | null) {
  return {
    models: {
      PromoCode: {
        listPromoCodeByCode: async () => ({ data: row ? [row] : [] }),
      },
    },
  };
}

describe("normalizeCode", () => {
  it("uppercases and trims", () => {
    expect(normalizeCode("  save20 ")).toBe("SAVE20");
    expect(normalizeCode(null)).toBe("");
    expect(normalizeCode(undefined)).toBe("");
  });
});

describe("discountFor", () => {
  it("takes a percentage off, rounded to the cent", () => {
    expect(discountFor(code({ kind: "PERCENT", percentOff: 20 }), 10_000)).toBe(2_000);
    // 15% of $33.33 = 499.95¢ → 500¢
    expect(discountFor(code({ kind: "PERCENT", percentOff: 15 }), 3_333)).toBe(500);
  });

  it("takes a fixed amount off", () => {
    expect(
      discountFor(code({ kind: "FIXED", percentOff: null, amountOffCents: 2_500 }), 10_000)
    ).toBe(2_500);
  });

  it("never discounts more than the base (a big code just zeroes it)", () => {
    expect(
      discountFor(code({ kind: "FIXED", amountOffCents: 50_000 }), 8_000)
    ).toBe(8_000);
    expect(discountFor(code({ kind: "PERCENT", percentOff: 100 }), 8_000)).toBe(8_000);
  });

  it("is zero for a non-positive base or a misconfigured code", () => {
    expect(discountFor(code(), 0)).toBe(0);
    expect(discountFor(code(), -5)).toBe(0);
    expect(discountFor(code({ percentOff: null }), 10_000)).toBe(0);
    expect(
      discountFor(code({ kind: "FIXED", amountOffCents: null, percentOff: null }), 10_000)
    ).toBe(0);
  });
});

describe("resolvePromo", () => {
  it("rejects an empty code without a lookup", async () => {
    const r = await resolvePromo(clientWith(null), "   ", NOW);
    expect(r).toEqual({ ok: false, message: "Enter a discount code." });
  });

  it("resolves a valid active code", async () => {
    const r = await resolvePromo(clientWith(code()), "save20", NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.promo.code).toBe("SAVE20");
  });

  it("rejects an unknown or inactive code as simply 'not valid'", async () => {
    expect(await resolvePromo(clientWith(null), "NOPE", NOW)).toMatchObject({
      ok: false,
      message: "That discount code isn't valid.",
    });
    expect(
      await resolvePromo(clientWith(code({ active: false })), "SAVE20", NOW)
    ).toMatchObject({ ok: false });
  });

  it("honors the validity window", async () => {
    const future = new Date(NOW + 86_400_000).toISOString();
    const past = new Date(NOW - 86_400_000).toISOString();
    expect(
      await resolvePromo(clientWith(code({ startsAt: future })), "SAVE20", NOW)
    ).toMatchObject({ ok: false });
    expect(
      await resolvePromo(clientWith(code({ endsAt: past })), "SAVE20", NOW)
    ).toMatchObject({ ok: false });
    // In-window passes.
    expect(
      (await resolvePromo(clientWith(code({ startsAt: past, endsAt: future })), "SAVE20", NOW)).ok
    ).toBe(true);
  });

  it("refuses a fully-redeemed capped code", async () => {
    const r = await resolvePromo(
      clientWith(code({ maxRedemptions: 5, timesRedeemed: 5 })),
      "SAVE20",
      NOW
    );
    expect(r).toMatchObject({
      ok: false,
      message: "That discount code has been fully redeemed.",
    });
  });

  it("allows a capped code that still has room", async () => {
    const r = await resolvePromo(
      clientWith(code({ maxRedemptions: 5, timesRedeemed: 4 })),
      "SAVE20",
      NOW
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a misconfigured (zero-value) code as not valid", async () => {
    const r = await resolvePromo(
      clientWith(code({ kind: "PERCENT", percentOff: 0 })),
      "SAVE20",
      NOW
    );
    expect(r).toMatchObject({ ok: false, message: "That discount code isn't valid." });
  });
});

describe("promoLabel", () => {
  it("describes a percentage code", () => {
    expect(promoLabel(code({ kind: "PERCENT", percentOff: 20 }))).toBe("SAVE20 (20% off)");
  });
  it("describes a fixed code", () => {
    expect(
      promoLabel(code({ code: "TAKE25", kind: "FIXED", amountOffCents: 2_500 }))
    ).toBe("TAKE25 ($25.00 off)");
  });
});
