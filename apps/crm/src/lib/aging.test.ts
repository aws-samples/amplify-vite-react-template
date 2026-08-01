import { describe, expect, it } from "vitest";
import {
  agingBucket,
  agingBucketForDays,
  agingSummary,
  daysBetween,
  daysPastDue,
  dueBasis,
  type AgingInvoice,
} from "./aging";

/**
 * The aging boundaries are a contract with the backend's shared/recovery.ts:
 * the Dashboard's aging card and any server-side aging report have to agree to
 * the dollar, so the exact day each bucket starts is pinned here.
 */

const TODAY = "2026-07-17";

describe("daysBetween", () => {
  it("counts whole days forward", () => {
    expect(daysBetween("2026-07-01", "2026-07-17")).toBe(16);
  });

  it("is negative when the second date is earlier", () => {
    expect(daysBetween("2026-07-17", "2026-07-01")).toBe(-16);
  });

  it("does not drop or add a day across a spring-forward DST change", () => {
    // US DST began 2026-03-08. A naive local-time diff can return 89 or 91.
    expect(daysBetween("2026-01-01", "2026-04-01")).toBe(90);
  });
});

describe("dueBasis", () => {
  it("prefers the due date", () => {
    expect(
      dueBasis({ amountCents: 100, dueDate: "2026-07-30", issuedAt: "2026-07-01T12:00:00Z" })
    ).toBe("2026-07-30");
  });

  it("falls back to the issue date when there is no due date", () => {
    expect(dueBasis({ amountCents: 100, issuedAt: "2026-07-01T12:00:00Z" })).toBe(
      "2026-07-01"
    );
  });

  it("is null when nothing dates it", () => {
    expect(dueBasis({ amountCents: 100 })).toBeNull();
  });
});

describe("agingBucketForDays — boundary days", () => {
  it("is current at and before the due date", () => {
    expect(agingBucketForDays(-5)).toBe("CURRENT");
    expect(agingBucketForDays(0)).toBe("CURRENT");
  });

  it("opens 1-30 on the first day past due and holds it through day 30", () => {
    expect(agingBucketForDays(1)).toBe("D1_30");
    expect(agingBucketForDays(30)).toBe("D1_30");
  });

  it("opens 31-60 on day 31 and holds it through day 60", () => {
    expect(agingBucketForDays(31)).toBe("D31_60");
    expect(agingBucketForDays(60)).toBe("D31_60");
  });

  it("opens 61-90 on day 61 and holds it through day 90", () => {
    expect(agingBucketForDays(61)).toBe("D61_90");
    expect(agingBucketForDays(90)).toBe("D61_90");
  });

  it("opens 90+ only past day 90", () => {
    expect(agingBucketForDays(91)).toBe("D90_PLUS");
    expect(agingBucketForDays(365)).toBe("D90_PLUS");
  });
});

describe("daysPastDue / agingBucket", () => {
  it("ages from the due date", () => {
    const inv: AgingInvoice = { amountCents: 100, status: "OPEN", dueDate: "2026-06-17" };
    expect(daysPastDue(inv, TODAY)).toBe(30);
    expect(agingBucket(inv, TODAY)).toBe("D1_30");
  });

  it("ages from the issue date when there is no due date", () => {
    const inv: AgingInvoice = {
      amountCents: 100,
      status: "OPEN",
      issuedAt: "2026-05-17T09:00:00Z",
    };
    expect(daysPastDue(inv, TODAY)).toBe(61);
    expect(agingBucket(inv, TODAY)).toBe("D61_90");
  });

  it("treats a future due date as current", () => {
    const inv: AgingInvoice = { amountCents: 100, status: "OPEN", dueDate: "2026-08-01" };
    expect(daysPastDue(inv, TODAY)).toBeLessThan(0);
    expect(agingBucket(inv, TODAY)).toBe("CURRENT");
  });
});

describe("agingSummary", () => {
  const invoices: AgingInvoice[] = [
    { amountCents: 10000, status: "OPEN", dueDate: "2026-08-01" }, // current
    { amountCents: 20000, status: "OPEN", dueDate: "2026-07-01" }, // 16d -> 1-30
    { amountCents: 30000, status: "FAILED", dueDate: "2026-06-01" }, // 46d -> 31-60
    { amountCents: 40000, status: "OPEN", dueDate: "2026-03-01" }, // >90 -> 90+
    { amountCents: 99999, status: "PAID", dueDate: "2026-06-01" }, // not receivable
    { amountCents: 88888, status: "VOID", dueDate: "2026-06-01" }, // not receivable
  ];

  it("totals only OPEN and FAILED money", () => {
    const s = agingSummary(invoices, TODAY);
    expect(s.totalCents).toBe(10000 + 20000 + 30000 + 40000);
    expect(s.count).toBe(4);
  });

  it("drops each receivable into the right bucket", () => {
    const s = agingSummary(invoices, TODAY);
    expect(s.buckets.CURRENT).toEqual({ totalCents: 10000, count: 1 });
    expect(s.buckets.D1_30).toEqual({ totalCents: 20000, count: 1 });
    expect(s.buckets.D31_60).toEqual({ totalCents: 30000, count: 1 });
    expect(s.buckets.D61_90).toEqual({ totalCents: 0, count: 0 });
    expect(s.buckets.D90_PLUS).toEqual({ totalCents: 40000, count: 1 });
  });

  it("is all zeros for an empty ledger", () => {
    const s = agingSummary([], TODAY);
    expect(s.totalCents).toBe(0);
    expect(s.count).toBe(0);
    expect(s.buckets.CURRENT).toEqual({ totalCents: 0, count: 0 });
  });
});
