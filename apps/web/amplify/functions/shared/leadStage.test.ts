import { describe, expect, it } from "vitest";
import {
  deriveLeadStage,
  isLeadActionOverdue,
  isLeadOpen,
  leadNextActionAt,
} from "./leadStage";

describe("GL-02 controlled stages", () => {
  it("never labels attempts or provider acceptance as reached", () => {
    expect(deriveLeadStage({ lastAttemptedAt: "2026-07-14T14:00:00Z" })).toBe("ATTEMPTED");
    expect(
      deriveLeadStage({
        lastAttemptedAt: "2026-07-14T14:00:00Z",
        // Provider acceptance is retained elsewhere; only delivery advances.
        bookingLinkDeliveredAt: null,
      })
    ).toBe("ATTEMPTED");
    expect(deriveLeadStage({ lastReachedAt: "2026-07-14T14:00:00Z" })).toBe("REACHED");
  });

  it("distinguishes qualification, booking delivery, and identity review", () => {
    expect(deriveLeadStage({ qualificationStatus: "QUALIFIED" })).toBe("QUALIFIED");
    expect(deriveLeadStage({ qualificationStatus: "UNQUALIFIED" })).toBe("UNQUALIFIED");
    expect(deriveLeadStage({ bookingLinkDeliveredAt: "2026-07-14T15:00:00Z" })).toBe("BOOKING_SENT");
    expect(deriveLeadStage({ conversionReviewBookingId: "booking-1" })).toBe("IDENTITY_REVIEW");
  });

  it("terminal states are unambiguous", () => {
    expect(deriveLeadStage({ lostReason: "NO_RESPONSE" })).toBe("LOST");
    expect(deriveLeadStage({ doNotContact: true, lostReason: "PRICE" })).toBe("DNC");
    expect(deriveLeadStage({ status: "ACTIVE", doNotContact: true })).toBe("WON");
  });
});

describe("durable next obligation", () => {
  const now = new Date("2026-07-14T16:00:00Z");
  it("uses the persisted deadline and treats a missing legacy deadline as due now", () => {
    expect(leadNextActionAt({ nextActionAt: "2026-07-15T16:00:00Z" }, now)?.toISOString())
      .toBe("2026-07-15T16:00:00.000Z");
    expect(isLeadActionOverdue({}, now)).toBe(true);
  });
  it("does not chase terminal leads", () => {
    expect(isLeadOpen({})).toBe(true);
    expect(isLeadOpen({ lostReason: "PRICE" })).toBe(false);
    expect(isLeadActionOverdue({ status: "ACTIVE" }, now)).toBe(false);
  });
});
