import { describe, expect, it } from "vitest";
import { decideTrackStatus } from "./handler";

/**
 * "On My Way" live tracking only broadcasts while a visit is genuinely en
 * route. decideTrackStatus is the guard the public endpoint runs before it
 * returns any location — these lock down each terminal case so a stale token
 * can never leak a technician's whereabouts.
 */
const NOW = "2026-07-23T18:00:00.000Z";

describe("decideTrackStatus", () => {
  it("EN_ROUTE while scheduled, en route, and within the TTL", () => {
    expect(
      decideTrackStatus(
        {
          enRouteAt: "2026-07-23T17:50:00.000Z",
          status: "SCHEDULED",
          trackEndsAt: "2026-07-23T20:50:00.000Z",
        },
        NOW
      )
    ).toBe("EN_ROUTE");
  });

  it("UNKNOWN when the token matches nothing", () => {
    expect(decideTrackStatus(null, NOW)).toBe("UNKNOWN");
  });

  it("UNKNOWN when the tech never tapped On My Way", () => {
    expect(
      decideTrackStatus({ enRouteAt: null, status: "SCHEDULED" }, NOW)
    ).toBe("UNKNOWN");
  });

  it("ARRIVED once the visit starts (IN_PROGRESS) — stops sharing at the door", () => {
    expect(
      decideTrackStatus(
        { enRouteAt: "2026-07-23T17:50:00.000Z", status: "IN_PROGRESS" },
        NOW
      )
    ).toBe("ARRIVED");
  });

  it("ARRIVED for any terminal status (completed / no-access / canceled)", () => {
    for (const status of ["COMPLETED", "NO_ACCESS", "CANCELED"]) {
      expect(
        decideTrackStatus(
          { enRouteAt: "2026-07-23T17:50:00.000Z", status },
          NOW
        )
      ).toBe("ARRIVED");
    }
  });

  it("ENDED once the safety TTL has passed — a forgotten session cannot broadcast forever", () => {
    expect(
      decideTrackStatus(
        {
          enRouteAt: "2026-07-23T14:00:00.000Z",
          status: "SCHEDULED",
          trackEndsAt: "2026-07-23T17:00:00.000Z",
        },
        NOW
      )
    ).toBe("ENDED");
  });
});
