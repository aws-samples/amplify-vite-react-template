import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-22 — the emergency pause switchboard: honest reads (fail open — an
 * unreadable flag must not down the funnel), audited writes that keep
 * unspecified flags, and an office announcement on every change.
 */

const rows = new Map<string, Record<string, unknown>>();
let getThrows = false;
let updateFails = false;
vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      OpsControl: {
        get: async ({ id }: { id: string }) => {
          if (getThrows) throw new Error("dynamo down");
          return { data: rows.get(id) ?? null };
        },
        create: async (input: Record<string, unknown> & { id: string }) => {
          rows.set(input.id, { ...input });
          return { data: rows.get(input.id) };
        },
        update: async (patch: Record<string, unknown> & { id: string }) => {
          if (updateFails) return { data: null, errors: [{ message: "refused" }] };
          const row = rows.get(patch.id);
          if (!row) return { data: null, errors: [{ message: "no row" }] };
          Object.assign(row, patch);
          return { data: { ...row } };
        },
      },
    },
  }),
}));
const officeEmails: { subject: string }[] = [];
vi.mock("./email", () => ({
  notifyOffice: async (o: { subject: string }) => {
    officeEmails.push(o);
    return true;
  },
}));

const { readOpsPause, writeOpsPause, _resetOpsPauseMemoForTests } =
  await import("./opsPause");

beforeEach(() => {
  rows.clear();
  getThrows = false;
  updateFails = false;
  officeEmails.length = 0;
  _resetOpsPauseMemoForTests();
});

describe("opsPause", () => {
  it("defaults to nothing paused, and fails OPEN on a read fault", async () => {
    expect(await readOpsPause()).toMatchObject({
      bookingPaused: false,
      dispatchPaused: false,
      billingPaused: false,
    });
    getThrows = true;
    _resetOpsPauseMemoForTests();
    expect((await readOpsPause()).bookingPaused).toBe(false);
  });

  it("a write flips only the named switch, records who/why, and announces it", async () => {
    await writeOpsPause({
      bookingPaused: true,
      reason: "double-charge incident",
      actorEmail: "jake@getgim.com",
    });

    const state = await readOpsPause();
    expect(state).toMatchObject({
      bookingPaused: true,
      dispatchPaused: false,
      billingPaused: false,
      reason: "double-charge incident",
    });
    expect(rows.get("pause")).toMatchObject({ actorEmail: "jake@getgim.com" });
    expect(officeEmails[0].subject).toContain("new bookings PAUSED");

    // A later change to another switch keeps the first one's value.
    await writeOpsPause({
      billingPaused: true,
      reason: "still contained",
      actorEmail: "jake@getgim.com",
    });
    expect(await readOpsPause()).toMatchObject({
      bookingPaused: true,
      billingPaused: true,
    });
  });

  it("a write that cannot be recorded THROWS — the operator never believes in a pause that isn't real", async () => {
    await writeOpsPause({ reason: "seed the row", actorEmail: null });
    updateFails = true;

    await expect(
      writeOpsPause({ bookingPaused: true, reason: "x", actorEmail: null })
    ).rejects.toThrow(/could not be recorded/);
  });
});
