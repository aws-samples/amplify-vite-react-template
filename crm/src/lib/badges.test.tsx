import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STAGE_BADGE,
  Badge,
  CARRIER_APPOINTMENT_BADGE,
  CONFIDENCE_BADGE,
  LICENSE_EXPIRY_SCALE,
  MARKETING_RESOLUTION_BADGE,
  MARKETING_SUBMIT_SCALE,
  OCR_STATUS_BADGE,
  POLICY_STATUS_BADGE,
  QUOTE_STATUS_BADGE,
  RENEWAL_HORIZON_SCALE,
  flagBadge,
  statusBadge,
  urgencyBadge,
  type BadgeMap,
  type UrgencyScale,
} from "./badges";

describe("statusBadge", () => {
  describe("known values", () => {
    it("maps every quote status to its colour, keeping the token as the label", () => {
      const seen = Object.keys(QUOTE_STATUS_BADGE).map((s) => [
        s,
        statusBadge(QUOTE_STATUS_BADGE, s),
      ]);
      expect(Object.fromEntries(seen)).toEqual({
        DRAFT: { cls: "gray", label: "DRAFT" },
        SUBMITTED: { cls: "blue", label: "SUBMITTED" },
        QUOTED: { cls: "amber", label: "QUOTED" },
        PRESENTED: { cls: "amber", label: "PRESENTED" },
        BOUND: { cls: "green", label: "BOUND" },
        DECLINED: { cls: "red", label: "DECLINED" },
        LOST: { cls: "red", label: "LOST" },
      });
    });

    it("greens only ACTIVE policies and greys the three dead ends", () => {
      expect(statusBadge(POLICY_STATUS_BADGE, "ACTIVE").cls).toBe("green");
      for (const s of ["EXPIRED", "CANCELLED", "NON_RENEWED"]) {
        expect(statusBadge(POLICY_STATUS_BADGE, s).cls).toBe("gray");
      }
    });

    it("relabels OCR statuses rather than showing the raw token", () => {
      expect(statusBadge(OCR_STATUS_BADGE, "PROCESSING")).toEqual({
        cls: "amber",
        label: "OCR running",
      });
      expect(statusBadge(OCR_STATUS_BADGE, "COMPLETE")).toEqual({
        cls: "green",
        label: "OCR done",
      });
      expect(statusBadge(OCR_STATUS_BADGE, "FAILED")).toEqual({
        cls: "red",
        label: "OCR failed",
      });
      expect(statusBadge(OCR_STATUS_BADGE, "SKIPPED")).toEqual({
        cls: "gray",
        label: "No OCR",
      });
    });

    it("maps the model's lower-case confidence values", () => {
      expect(statusBadge(CONFIDENCE_BADGE, "high").cls).toBe("green");
      expect(statusBadge(CONFIDENCE_BADGE, "medium").cls).toBe("amber");
      expect(statusBadge(CONFIDENCE_BADGE, "low").cls).toBe("red");
    });

    it("is case-sensitive — an upper-case confidence is not a hit", () => {
      expect(statusBadge(CONFIDENCE_BADGE, "HIGH")).toEqual({
        cls: "gray",
        label: "HIGH",
      });
    });

    it("gives lead and client one spelling each", () => {
      expect(statusBadge(ACCOUNT_STAGE_BADGE, "LEAD")).toEqual({
        cls: "blue",
        label: "Lead",
      });
      expect(statusBadge(ACCOUNT_STAGE_BADGE, "CLIENT")).toEqual({
        cls: "green",
        label: "Client",
      });
    });

    it("maps marketing-task resolutions", () => {
      expect(statusBadge(MARKETING_RESOLUTION_BADGE, "QUOTED")).toEqual({
        cls: "green",
        label: "Quoted",
      });
      expect(statusBadge(MARKETING_RESOLUTION_BADGE, "OUT_OF_APPETITE")).toEqual({
        cls: "gray",
        label: "Out of appetite",
      });
    });
  });

  describe("fallback", () => {
    it("shows an unmapped value in grey rather than blank", () => {
      expect(statusBadge(QUOTE_STATUS_BADGE, "REFERRED")).toEqual({
        cls: "gray",
        label: "REFERRED",
      });
    });

    it("shows an em dash for null, undefined and empty string", () => {
      const dash = { cls: "gray", label: "—" };
      expect(statusBadge(QUOTE_STATUS_BADGE, null)).toEqual(dash);
      expect(statusBadge(QUOTE_STATUS_BADGE, undefined)).toEqual(dash);
      expect(statusBadge(QUOTE_STATUS_BADGE, "")).toEqual(dash);
    });

    it("prefers an explicit fallback for both unmapped and absent values", () => {
      const pending = OCR_STATUS_BADGE.PENDING;
      expect(statusBadge(OCR_STATUS_BADGE, "QUEUED_V2", pending)).toBe(pending);
      expect(statusBadge(OCR_STATUS_BADGE, null, pending)).toBe(pending);
      expect(statusBadge(OCR_STATUS_BADGE, undefined, pending)).toBe(pending);
    });

    it("does not use the fallback when the value maps", () => {
      expect(statusBadge(OCR_STATUS_BADGE, "FAILED", OCR_STATUS_BADGE.PENDING).cls).toBe(
        "red"
      );
    });

    it("does not treat inherited Object properties as hits", () => {
      const map: BadgeMap = { OK: { cls: "green", label: "OK" } };
      expect(statusBadge(map, "toString")).toEqual({
        cls: "gray",
        label: "toString",
      });
      expect(statusBadge(map, "constructor")).toEqual({
        cls: "gray",
        label: "constructor",
      });
    });
  });
});

