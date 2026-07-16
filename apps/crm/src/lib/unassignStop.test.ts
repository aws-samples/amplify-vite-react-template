import { describe, expect, it } from "vitest";
import { assignBlockedNote, unassignBlockedNote } from "./unassignStop";

/**
 * The board schedules; it never rewrites history. Unassigning a COMPLETED
 * stop would flip the status that billing, the recurring engine, and the
 * pesticide record key off; unassigning an IN_PROGRESS stop would pull a job
 * out from under a tech standing on site. Both get honest words instead of
 * a working ✕.
 */

describe("unassignBlockedNote", () => {
  it("never lets a completed stop be unassigned", () => {
    expect(unassignBlockedNote("COMPLETED", "Ray")).toBe(
      "completed — stays on the record"
    );
  });

  it("tells the office to call the tech on site, by name", () => {
    expect(unassignBlockedNote("IN_PROGRESS", "Ray")).toBe(
      "on site — call Ray to pull this stop"
    );
  });

  it.each(["SCHEDULED", "UNSCHEDULED"])(
    "leaves a plain %s move working as today",
    (status) => {
      expect(unassignBlockedNote(status, "Ray")).toBeNull();
    }
  );

  it("does not block on a missing status", () => {
    expect(unassignBlockedNote(null, "Ray")).toBeNull();
    expect(unassignBlockedNote(undefined, "Ray")).toBeNull();
  });
});

describe("assignBlockedNote", () => {
  it("never lets Assign rewrite a completed job back to SCHEDULED", () => {
    expect(assignBlockedNote("COMPLETED")).toBe(
      "completed — stays on the record"
    );
  });

  it("blocks assigning a stop a tech is already working", () => {
    expect(assignBlockedNote("IN_PROGRESS")).toBe(
      "on site — already being worked"
    );
  });

  it("leaves NO_ACCESS assignable — re-booking is legitimate office work", () => {
    expect(assignBlockedNote("NO_ACCESS")).toBeNull();
  });

  it.each(["SCHEDULED", "UNSCHEDULED"])(
    "leaves a plain %s assign working as today",
    (status) => {
      expect(assignBlockedNote(status)).toBeNull();
    }
  );
});
