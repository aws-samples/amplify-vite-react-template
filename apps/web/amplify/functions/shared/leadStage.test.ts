import { describe, expect, it } from "vitest";
import {
  deriveLeadStage,
  isLeadActionOverdue,
  isLeadOpen,
  leadNextActionAt,
} from "./leadStage";

describe("deriveLeadStage (GL-02 — stage is inferred, never stored)", () => {
  it("NEW when nothing has happened yet", () => {
    expect(deriveLeadStage({})).toBe("NEW");
  });
  it("CONTACTED once a touch is logged", () => {
    expect(deriveLeadStage({ lastTouchedAt: "2026-07-14T14:00:00Z" })).toBe("CONTACTED");
  });
  it("BOOKING_SENT once a booking link went out (wins over a prior touch)", () => {
    expect(
      deriveLeadStage({
        lastTouchedAt: "2026-07-14T14:00:00Z",
        bookingLinkSentAt: "2026-07-14T15:00:00Z",
      })
    ).toBe("BOOKING_SENT");
  });
  it("LOST when a lost reason is set", () => {
    expect(deriveLeadStage({ lostReason: "NO_RESPONSE" })).toBe("LOST");
  });
  it("DNC wins over everything except a conversion", () => {
    expect(
      deriveLeadStage({ doNotContact: true, lostReason: "PRICE", bookingLinkSentAt: "x" })
    ).toBe("DNC");
  });
  it("WON when the customer converted (status ACTIVE)", () => {
    expect(deriveLeadStage({ status: "ACTIVE" })).toBe("WON");
    expect(deriveLeadStage({ convertedAt: "2026-07-14T14:00:00Z" })).toBe("WON");
  });
});

describe("lead follow-up SLA", () => {
  const TUE_NOON = new Date("2026-07-14T16:00:00Z"); // 12:00 ET, business hours

  it("only open leads are chased", () => {
    expect(isLeadOpen({})).toBe(true);
    expect(isLeadOpen({ lostReason: "PRICE" })).toBe(false);
    expect(isLeadOpen({ doNotContact: true })).toBe(false);
    expect(isLeadOpen({ status: "ACTIVE" })).toBe(false);
    expect(isLeadActionOverdue({ lostReason: "PRICE" }, TUE_NOON)).toBe(false);
  });

  it("a NEW lead is overdue once the first-touch hour lapses", () => {
    // Arrived 10:00 ET; by noon the 1-business-hour window is long gone.
    const arrivedAt10 = { createdAt: "2026-07-14T14:00:00Z" };
    expect(isLeadActionOverdue(arrivedAt10, TUE_NOON)).toBe(true);
    // A lead that just arrived is not overdue yet.
    const justNow = { createdAt: "2026-07-14T15:45:00Z" };
    expect(isLeadActionOverdue(justNow, TUE_NOON)).toBe(false);
  });

  it("a CONTACTED lead is overdue after the business-day cadence lapses", () => {
    const touchedLastWeek = { lastTouchedAt: "2026-07-07T14:00:00Z" };
    expect(isLeadActionOverdue(touchedLastWeek, TUE_NOON)).toBe(true);
    // Touched yesterday → still inside the 2-business-day window.
    const touchedYesterday = { lastTouchedAt: "2026-07-13T14:00:00Z" };
    expect(isLeadActionOverdue(touchedYesterday, TUE_NOON)).toBe(false);
  });

  it("an explicit nextActionAt overrides the derived due time", () => {
    const future = leadNextActionAt(
      { lastTouchedAt: "2026-07-01T14:00:00Z", nextActionAt: "2026-08-01T14:00:00Z" },
      TUE_NOON
    );
    expect(future?.toISOString()).toBe("2026-08-01T14:00:00.000Z");
  });
});
