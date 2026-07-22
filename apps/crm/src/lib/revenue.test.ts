import { describe, expect, it } from "vitest";
import {
  CLIENT_TYPES,
  netCollectedCents,
  revenueByClientType,
  revenueTotals,
  type RevenueInvoice,
} from "./revenue";

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

describe("revenueByClientType", () => {
  const job = (
    id: string,
    customerId: string,
    propertyClass: string | null,
    when: Partial<{ completedAt: string; scheduledDate: string }> = {}
  ) => ({ id, customerId, propertyClass, ...when });

  const cinv = (
    customerId: string,
    over: Partial<RevenueInvoice & { jobId: string | null }> = {}
  ) => ({ ...inv(), customerId, ...over });

  it("classifies by the invoice's own job first", () => {
    const split = revenueByClientType(
      [cinv("c1", { jobId: "j1", amountCents: 10000 })],
      [
        job("j1", "c1", "COMMERCIAL"),
        // A newer residential job exists, but the invoice's job wins.
        job("j2", "c1", "RESIDENTIAL", { completedAt: "2026-07-20T00:00:00Z" }),
      ]
    );
    expect(split.COMMERCIAL.billedCents).toBe(10000);
    expect(split.RESIDENTIAL.billedCents).toBe(0);
  });

  it("falls back to the customer's most recent classified job", () => {
    const split = revenueByClientType(
      [cinv("c1", { amountCents: 5000 })],
      [
        job("j1", "c1", "RESIDENTIAL", { completedAt: "2026-01-01T00:00:00Z" }),
        job("j2", "c1", "COMMUNITY", { completedAt: "2026-06-01T00:00:00Z" }),
      ]
    );
    expect(split.COMMUNITY.billedCents).toBe(5000);
    expect(split.COMMUNITY.invoiceCount).toBe(1);
  });

  it("lands invoices with no classifiable job in UNCLASSIFIED", () => {
    const split = revenueByClientType(
      [cinv("c1", { amountCents: 7000 }), cinv("c2", { jobId: "jx", amountCents: 3000 })],
      [job("j1", "c1", null), job("jx", "c2", "GARBAGE")]
    );
    expect(split.UNCLASSIFIED.billedCents).toBe(10000);
    expect(split.UNCLASSIFIED.invoiceCount).toBe(2);
  });

  it("keeps each slice refund-aware, matching the top tiles", () => {
    const split = revenueByClientType(
      [
        cinv("c1", { jobId: "j1", amountCents: 20000, refundedAmountCents: 5000 }),
        cinv("c1", { jobId: "j1", amountCents: 10000, status: "OPEN" }),
      ],
      [job("j1", "c1", "RESIDENTIAL")]
    );
    expect(split.RESIDENTIAL.billedCents).toBe(25000);
    expect(split.RESIDENTIAL.paidCents).toBe(15000);
    expect(split.RESIDENTIAL.openCents).toBe(10000);
    expect(split.RESIDENTIAL.refundedCents).toBe(5000);
  });

  it("slices sum to the whole — nothing dropped, nothing double-counted", () => {
    const invoices = [
      cinv("c1", { jobId: "j1", amountCents: 11000 }),
      cinv("c2", { amountCents: 22000 }),
      cinv("c3", { amountCents: 33000 }),
    ];
    const jobs = [
      job("j1", "c1", "RESIDENTIAL"),
      job("j2", "c2", "COMMERCIAL", { completedAt: "2026-05-01T00:00:00Z" }),
    ];
    const split = revenueByClientType(invoices, jobs);
    const whole = revenueTotals(invoices);
    const sum = (f: (t: (typeof split)["RESIDENTIAL"]) => number) =>
      CLIENT_TYPES.reduce((s, t) => s + f(split[t]), 0);
    expect(sum((t) => t.billedCents)).toBe(whole.billedCents);
    expect(sum((t) => t.paidCents)).toBe(whole.paidCents);
    expect(sum((t) => t.invoiceCount)).toBe(3);
  });
});
