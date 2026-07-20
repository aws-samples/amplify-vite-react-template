import { describe, expect, it } from "vitest";
import {
  computeMoneyMismatches,
  computePlanMismatches,
  computeStateMismatches,
} from "./leadershipRecon";

/**
 * GL-19 — the daily leadership reconciliations' pure rules. Each mismatch
 * key is stable (retries collapse onto one owned item), funnel money stays
 * the GL-05 pass's, and legitimate states (offline payments, nonrefundable
 * cancels, in-flight debits) are never false-flagged.
 */

describe("money — provider payments/refunds vs the CRM ledger", () => {
  const WINDOW = "2026-06-01T00:00:00.000Z";

  it("clean books: every payment matched, every refund recorded, net cash explained", () => {
    const { mismatches, summary } = computeMoneyMismatches({
      payments: [
        { id: "pi_1", amountCents: 20000 },
        { id: "pi_sub", amountCents: 9900, stripeInvoiceId: "in_1" },
        { id: "pi_funnel", amountCents: 31300, bookingRequestId: "b1" },
      ],
      refunds: [{ paymentIntentId: "pi_1", amountCents: 5000 }],
      invoices: [
        {
          id: "inv1",
          status: "PAID",
          amountCents: 20000,
          refundedAmountCents: 5000,
          stripePaymentIntentId: "pi_1",
          issuedAt: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "inv2",
          status: "PAID",
          amountCents: 9900,
          stripeInvoiceId: "in_1",
          issuedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      windowStartIso: WINDOW,
    });

    expect(mismatches).toEqual([]);
    expect(summary).toMatchObject({
      providerPaidCents: 61200,
      providerRefundCents: 5000,
      netCashCents: 56200,
      crmPaidCents: 29900,
      mismatches: 0,
    });
  });

  it("provider money with no CRM invoice is a Finance mismatch — funnel money is not double-flagged", () => {
    const { mismatches } = computeMoneyMismatches({
      payments: [
        { id: "pi_orphan", amountCents: 15000 },
        { id: "pi_funnel", amountCents: 31300, bookingRequestId: "b1" },
      ],
      refunds: [],
      invoices: [],
      windowStartIso: WINDOW,
    });

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      key: "money-unmatched-payment:pi_orphan",
      team: "FINANCE",
    });
  });

  it("a CRM PAID invoice with no provider payment is flagged — but old rows and offline methods are not", () => {
    const { mismatches } = computeMoneyMismatches({
      payments: [],
      refunds: [],
      invoices: [
        {
          id: "inv-ghost",
          status: "PAID",
          amountCents: 10000,
          stripePaymentIntentId: "pi_missing",
          issuedAt: "2026-07-10T00:00:00.000Z",
        },
        {
          id: "inv-old",
          status: "PAID",
          amountCents: 10000,
          stripePaymentIntentId: "pi_ancient",
          issuedAt: "2026-01-01T00:00:00.000Z", // before the window — not judged
        },
        {
          id: "inv-offline",
          status: "PAID",
          amountCents: 5000,
          issuedAt: "2026-07-10T00:00:00.000Z", // cash/cheque — no PI, legitimate
        },
      ],
      windowStartIso: WINDOW,
    });

    expect(mismatches.map((m) => m.key)).toEqual([
      "money-unbacked-invoice:inv-ghost",
    ]);
  });

  it("an under-recorded refund is flagged with both amounts", () => {
    const { mismatches } = computeMoneyMismatches({
      payments: [{ id: "pi_1", amountCents: 20000 }],
      refunds: [{ paymentIntentId: "pi_1", amountCents: 20000 }],
      invoices: [
        {
          id: "inv1",
          status: "PAID",
          amountCents: 20000,
          refundedAmountCents: 5000,
          stripePaymentIntentId: "pi_1",
          issuedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      windowStartIso: WINDOW,
    });

    expect(mismatches.some((m) => m.key === "money-unrecorded-refund:pi_1")).toBe(
      true
    );
    const refund = mismatches.find((m) => m.key === "money-unrecorded-refund:pi_1")!;
    expect(refund.detail).toContain("$200.00");
    expect(refund.detail).toContain("$50.00");
  });

  it("a fully REFUNDED invoice counts its amount as recorded", () => {
    const { mismatches } = computeMoneyMismatches({
      payments: [{ id: "pi_1", amountCents: 20000 }],
      refunds: [{ paymentIntentId: "pi_1", amountCents: 20000 }],
      invoices: [
        {
          id: "inv1",
          status: "REFUNDED",
          amountCents: 20000,
          stripePaymentIntentId: "pi_1",
          issuedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      windowStartIso: WINDOW,
    });

    expect(mismatches).toEqual([]);
  });
});

describe("plans — provider subscriptions vs CRM plans", () => {
  it("canceled-still-billing, provider-canceled, and provider-only are each owned", () => {
    const { mismatches, summary } = computePlanMismatches({
      subscriptions: [
        { id: "sub_live", status: "active" },
        { id: "sub_dead", status: "canceled" },
        { id: "sub_orphan", status: "active" },
      ],
      plans: [
        {
          id: "p1",
          status: "CANCELED",
          stripeSubscriptionId: "sub_live",
          planName: "GPC plan",
        },
        { id: "p2", status: "ACTIVE", stripeSubscriptionId: "sub_dead" },
        { id: "p3", status: "ACTIVE" }, // not billing yet — the Dashboard owns that view
      ],
      jobs: [],
      todayIso: "2026-07-19",
    });

    expect(mismatches.map((m) => m.key).sort()).toEqual([
      "plan-canceled-still-billing:p1",
      "plan-provider-canceled:p2",
      "plan-provider-only:sub_orphan",
    ]);
    expect(summary).toMatchObject({
      canceledStillBilling: 1,
      activeProviderCanceled: 1,
      providerOnlySubscriptions: 1,
      mismatches: 3,
    });
  });

  it("a suspended (delinquent) plan's future scheduled visit is flagged; past visits are not", () => {
    const { mismatches } = computePlanMismatches({
      subscriptions: [],
      plans: [{ id: "p1", status: "PAUSED" }],
      jobs: [
        { id: "j-future", servicePlanId: "p1", status: "SCHEDULED", scheduledDate: "2026-07-25" },
        { id: "j-past", servicePlanId: "p1", status: "SCHEDULED", scheduledDate: "2026-07-01" },
        { id: "j-other", servicePlanId: "p2", status: "SCHEDULED", scheduledDate: "2026-07-25" },
      ],
      todayIso: "2026-07-19",
    });

    expect(mismatches.map((m) => m.key)).toEqual([
      "plan-delinquent-scheduled:j-future",
    ]);
  });
});

describe("state — lifecycle, visits, and money agree", () => {
  it("a deactivated customer with live work or an active plan is flagged ONCE", () => {
    const { mismatches, summary } = computeStateMismatches({
      customers: [
        { id: "c1", status: "INACTIVE", displayName: "Dana" },
        { id: "c2", status: "ACTIVE" },
      ],
      jobs: [
        { id: "j1", customerId: "c1", status: "SCHEDULED", scheduledDate: "2026-07-25" },
        { id: "j2", customerId: "c1", status: "UNSCHEDULED" },
        { id: "j3", customerId: "c2", status: "SCHEDULED", scheduledDate: "2026-07-25" },
      ],
      plans: [{ id: "p1", status: "ACTIVE", customerId: "c1" }],
      invoices: [],
      todayIso: "2026-07-19",
    });

    // One item per customer, however many rows disagree.
    expect(mismatches.map((m) => m.key)).toEqual([
      "state-inactive-with-work:c1",
    ]);
    expect(summary.inactiveWithWork).toBe(1);
  });

  it("a canceled visit's OPEN invoice is money limbo — but PAID (nonrefundable) and in-flight debits are not flagged", () => {
    const { mismatches } = computeStateMismatches({
      customers: [],
      jobs: [
        { id: "j1", status: "CANCELED" },
        { id: "j2", status: "CANCELED" },
        { id: "j3", status: "CANCELED" },
      ],
      plans: [],
      invoices: [
        { id: "inv-open", jobId: "j1", status: "OPEN", amountCents: 29900 },
        // Nonrefundable ≤72h cancel legitimately keeps PAID money.
        { id: "inv-paid", jobId: "j2", status: "PAID", amountCents: 29900 },
        // A pending debit on a canceled booking is GL-06's, not a state item.
        {
          id: "inv-debit",
          jobId: "j3",
          status: "OPEN",
          amountCents: 29900,
          pendingDebitIntentId: "pi_1",
        },
      ],
      todayIso: "2026-07-19",
    });

    expect(mismatches.map((m) => m.key)).toEqual([
      "state-canceled-open-money:inv-open",
    ]);
  });

  it("a completed past visit on an inactive customer is history, not a mismatch", () => {
    const { mismatches } = computeStateMismatches({
      customers: [{ id: "c1", status: "INACTIVE" }],
      jobs: [
        { id: "j1", customerId: "c1", status: "COMPLETED", scheduledDate: "2026-06-01" },
        { id: "j2", customerId: "c1", status: "SCHEDULED", scheduledDate: "2026-06-01" },
      ],
      plans: [],
      invoices: [],
      todayIso: "2026-07-19",
    });

    expect(mismatches).toEqual([]);
  });
});
