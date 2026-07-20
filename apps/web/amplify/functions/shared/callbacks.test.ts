import { beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";

/**
 * GL-10 — the guarantee callback lifecycle's locked rules: active residual
 * plan only, completed original visit, required photo, ONE callback per
 * appointment, the 7-business-day promise, $0 by construction, and the
 * controlled evidenced finding that continues or ends the guarantee with
 * one final notice.
 */

type Row = Record<string, unknown> & { id: string };
const customers = new Map<string, Row>();
const jobs = new Map<string, Row>();
const plans = new Map<string, Row>();
const callbacks = new Map<string, Row>();
const closures = new Map<string, Row>();
const jobsCreated: Row[] = [];

const model = (table: Map<string, Row>, created?: Row[]) => ({
  get: async ({ id }: { id: string }) => ({ data: table.get(id) ?? null }),
  create: async (input: Row) => {
    if (table.has(input.id)) return { data: null, errors: [{ message: "exists" }] };
    table.set(input.id, { ...input });
    created?.push(table.get(input.id)!);
    return { data: table.get(input.id) };
  },
  update: async (patch: Row) => {
    const row = table.get(patch.id);
    if (!row) return { data: null, errors: [{ message: "no row" }] };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) row[k] = v;
    return { data: { ...row } };
  },
});

let cbCreateFails = false;
const callbackModel = () => {
  const base = model(callbacks);
  return {
    ...base,
    create: async (input: Row) => {
      if (cbCreateFails) return { data: null, errors: [{ message: "provider down" }] };
      return base.create(input);
    },
  };
};

vi.mock("./dataClient", () => ({
  dataClient: async () => ({
    models: {
      Customer: model(customers),
      Job: model(jobs, jobsCreated),
      ServicePlan: model(plans),
      CallbackRequest: callbackModel(),
      CompanyClosure: model(closures),
    },
  }),
}));

const emails: { to: string; subject: string; html: string }[] = [];
let emailFails = false;
let onSendHook: (() => void) | null = null;
vi.mock("./email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { to: string; subject: string; html: string }) => {
    onSendHook?.();
    emails.push(o);
    return !emailFails;
  },
  notifyOffice: async () => true,
}));
// GL-10 reopened: the photo must be a VERIFIED upload and scheduling must
// take a real capacity slot. Both are mocked with controllable outcomes so
// the failure paths are testable.
let photoVerifyFails: string | null = null;
const photoVerified: { key: string; customerId: string }[] = [];
vi.mock("./photoVerify", () => ({
  verifyCallbackPhoto: async (key: string, customerId: string) => {
    if (photoVerifyFails) throw new Error(photoVerifyFails);
    photoVerified.push({ key, customerId });
  },
}));

let techBase: string | null = "12 Depot St, Ware, MA";
let slotSoldOut = false;
const reserved: Record<string, unknown>[] = [];
const released: Record<string, unknown>[] = [];
vi.mock("./capacity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onsiteMinutes: (pc: string | null | undefined) =>
    pc === "RESIDENTIAL" ? 30 : 60,
  windowOfTimeWindow: (tw: string | null) =>
    tw === "12-5" ? "AFTERNOON" : "MORNING",
  techBaseFor: async () => techBase,
  reserveSlot: async (
    date: string,
    window: string,
    technicianId: string,
    minutes: number
  ) => {
    if (slotSoldOut)
      return { ok: false, soldOut: true, message: "That morning is now fully booked — pick another window or day." };
    reserved.push({ date, window, technicianId, minutes });
    return { ok: true };
  },
  releaseSlot: async (
    date: string,
    window: string,
    technicianId: string,
    minutes: number
  ) => {
    released.push({ date, window, technicianId, minutes });
  },
}));

vi.mock("./dispatchReadiness", () => ({
  assertDispatchFacts: () => undefined,
  proveRoutable: async () => ({ driveMinutes: 15, checkedAt: "2026-07-15T14:00:00Z" }),
}));

