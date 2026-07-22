import { describe, expect, it } from "vitest";
import {
  buildRecoveryQueue,
  compareRecoveryItems,
  daysUntilEvidenceDue,
  dunningStateLabel,
  isInDunning,
  isOpenDispute,
  isOverdue,
  type RecoveryDispute,
  type RecoveryInvoice,
} from "./recovery";

const TODAY = "2026-07-17";

const inv = (over: Partial<RecoveryInvoice> = {}): RecoveryInvoice => ({
  id: "i1",
  customerId: "c1",
  amountCents: 10000,
  status: "OPEN",
  ...over,
});

const dispute = (over: Partial<RecoveryDispute> = {}): RecoveryDispute => ({
  id: "d1",
  customerId: "c1",
  amountCents: 25000,
  status: "NEEDS_RESPONSE",
  ...over,
});

describe("isOverdue", () => {
  it("is true only for an OPEN invoice past its due date", () => {
    expect(isOverdue(inv({ dueDate: "2026-07-01" }), TODAY)).toBe(true);
  });

  it("is false for an OPEN invoice not yet due", () => {
    expect(isOverdue(inv({ dueDate: "2026-08-01" }), TODAY)).toBe(false);
  });

  it("is false for a FAILED invoice (that is dunning, not overdue)", () => {
    expect(isOverdue(inv({ status: "FAILED", dueDate: "2026-07-01" }), TODAY)).toBe(
      false
    );
  });

  it("is false for a PAID invoice", () => {
    expect(isOverdue(inv({ status: "PAID", dueDate: "2026-01-01" }), TODAY)).toBe(
      false
    );
  });
});

describe("isInDunning / isOpenDispute", () => {
  it("flags FAILED invoices", () => {
    expect(isInDunning(inv({ status: "FAILED" }))).toBe(true);
    expect(isInDunning(inv({ status: "OPEN" }))).toBe(false);
  });

  it("flags disputes that still need action", () => {
    expect(isOpenDispute(dispute({ status: "NEEDS_RESPONSE" }))).toBe(true);
    expect(isOpenDispute(dispute({ status: "UNDER_REVIEW" }))).toBe(true);
    expect(isOpenDispute(dispute({ status: "WON" }))).toBe(false);
    expect(isOpenDispute(dispute({ status: "LOST" }))).toBe(false);
  });
});

describe("daysUntilEvidenceDue", () => {
  it("counts days to the deadline", () => {
    expect(daysUntilEvidenceDue(dispute({ evidenceDueBy: "2026-07-20T00:00:00Z" }), TODAY)).toBe(3);
  });

  it("is negative once the deadline has passed", () => {
    expect(daysUntilEvidenceDue(dispute({ evidenceDueBy: "2026-07-10T00:00:00Z" }), TODAY)).toBe(-7);
  });

  it("is null with no deadline on the record", () => {
    expect(daysUntilEvidenceDue(dispute({ evidenceDueBy: null }), TODAY)).toBeNull();
  });
});

describe("dunningStateLabel", () => {
  it("names the next scheduled retry", () => {
    expect(
      dunningStateLabel(inv({ status: "FAILED", dunningAttempts: 2, nextDunningAt: "2026-07-20T00:00:00Z" }), TODAY)
    ).toBe("Retry 2 · next in 3d");
  });

  it("says a retry is due now when its time has passed", () => {
    expect(
      dunningStateLabel(inv({ status: "FAILED", dunningAttempts: 1, nextDunningAt: "2026-07-16T00:00:00Z" }), TODAY)
    ).toBe("Retry 1 · next due now");
  });

  it("reads plainly before any retry has run", () => {
    expect(dunningStateLabel(inv({ status: "FAILED" }), TODAY)).toBe("Payment failed");
  });

  it("flags a stalled dunning with attempts but no next retry", () => {
    expect(
      dunningStateLabel(inv({ status: "FAILED", dunningAttempts: 3 }), TODAY)
    ).toBe("3 retries, no next retry");
  });
});

