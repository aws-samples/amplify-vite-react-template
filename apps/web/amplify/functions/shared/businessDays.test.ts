import { beforeEach, describe, expect, it, vi } from "vitest";

const closures = new Set<string>();
let calendarReadFails = false;
vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      CompanyClosure: {
        get: async ({ id }: { id: string }) => ({
          data: closures.has(id) ? { id } : null,
          errors: calendarReadFails ? [{ message: "calendar unavailable" }] : [],
        }),
      },
    },
  }),
}));

const { oneBusinessDayDeadline, oneBusinessDayDueAt } = await import(
  "./businessDays"
);

beforeEach(() => {
  closures.clear();
  calendarReadFails = false;
});

describe("shared America/New_York one-business-day deadline", () => {
  it("keeps the Eastern wall time across a weekend", async () => {
    // Friday July 17 2026 at 3pm ET -> Monday July 20 at 3pm ET.
    await expect(oneBusinessDayDueAt(new Date("2026-07-17T19:00:00Z")))
      .resolves.toEqual(new Date("2026-07-20T19:00:00Z"));
  });

  it("skips a tracked company closure", async () => {
    closures.add("2026-07-20");
    await expect(oneBusinessDayDueAt(new Date("2026-07-17T19:00:00Z")))
      .resolves.toEqual(new Date("2026-07-21T19:00:00Z"));
  });

  it("starts an after-hours request at the next opening", async () => {
    // Saturday July 18 -> Monday 8am ET start -> Tuesday 8am ET deadline.
    await expect(oneBusinessDayDeadline(new Date("2026-07-18T14:00:00Z")))
      .resolves.toEqual(new Date("2026-07-21T12:00:00Z"));
  });

  it("uses one shared deadline contract for GL-02 and GL-03", async () => {
    const from = new Date("2026-07-17T19:00:00Z");
    await expect(oneBusinessDayDueAt(from)).resolves.toEqual(
      await oneBusinessDayDeadline(from)
    );
  });

  it("fails closed instead of inventing an earlier deadline when the calendar is unreadable", async () => {
    calendarReadFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      oneBusinessDayDueAt(new Date("2026-07-17T19:00:00Z"))
    ).rejects.toThrow(/could not produce a safe deadline/i);
  });
});
