import { describe, expect, it } from "vitest";
import {
  awaitingDeposit,
  depositableCents,
  isManualSettled,
  type DepositInvoice,
} from "./deposits";

/**
 * The deposit queue exists because cash and cheques only reach the bank if a
 * human takes them there. The one rule under test: manual settled money with
 * no deposit confirmation is outstanding; everything Stripe touches is not.
 */

const inv = (over: Partial<DepositInvoice> = {}): DepositInvoice => ({
  amountCents: 12500,
  status: "PAID",
  ...over,
});

describe("isManualSettled", () => {
  it("accepts an offline-settled PAID invoice", () => {
    expect(isManualSettled(inv())).toBe(true);
  });

  it("accepts a REFUNDED invoice (the kept part still needs banking)", () => {
    expect(
      isManualSettled(inv({ status: "REFUNDED", refundedAmountCents: 2500 }))
    ).toBe(true);
  });

  it("rejects anything Stripe settled — payouts bank that money", () => {
    expect(isManualSettled(inv({ stripePaymentIntentId: "pi_1" }))).toBe(false);
    expect(isManualSettled(inv({ stripeInvoiceId: "in_1" }))).toBe(false);
  });

  it("rejects unsettled invoices — no money in hand yet", () => {
    expect(isManualSettled(inv({ status: "OPEN" }))).toBe(false);
    expect(isManualSettled(inv({ status: "FAILED" }))).toBe(false);
    expect(isManualSettled(inv({ status: "VOID" }))).toBe(false);
  });
});

describe("awaitingDeposit", () => {
  it("keeps only manual settled invoices with no deposit stamp", () => {
    const waiting = inv();
    const deposited = inv({ depositedAt: "2026-07-20T12:00:00Z" });
    const stripe = inv({ stripePaymentIntentId: "pi_1" });
    const unpaid = inv({ status: "OPEN" });
    expect(awaitingDeposit([waiting, deposited, stripe, unpaid])).toEqual([
      waiting,
    ]);
  });
});

describe("depositableCents", () => {
  it("is the invoice amount when nothing was refunded", () => {
    expect(depositableCents(inv())).toBe(12500);
  });

  it("nets refunds out — only kept money goes to the bank", () => {
    expect(depositableCents(inv({ refundedAmountCents: 2500 }))).toBe(10000);
    expect(depositableCents(inv({ refundedAmountCents: 99999 }))).toBe(0);
  });
});