const workOpened: Record<string, unknown>[] = [];
const workResolved: Record<string, unknown>[] = [];
let workOpenFails = false;
vi.mock("./ownedWork", () => ({
  openOwnedWork: async (o: Record<string, unknown>) => {
    if (workOpenFails) return null;
    workOpened.push(o);
    return "w1";
  },
  resolveOwnedWork: async (o: Record<string, unknown>) => {
    workResolved.push(o);
    return true;
  },
}));

const { requestCallback, scheduleCallback, recordCallbackFinding } =
  await import("./callbacks");

const requester = { email: "dana@example.com", isOffice: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-15T14:00:00Z")); // a Wednesday
  customers.clear();
  jobs.clear();
  plans.clear();
  callbacks.clear();
  closures.clear();
  jobsCreated.length = 0;
  emails.length = 0;
  emailFails = false;
  workOpened.length = 0;
  workResolved.length = 0;
  photoVerifyFails = null;
  photoVerified.length = 0;
  workOpenFails = false;
  cbCreateFails = false;
  onSendHook = null;
  techBase = "12 Depot St, Ware, MA";
  slotSoldOut = false;
  reserved.length = 0;
  released.length = 0;
  _setLockStoreForTests(memoryLockStore({ CallbackRequest: callbacks }));
  customers.set("c1", {
    id: "c1",
    displayName: "Dana",
    email: "dana@example.com",
    groupId: null,
  });
  plans.set("p1", { id: "p1", status: "ACTIVE" });
  jobs.set("j1", {
    id: "j1",
    customerId: "c1",
    servicePlanId: "p1",
    status: "COMPLETED",
    serviceType: "General pest control plan visit",
    serviceCode: "GENERAL_PEST",
    propertyClass: "RESIDENTIAL",
    technicianId: "t1",
  });
});

const request = (over: Record<string, unknown> = {}) =>
  requestCallback(
    {
      customerId: "c1",
      originalJobId: "j1",
      photoKey: "callbacks/c1/photo1",
      ...over,
    } as never,
    requester
  );

