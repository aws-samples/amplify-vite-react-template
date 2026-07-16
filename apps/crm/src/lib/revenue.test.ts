import { describe, expect, it } from "vitest";
import { netCollectedCents, revenueTotals, type RevenueInvoice } from "./revenue";

/**
 * The Dashboard's four tiles are the only revenue numbers anyone at BuzzKill
 * reads. Before refunds existed they counted refunded money as revenue in
 * perpetuity, because the only way to refund was the Stripe dashboard and
 * nothing wrote it back to the invoice.
 */

const inv = (over: Partial<RevenueInvoice> = {}): RevenueInvoice => ({
  amountCents: 29900,
  status: "PAID",
  refundedAmountCents: null,
  ...over,
});

describe("netCollectedCents", () => {
  it("counts a paid invoice in full", () => {
    expect(netCollectedCents(inv())).toBe(29900);
  });

  it("counts a fully refunded invoice as nothing", () => {
    expect(
      netCollectedCents(inv({ status: "REFUNDED", refundedAmountCents: 29900 }))
    ).toBe(0);
  });

  it("counts only the kept part of a partly refunded invoice", () => {
    // Still PAID — filtering on status alone would count all $299.
    expect(netCollectedCents(inv({ refundedAmountCents: 10000 }))).toBe(19900);
  });

  it("counts an unpaid invoice as nothing", () => {
    expect(netCollectedCents(inv({ status: "OPEN" }))).toBe(0);
    expect(netCollectedCents(inv({ status: "FAILED" }))).toBe(0);
  });

  it("never goes negative if a refund somehow exceeds the invoice", () => {
    expect(netCollectedCents(inv({ refundedAmountCents: 50000 }))).toBe(0);
  });
});

describe("revenueTotals", () => {
  it("nets a full refund out of both billed and paid", () => {
    const totals = revenueTotals([
      inv({ amountCents: 29900 }),
      inv({ amountCents: 10000, status: "REFUNDED", refundedAmountCents: 10000 }),
    ]);

    expect(totals.paidCents).toBe(29900);
    expect(totals.billedCents).toBe(29900);
    expect(totals.refundedCents).toBe(10000);
  });

  it("nets a partial refund out while the invoice is still PAID", () => {
    const totals = revenueTotals([inv({ refundedAmountCents: 10000 })]);

    expect(totals.paidCents).toBe(19900);
    expect(totals.billedCents).toBe(19900);
    expect(totals.refundedCents).toBe(10000);
  });

  it("keeps unpaid and failed money out of paid", () => {
    const totals = revenueTotals([
      inv({ amountCents: 10000, status: "OPEN" }),
      inv({ amountCents: 5000, status: "FAILED" }),
      inv({ amountCents: 29900 }),
    ]);

    expect(totals.paidCents).toBe(29900);
    expect(totals.openCents).toBe(10000);
    expect(totals.failedCents).toBe(5000);
  });

  it("reports nothing refunded when nothing was", () => {
    expect(revenueTotals([inv(), inv()]).refundedCents).toBe(0);
  });

  it("handles an empty period", () => {
    expect(revenueTotals([])).toEqual({
      billedCents: 0,
      paidCents: 0,
      openCents: 0,
      failedCents: 0,
      refundedCents: 0,
    });
  });

  it("does not let a refund on an unpaid invoice affect the totals", () => {
    // Shouldn't happen — refundInvoice refuses a non-paid invoice — but the
    // numbers must not silently move if it ever did.
    const totals = revenueTotals([
      inv({ amountCents: 10000, status: "OPEN", refundedAmountCents: 10000 }),
    ]);

    expect(totals.refundedCents).toBe(0);
    expect(totals.paidCents).toBe(0);
    expect(totals.openCents).toBe(10000);
  });
});