describe("flagBadge", () => {
  it("picks the on side for true and the off side for false", () => {
    expect(flagBadge(true, CARRIER_APPOINTMENT_BADGE)).toEqual({
      cls: "green",
      label: "Appointed",
    });
    expect(flagBadge(false, CARRIER_APPOINTMENT_BADGE)).toEqual({
      cls: "amber",
      label: "Prospective",
    });
  });

  it("treats an unset flag as off", () => {
    expect(flagBadge(null, CARRIER_APPOINTMENT_BADGE).label).toBe("Prospective");
    expect(flagBadge(undefined, CARRIER_APPOINTMENT_BADGE).label).toBe("Prospective");
  });
});

describe("urgencyBadge", () => {
  describe("licence expiry (30/60)", () => {
    const at = (days: number | null | undefined) =>
      urgencyBadge(days, LICENSE_EXPIRY_SCALE);

    it("is red at and inside the 30-day cutoff, amber just past it", () => {
      expect(at(29)).toEqual({ cls: "red", label: "29d left", level: "urgent" });
      expect(at(30)).toEqual({ cls: "red", label: "30d left", level: "urgent" });
      expect(at(31)).toEqual({ cls: "amber", label: "31d left", level: "soon" });
    });

    it("is amber at and inside the 60-day cutoff, green just past it", () => {
      expect(at(59)).toEqual({ cls: "amber", label: "59d left", level: "soon" });
      expect(at(60)).toEqual({ cls: "amber", label: "60d left", level: "soon" });
      expect(at(61)).toEqual({ cls: "green", label: "61d left", level: "calm" });
    });

    it("counts today as urgent, not as expired", () => {
      expect(at(0)).toEqual({ cls: "red", label: "0d left", level: "urgent" });
    });

    it("reports an expired licence in days past", () => {
      expect(at(-1)).toEqual({ cls: "red", label: "Expired 1d ago", level: "overdue" });
      expect(at(-400)).toEqual({
        cls: "red",
        label: "Expired 400d ago",
        level: "overdue",
      });
    });

    it("says so when there is no expiration on file", () => {
      const none = {
        cls: "gray",
        label: "No expiration on file",
        level: "unknown",
      };
      expect(at(null)).toEqual(none);
      expect(at(undefined)).toEqual(none);
    });
  });

  describe("marketing submit-by (7/21)", () => {
    const at = (days: number | null | undefined) =>
      urgencyBadge(days, MARKETING_SUBMIT_SCALE);

    it("is red at and inside the 7-day cutoff, amber just past it", () => {
      expect(at(6)).toEqual({ cls: "red", label: "submit in 6d", level: "urgent" });
      expect(at(7)).toEqual({ cls: "red", label: "submit in 7d", level: "urgent" });
      expect(at(8)).toEqual({ cls: "amber", label: "submit in 8d", level: "soon" });
    });

    it("is amber at and inside the 21-day cutoff, green just past it", () => {
      expect(at(20)).toEqual({ cls: "amber", label: "submit in 20d", level: "soon" });
      expect(at(21)).toEqual({ cls: "amber", label: "submit in 21d", level: "soon" });
      expect(at(22)).toEqual({ cls: "green", label: "submit in 22d", level: "calm" });
    });

    it("counts today as urgent, not as past submit-by", () => {
      expect(at(0)).toEqual({ cls: "red", label: "submit in 0d", level: "urgent" });
    });

    it("reports a blown submit-by in days past", () => {
      expect(at(-3)).toEqual({
        cls: "red",
        label: "3d past submit-by",
        level: "overdue",
      });
    });

    it("dashes a task with no submit-by", () => {
      const none = { cls: "gray", label: "—", level: "unknown" };
      expect(at(null)).toEqual(none);
      expect(at(undefined)).toEqual(none);
    });

    it("keeps its own cutoffs — 45 days is calm here and amber for a licence", () => {
      expect(at(45).cls).toBe("green");
      expect(urgencyBadge(45, LICENSE_EXPIRY_SCALE).cls).toBe("amber");
    });

    it("keeps its own cutoffs — 15 days is amber here and red for a licence", () => {
      expect(at(15).cls).toBe("amber");
      expect(urgencyBadge(15, LICENSE_EXPIRY_SCALE).cls).toBe("red");
    });
  });

  describe("renewal horizon (30, no red-ahead rung)", () => {
    const at = (days: number | null | undefined) =>
      urgencyBadge(days, RENEWAL_HORIZON_SCALE);

    it("never goes red for a future date, however close", () => {
      expect(at(0)).toEqual({ cls: "amber", label: "0d", level: "soon" });
      expect(at(1)).toEqual({ cls: "amber", label: "1d", level: "soon" });
    });

    it("is amber at and inside 30 days, grey past it", () => {
      expect(at(29)).toEqual({ cls: "amber", label: "29d", level: "soon" });
      expect(at(30)).toEqual({ cls: "amber", label: "30d", level: "soon" });
      expect(at(31)).toEqual({ cls: "gray", label: "31d", level: "calm" });
      expect(at(90)).toEqual({ cls: "gray", label: "90d", level: "calm" });
    });

    it("still goes red once the renewal is behind us", () => {
      expect(at(-5)).toEqual({ cls: "red", label: "5d overdue", level: "overdue" });
    });

    it("dashes a row with no date", () => {
      expect(at(null)).toEqual({ cls: "gray", label: "—", level: "unknown" });
    });
  });

  describe("scale shape", () => {
    it("lets urgent and soon coincide, collapsing the amber rung", () => {
      const scale: UrgencyScale = {
        urgent: 10,
        soon: 10,
        calm: "green",
        unknown: { cls: "gray", label: "?" },
        label: (d) => `${d}`,
        overdue: (d) => `-${d}`,
      };
      expect(urgencyBadge(10, scale).level).toBe("urgent");
      expect(urgencyBadge(11, scale).level).toBe("calm");
    });

    it("treats urgent: 0 as a real cutoff, not as absent", () => {
      const scale: UrgencyScale = {
        urgent: 0,
        soon: 5,
        calm: "green",
        unknown: { cls: "gray", label: "?" },
        label: (d) => `${d}`,
        overdue: (d) => `-${d}`,
      };
      expect(urgencyBadge(0, scale)).toEqual({ cls: "red", label: "0", level: "urgent" });
      expect(urgencyBadge(1, scale)).toEqual({ cls: "amber", label: "1", level: "soon" });
    });
  });
});

describe("<Badge>", () => {
  it("hangs the modifier off the base badge class", () => {
    render(<Badge {...statusBadge(QUOTE_STATUS_BADGE, "BOUND")} />);
    const el = screen.getByText("BOUND");
    expect(el.className).toBe("badge green");
  });

  it("renders a spread urgency spec without leaking the level into the DOM", () => {
    render(<Badge {...urgencyBadge(-2, LICENSE_EXPIRY_SCALE)} />);
    const el = screen.getByText("Expired 2d ago");
    expect(el.className).toBe("badge red");
    expect(el.getAttribute("level")).toBeNull();
  });

  it("accepts an inline style for one-off chips", () => {
    render(<Badge cls="blue" label="you" style={{ marginLeft: 6 }} />);
    expect(screen.getByText("you").style.marginLeft).toBe("6px");
  });

  it("renders the fallback pill for an unknown status", () => {
    render(<Badge {...statusBadge(QUOTE_STATUS_BADGE, "REFERRED")} />);
    expect(screen.getByText("REFERRED").className).toBe("badge gray");
  });
});