describe("buildRecoveryQueue", () => {
  it("includes overdue OPEN, all FAILED, and open disputes — and nothing else", () => {
    const items = buildRecoveryQueue(
      [
        inv({ id: "overdue", dueDate: "2026-07-01" }),
        inv({ id: "notdue", dueDate: "2026-08-01" }), // excluded
        inv({ id: "failed", status: "FAILED", dueDate: "2026-07-10" }),
        inv({ id: "paid", status: "PAID", dueDate: "2026-01-01" }), // excluded
      ],
      [
        dispute({ id: "open", evidenceDueBy: "2026-07-25T00:00:00Z" }),
        dispute({ id: "won", status: "WON" }), // excluded
      ],
      TODAY
    );
    expect(items.map((i) => i.id).sort()).toEqual(["failed", "open", "overdue"]);
  });

  it("orders disputes above failed above overdue", () => {
    const items = buildRecoveryQueue(
      [
        inv({ id: "overdue", dueDate: "2026-01-01" }), // very overdue
        inv({ id: "failed", status: "FAILED", dueDate: "2026-07-16" }), // fresh fail
      ],
      [dispute({ id: "disp", evidenceDueBy: "2026-08-01T00:00:00Z" })],
      TODAY
    );
    expect(items.map((i) => i.id)).toEqual(["disp", "failed", "overdue"]);
  });

  it("puts the soonest dispute deadline first within disputes", () => {
    const items = buildRecoveryQueue(
      [],
      [
        dispute({ id: "later", evidenceDueBy: "2026-07-30T00:00:00Z" }),
        dispute({ id: "sooner", evidenceDueBy: "2026-07-19T00:00:00Z" }),
        dispute({ id: "past", evidenceDueBy: "2026-07-10T00:00:00Z" }),
      ],
      TODAY
    );
    expect(items.map((i) => i.id)).toEqual(["past", "sooner", "later"]);
  });

  it("puts the most-overdue invoice first within overdue", () => {
    const items = buildRecoveryQueue(
      [
        inv({ id: "recent", dueDate: "2026-07-10" }),
        inv({ id: "old", dueDate: "2026-05-01" }),
      ],
      [],
      TODAY
    );
    expect(items.map((i) => i.id)).toEqual(["old", "recent"]);
  });

  it("carries the SLA label and owner onto each item", () => {
    const [item] = buildRecoveryQueue(
      [inv({ id: "overdue", dueDate: "2026-07-01", ownerSub: "u1", ownerEmail: "ops@x.com" })],
      [],
      TODAY
    );
    expect(item.slaLabel).toBe("16 days overdue");
    expect(item.ownerSub).toBe("u1");
    expect(item.ownerEmail).toBe("ops@x.com");
  });

  it("marks a dispute inside its deadline window urgent and a fresh overdue not", () => {
    const items = buildRecoveryQueue(
      [inv({ id: "overdue", dueDate: "2026-07-15" })],
      [dispute({ id: "disp", evidenceDueBy: "2026-07-18T00:00:00Z" })],
      TODAY
    );
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.disp.urgent).toBe(true);
    expect(byId.overdue.urgent).toBe(false);
  });
});

describe("compareRecoveryItems is a total order", () => {
  it("breaks a metric tie by amount then id", () => {
    const items = buildRecoveryQueue(
      [
        inv({ id: "b", amountCents: 5000, dueDate: "2026-07-07" }),
        inv({ id: "a", amountCents: 5000, dueDate: "2026-07-07" }),
        inv({ id: "big", amountCents: 90000, dueDate: "2026-07-07" }),
      ],
      [],
      TODAY
    );
    // Same days overdue: bigger dollar first, then id ascending.
    expect(items.map((i) => i.id)).toEqual(["big", "a", "b"]);
  });

  it("is antisymmetric on distinct items", () => {
    const a = buildRecoveryQueue([inv({ id: "x", dueDate: "2026-07-01" })], [], TODAY)[0];
    const b = buildRecoveryQueue([inv({ id: "y", status: "FAILED" })], [], TODAY)[0];
    expect(Math.sign(compareRecoveryItems(a, b))).toBe(-Math.sign(compareRecoveryItems(b, a)));
  });
});