describe("eligibility — the locked rules refuse before anything schedules", () => {
  it("accepts an active-plan completed visit with a photo: reference + 7-business-day promise + owned work + customer email", async () => {
    const res = await request();

    expect(res.status).toBe("ACCEPTED");
    expect(res.reference).toBe("cb-j1");
    // Wed Jul 15 + 7 business days = Fri Jul 24.
    expect(res.promisedBy).toBe("2026-07-24");
    expect(workOpened[0]).toMatchObject({
      kind: "CALLBACK_PROMISE",
      dedupeKey: "cb-j1",
    });
    expect(emails.some((e) => e.subject.includes("cb-j1"))).toBe(true);
    expect(emails[0].html).toContain("2026-07-24");
  });

  it("tracked closures do not count as business days — the promise lands later", async () => {
    closures.set("2026-07-17", { id: "2026-07-17", reason: "Company outing" });

    const res = await request();

    expect(res.promisedBy).toBe("2026-07-27"); // Friday lost → next Monday
  });

  it("one-time work is ineligible — the guarantee needs an active residual plan", async () => {
    jobs.set("j1", { ...jobs.get("j1")!, servicePlanId: null });
    await expect(request()).rejects.toThrow(/one-time visits aren't covered/);
  });

  it("a canceled or paused plan is ineligible", async () => {
    plans.set("p1", { id: "p1", status: "CANCELED" });
    await expect(request()).rejects.toThrow(/isn't active/);
  });

  it("an uncompleted visit is ineligible; someone else's visit is refused", async () => {
    jobs.set("j1", { ...jobs.get("j1")!, status: "SCHEDULED" });
    await expect(request()).rejects.toThrow(/hasn't been completed/);
    jobs.set("j1", { ...jobs.get("j1")!, status: "COMPLETED", customerId: "c2" });
    await expect(request()).rejects.toThrow(/doesn't belong/);
  });

  it("the photo is REQUIRED before anything can be scheduled", async () => {
    await expect(request({ photoKey: "  " })).rejects.toThrow(/photo/);
  });

  it("ONE callback per original appointment — the second submission collapses onto the first", async () => {
    const first = await request();
    emails.length = 0;
    workOpened.length = 0;

    const second = await request();

    expect(second.status).toBe("ALREADY_REQUESTED");
    expect(second.reference).toBe(first.reference);
    expect(second.promisedBy).toBe(first.promisedBy);
    // GL-11: the collapse RE-ENSURES office ownership — openOwnedWork is
    // deduplicated by (kind, dedupeKey), so this can never mint a second
    // case, but it repairs a first submission that died before the queue.
    expect(workOpened).toHaveLength(1);
    expect(workOpened[0]).toMatchObject({
      kind: "CALLBACK_PROMISE",
      dedupeKey: "cb-j1",
    });
    expect(emails).toHaveLength(0); // no duplicate customer email
  });

  it("a provider/database create failure is NOT reported as a duplicate", async () => {
    cbCreateFails = true;

    // The create failed AND no prior row exists — the customer must hear
    // "couldn't be saved", never "already requested".
    await expect(request()).rejects.toThrow(/couldn't be saved/);
    expect(callbacks.size).toBe(0);
    expect(workOpened).toHaveLength(0);
  });

  it("a real duplicate still collapses when the create fails but the row EXISTS", async () => {
    await request();
    workOpened.length = 0;
    cbCreateFails = true; // the conditional-create refusal path

    const second = await request();
    expect(second.status).toBe("ALREADY_REQUESTED");
    expect(second.reference).toBe("cb-j1");
  });

  it("a failed ownership re-ensure on the collapse is LOUD, never swallowed", async () => {
    await request();
    // Simulate: row exists, but the queue re-ensure fails on the retry.
    workOpenFails = true;
    await expect(request()).rejects.toThrow(/still couldn't reach the office queue/);
  });

  it("a queue-write failure is LOUD, and the retry converges onto the same owned request", async () => {
    workOpenFails = true;
    await expect(request()).rejects.toThrow(/couldn't reach the office queue/);
    // The request row survives the failure — the promise is durable…
    expect(callbacks.has("cb-j1")).toBe(true);

    // …and the retry collapses onto it and re-ensures ownership.
    workOpenFails = false;
    const retry = await request();
    expect(retry.status).toBe("ALREADY_REQUESTED");
    expect(workOpened.some((w) => w.dedupeKey === "cb-j1")).toBe(true);
  });
});

describe("scheduling — $0 by construction, inside the promise", () => {
  it("creates the $0 callback visit carrying the original context and resolves the promise item", async () => {
    await request();

    const res = await scheduleCallback({
      callbackRequestId: "cb-j1",
      scheduledDate: "2026-07-22",
      technicianId: "t1",
    });

    expect(res.callbackJobId).toBe("cbjob-cb-j1");
    const job = jobs.get("cbjob-cb-j1")!;
    expect(job.priceCents).toBeNull(); // nobody chooses or calculates money
    expect(String(job.serviceType)).toContain("guarantee callback");
    expect(String(job.notes)).toContain("j1");
    expect(String(job.notes)).toContain("callbacks/c1/photo1");
    expect(callbacks.get("cb-j1")).toMatchObject({
      status: "SCHEDULED",
      callbackJobId: "cbjob-cb-j1",
    });
    expect(workResolved.some((w) => w.kind === "CALLBACK_PROMISE")).toBe(true);
  });

  it("refuses a date beyond the promised return unless the customer chose it", async () => {
    await request(); // promisedBy 2026-07-24

    await expect(
      scheduleCallback({
        callbackRequestId: "cb-j1",
        scheduledDate: "2026-07-28",
        technicianId: "t1",
      })
    ).rejects.toThrow(/after the promised return/);

    const ok = await scheduleCallback({
      callbackRequestId: "cb-j1",
      scheduledDate: "2026-07-28",
      technicianId: "t1",
      customerRequestedLater: true,
    });
    expect(ok.callbackJobId).toBe("cbjob-cb-j1");
  });

  it("the visit consumes REAL capacity: onsite + round-trip drive reserved on the technician's window", async () => {
    await request();
    await scheduleCallback({
      callbackRequestId: "cb-j1",
      scheduledDate: "2026-07-22",
      timeWindow: "12-5",
      technicianId: "t1",
    });

    // RESIDENTIAL 30 onsite + 15 drive * 2 = 60 minutes on the AFTERNOON slot.
    expect(reserved).toEqual([
      { date: "2026-07-22", window: "AFTERNOON", technicianId: "t1", minutes: 60 },
    ]);
    const job = jobs.get("cbjob-cb-j1")!;
    expect(job.technicianId).toBe("t1");
    expect(job.capacityWindow).toBe("AFTERNOON");
    expect(job.capacityMinutes).toBe(60);
  });

  it("refuses without a technician — a callback is never free-floating schedule text", async () => {
    await request();
    await expect(
      scheduleCallback({
        callbackRequestId: "cb-j1",
        scheduledDate: "2026-07-22",
        technicianId: "",
      })
    ).rejects.toThrow(/technician/i);
    expect(jobs.has("cbjob-cb-j1")).toBe(false);
    expect(reserved).toHaveLength(0);
  });

  it("refuses when the window is sold out — the $0 visit cannot oversell a day", async () => {
    await request();
    slotSoldOut = true;
    await expect(
      scheduleCallback({
        callbackRequestId: "cb-j1",
        scheduledDate: "2026-07-22",
        technicianId: "t1",
      })
    ).rejects.toThrow(/fully booked/);
    expect(jobs.has("cbjob-cb-j1")).toBe(false);
  });

  it("refuses a technician who isn't schedulable that day", async () => {
    await request();
    techBase = null;
    await expect(
      scheduleCallback({
        callbackRequestId: "cb-j1",
        scheduledDate: "2026-07-22",
        technicianId: "t9",
      })
    ).rejects.toThrow(/isn't schedulable/);
    expect(reserved).toHaveLength(0);
  });

  it("a replay that finds the visit already created gives its duplicate reservation back", async () => {
    await request();
    await scheduleCallback({
      callbackRequestId: "cb-j1",
      scheduledDate: "2026-07-22",
      technicianId: "t1",
    });
    // Simulate the crash-after-create replay: the callback row lost its
    // pointer but the job exists.
    delete callbacks.get("cb-j1")!.callbackJobId;
    callbacks.get("cb-j1")!.status = "REQUESTED";

    await scheduleCallback({
      callbackRequestId: "cb-j1",
      scheduledDate: "2026-07-22",
      technicianId: "t1",
    });

    expect(reserved).toHaveLength(2); // both attempts reserved first…
    expect(released).toHaveLength(1); // …and the duplicate gave its hold back
  });
});

describe("the photo is a VERIFIED upload, not a plausible string", () => {
  it("verifies the submitted key against the customer's own prefix and bucket object", async () => {
    await request();
    expect(photoVerified).toEqual([
      { key: "callbacks/c1/photo1", customerId: "c1" },
    ]);
  });

  it("refuses the callback when the photo cannot be verified", async () => {
    photoVerifyFails =
      "The photo upload didn't finish — try the upload again, then resubmit the callback.";
    await expect(request()).rejects.toThrow(/upload didn't finish/);
    expect(callbacks.size).toBe(0);
    expect(workOpened).toHaveLength(0);
  });
});

describe("the technician's finding — controlled, evidenced, terminal-guarded", () => {
  beforeEach(async () => {
    await request();
    await scheduleCallback({
      callbackRequestId: "cb-j1",
      scheduledDate: "2026-07-22",
      technicianId: "t1",
    });
    emails.length = 0;
  });

  it("TREATABLE_UNEXPECTED continues the guarantee — no final notice, no ending", async () => {
    const res = await recordCallbackFinding({
      callbackRequestId: "cb-j1",
      finding: "TREATABLE_UNEXPECTED",
      note: "Fresh ant trail on the north wall — treatable.",
    });

    expect(res.status).toBe("COMPLETED");
    expect(callbacks.get("cb-j1")!.terminalNoticeSentAt).toBeUndefined();
    expect(emails).toHaveLength(0);
  });

  it("a stuck send-once claim is surfaced in the owned item, never swallowed", async () => {
    emailFails = true;
    // The claim-release after the failed send hits a dead lock layer — the
    // owned item must say resends are BLOCKED until the claim is cleared.
    onSendHook = () => _setLockStoreForTests(memoryLockStore({}));

    await recordCallbackFinding({
      callbackRequestId: "cb-j1",
      finding: "EXPECTED_BEHAVIOR",
      note: "Cluster flies — expected behavior.",
    });

    const item = workOpened.find((w) => w.kind === "EMAIL_FAILURE")!;
    expect(item).toBeTruthy();
    expect(String(item.detail)).toContain("could NOT be released");
    expect(String(item.resolutionAction)).toContain("terminalNoticeSentAt");
  });

  it("EXPECTED_BEHAVIOR ends the guarantee with evidence and ONE final notice", async () => {
    const res = await recordCallbackFinding({
      callbackRequestId: "cb-j1",
      finding: "EXPECTED_BEHAVIOR",
      note: "Seasonal cluster flies — normal for the week, not an infestation.",
    });

    expect(res.status).toBe("GUARANTEE_ENDED");
    expect(callbacks.get("cb-j1")).toMatchObject({
      finding: "EXPECTED_BEHAVIOR",
      findingNote: "Seasonal cluster flies — normal for the week, not an infestation.",
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].html).toContain("expected pest behavior");
    expect(emails[0].html).toContain("concludes the guarantee");
    // No appeal or further callback is promised anywhere in the notice.
    expect(emails[0].html.toLowerCase()).not.toContain("appeal");
  });

  it("a replayed finding cannot flip a terminal outcome or re-send the notice", async () => {
    await recordCallbackFinding({
      callbackRequestId: "cb-j1",
      finding: "UNTREATABLE_CONDITION",
      note: "Standing water under the crawlspace — a condition, not a treatment target.",
    });
    emails.length = 0;

    const replay = await recordCallbackFinding({
      callbackRequestId: "cb-j1",
      finding: "TREATABLE_UNEXPECTED",
      note: "second opinion",
    });

    expect(replay.status).toBe("GUARANTEE_ENDED"); // the recorded truth stands
    expect(callbacks.get("cb-j1")!.finding).toBe("UNTREATABLE_CONDITION");
    expect(emails).toHaveLength(0);
  });

  it("an uncontrolled finding or missing evidence is refused", async () => {
    await expect(
      recordCallbackFinding({
        callbackRequestId: "cb-j1",
        finding: "LOOKS_FINE",
        note: "x",
      })
    ).rejects.toThrow(/controlled findings/);
    await expect(
      recordCallbackFinding({
        callbackRequestId: "cb-j1",
        finding: "EXPECTED_BEHAVIOR",
        note: "  ",
      })
    ).rejects.toThrow(/evidence note/);
  });

  it("a failed final-notice send releases the claim and opens owned work — the customer is never silently untold", async () => {
    emailFails = true;

    await recordCallbackFinding({
      callbackRequestId: "cb-j1",
      finding: "EXPECTED_BEHAVIOR",
      note: "Normal seasonal activity.",
    });

    expect(callbacks.get("cb-j1")!.terminalNoticeSentAt).toBeUndefined();
    expect(
      workOpened.some(
        (w) => w.kind === "EMAIL_FAILURE" && w.dedupeKey === "callback-final:cb-j1"
      )
    ).toBe(true);
  });
});
