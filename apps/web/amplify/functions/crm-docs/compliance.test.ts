import { beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "../shared/atomicLock";
import { capacityFixtureModels } from "../shared/capacityTestFixture";

/**
 * The pesticide record, and the technician's honest exit.
 *
 * These are one problem. A technician at a locked door had two options: leave
 * the job hanging and keep being nagged, or file a report for a visit that never
 * happened — which emails the customer a pesticide record, arms the charge and
 * advances the plan. The second is the one that clears the screen, so the
 * system's easiest path was a fabricated legal document.
 *
 * And the record it produced was not one: products optional, no EPA check, no
 * licence number, no application time, no re-entry interval, and rewritable
 * after it had been issued to the customer.
 */

type Job = Record<string, unknown> & { id: string; status: string };
type Report = Record<string, unknown> & { id: string; status: string };

let jobs: Job[] = [];
let reports: Report[] = [];
let technician: Record<string, unknown>;
let customer: Record<string, unknown>;
let routes: Record<string, unknown>[] = [];
let catalog: Record<string, unknown>[] = [];
let workItems: Record<string, unknown>[] = [];
let amendments: Record<string, unknown>[] = [];
const officeEmails: { subject: string; bodyHtml: string }[] = [];
/** Captures the opts each renderAmendmentPdf call receives, so a test can assert
 *  what the rendered document says (e.g. who it names as the issuer). */
const amendmentPdfCalls: Record<string, unknown>[] = [];

const finalizeClaims = new Map<string, Record<string, unknown>>();
/** Immutable packet-change rows (JobPacketEvent). */
let packetEvents: Record<string, unknown>[] = [];
/** EmailLog rows the SENDING-adoption resume reads (GL-15 outbox check). */
let emailLogRows: Record<string, unknown>[] = [];
/** Force WorkItem.create to fail so a test can prove the FLAGGED presence-review
 *  marker survives a lost case write. */
let workItemCreateFails = false;

const capacityFixture = capacityFixtureModels();

const fakeDataClient = {
  models: {
    JobPacketEvent: {
      create: async (input: Record<string, unknown>) => {
        packetEvents.push({ ...input });
        return { data: input };
      },
    },
    ServiceReportFinalizeClaim: {
      // Conditional create: an existing id loses — the single-winner finalize
      // claim (GL-15).
      create: async ({ id }: { id: string }) => {
        if (finalizeClaims.has(id)) return { data: null };
        finalizeClaims.set(id, { id, requestedAt: new Date().toISOString() });
        return { data: finalizeClaims.get(id) };
      },
      get: async ({ id }: { id: string }) => ({
        data: finalizeClaims.get(id) ?? null,
      }),
      delete: async ({ id }: { id: string }) => {
        const existed = finalizeClaims.get(id) ?? null;
        finalizeClaims.delete(id);
        return { data: existed };
      },
    },
    Job: {
      get: async ({ id }: { id: string }) => ({
        data: jobs.find((j) => j.id === id) ?? null,
      }),
      listJobByScheduledDate: async ({
        scheduledDate,
      }: {
        scheduledDate: string;
      }) => ({
        data: jobs.filter(
          (j) => (j as { scheduledDate?: string }).scheduledDate === scheduledDate
        ),
        nextToken: null,
      }),
      update: async (patch: Job) => {
        const i = jobs.findIndex((j) => j.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        jobs[i] = { ...jobs[i], ...patch };
        return { data: jobs[i], errors: undefined };
      },
      create: async (input: Record<string, unknown>) => {
        const j = { id: `job_${jobs.length + 1}`, ...input } as Job;
        jobs.push(j);
        return { data: j, errors: undefined };
      },
    },
    Route: {
      get: async ({ id }: { id: string }) => ({
        data: routes.find((r) => r.id === id) ?? null,
      }),
    },
    ServiceReport: {
      get: async ({ id }: { id: string }) => ({
        data: reports.find((r) => r.id === id) ?? null,
      }),
      create: async (input: Record<string, unknown>) => {
        const r = { id: `rep_${reports.length + 1}`, ...input } as Report;
        reports.push(r);
        return { data: r, errors: undefined };
      },
      update: async (patch: Report) => {
        const i = reports.findIndex((r) => r.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        reports[i] = { ...reports[i], ...patch };
        return { data: reports[i], errors: undefined };
      },
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({
        data: { id, ...customer },
      }),
    },
    Technician: {
      get: async ({ id }: { id: string }) => ({
        data: { id, ...technician },
      }),
      list: async () => ({
        data: [{ id: "t1", ...technician }],
      }),
    },
    Product: {
      list: async () => ({ data: catalog }),
    },
    ServiceReportAmendment: {
      get: async ({ id }: { id: string }) => ({
        data: amendments.find((a) => a.id === id) ?? null,
        errors: undefined,
      }),
      create: async (input: Record<string, unknown>) => {
        const a = { id: `amd_${amendments.length + 1}`, ...input } as Record<
          string,
          unknown
        >;
        amendments.push(a);
        return { data: a, errors: undefined };
      },
      update: async (patch: Record<string, unknown>) => {
        const i = amendments.findIndex((a) => a.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        amendments[i] = { ...amendments[i], ...patch };
        return { data: amendments[i], errors: undefined };
      },
    },
    WorkItem: {
      get: async ({ id }: { id: string }) => ({
        data: workItems.find((w) => w.id === id) ?? null,
        errors: undefined,
      }),
      create: async (input: Record<string, unknown>) => {
        if (workItemCreateFails) return { data: null, errors: [{ message: "injected" }] };
        const w = { ...input };
        workItems.push(w);
        return { data: w, errors: undefined };
      },
      update: async (patch: Record<string, unknown>) => {
        const i = workItems.findIndex((w) => w.id === patch.id);
        if (i < 0) return { data: null, errors: [{ message: "not found" }] };
        workItems[i] = { ...workItems[i], ...patch };
        return { data: workItems[i], errors: undefined };
      },
    },
    WorkEvent: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: `evt_${input.workItemId}`, ...input },
        errors: undefined,
      }),
    },
    EmailLog: {
      listEmailLogByRelatedId: async ({ relatedId }: { relatedId: string }) => ({
        data: emailLogRows.filter((l) => l.relatedId === relatedId),
      }),
    },
  },
};
Object.assign(fakeDataClient.models, capacityFixture.models);
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: vi.fn(async () => true),
  notifyOffice: async (o: { subject: string; bodyHtml: string }) => {
    officeEmails.push(o);
    return true;
  },
}));
vi.mock("../shared/stripeClient", () => ({ stripeClient: () => ({}) }));
vi.mock("../shared/subscription", () => ({ startPlanBilling: async () => ({ started: true }) }));
vi.mock("../shared/recurring", () => ({
  nextVisitDate: () => "2026-08-15",
  prettyDate: (d: string) => d,
  scheduleNextRecurringVisit: vi.fn(async () => undefined),
}));
vi.mock("../shared/pdf", () => ({
  renderServiceReportPdf: async () => new Uint8Array([1]),
  renderAmendmentPdf: async (opts: Record<string, unknown>) => {
    amendmentPdfCalls.push(opts);
    return new Uint8Array([2]);
  },
}));
vi.mock("../shared/driveTime", () => ({
  drivingDistanceMetersFromPoint: vi.fn(async () => null),
  driveMinutesBetween: vi.fn(async () => 25),
  HQ_ADDRESS: "81 Greenwich Rd, Ware, MA 01082",
}));
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {}
  class GetObjectCommand {}
  return {
    // A GetObject returns a stored PDF body, so a resumed delivery can re-fetch
    // the finalized report to attach; a PutObject just acknowledges.
    S3Client: class {
      async send(cmd: unknown) {
        if (cmd instanceof GetObjectCommand) {
          return {
            Body: { transformToByteArray: async () => new Uint8Array([9]) },
          };
        }
        return {};
      }
    },
    PutObjectCommand,
    GetObjectCommand,
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://s3.example/put",
}));

const { handler } = await import("./handler");
const { sendEmail } = await import("../shared/email");
const { drivingDistanceMetersFromPoint } = await import("../shared/driveTime");

const call = (
  field: string,
  args: Record<string, unknown>,
  groups: string[] = ["TECH"],
  claims: Record<string, unknown> = {}
) => {
  // GL-13: scheduling changes carry a controlled reason. Default one in for the
  // many tests that aren't about the reason itself.
  const arguments_ =
    field === "updateJobSchedule" && args.reasonCode === undefined
      ? { ...args, reasonCode: "ROUTING" }
      : args;
  return (handler as unknown as (e: never) => Promise<unknown>)({
    info: { fieldName: field },
    arguments: arguments_,
    identity: {
      sub: "sub-tech",
      groups,
      claims: { email: "marco@x.com", ...claims },
    },
  } as never);
};

/** A report that satisfies every rule, so each test can break exactly one. */
const validReport = (over: Partial<Report> = {}): Report => ({
  id: "rep_1",
  jobId: "j1",
  customerId: "c1",
  technicianId: "t1",
  status: "DRAFT",
  serviceDate: "2026-07-16T09:00:00Z",
  servicesPerformed: "Exterior barrier treatment and web removal",
  productsUsed: JSON.stringify([
    { name: "Suspend PolyZone", epaNumber: "432-1514", quantity: "1.5 oz", rate: "0.06%" },
  ]),
  reEntryIntervalHours: 4,
  geoLat: 41.82,
  geoLng: -71.41,
  geoAccuracyM: 12,
  // Inside the finalize-gate job window (13:05–14:10 on 2026-07-16).
  geoCapturedAt: "2026-07-16T13:30:00Z",
  ...over,
});

beforeEach(() => {
  capacityFixture.maps.capacityDays.clear();
  capacityFixture.maps.capacityClaims.clear();
  capacityFixture.maps.closures.clear();
  capacityFixture.maps.exceptions.clear();
  _setLockStoreForTests(
    memoryLockStore({
      CapacityDay: capacityFixture.maps.capacityDays,
      CapacityClaim: capacityFixture.maps.capacityClaims,
      TreatmentObligation: new Map(),
      // A live get-only view over the test's job array: guarded publishes
      // mutate the same row objects the fake models serve.
      Job: {
        get: (id: string) => jobs.find((j) => j.id === id),
      } as unknown as Map<string, Record<string, unknown>>,
    })
  );
  finalizeClaims.clear();
  packetEvents = [];
  emailLogRows = [];
  workItemCreateFails = false;
  process.env.DOCS_BUCKET = "docs";
  technician = {
    name: "Marco Reyes",
    userSub: "sub-tech",
    active: true,
    licenseNumber: "MA-12345",
    licenseExpiresOn: "2027-07-16",
  };
  customer = {
    displayName: "Dana Whitlock",
    email: "dana@example.com",
    groupId: null,
    serviceStreet: "18 Cedar Ln",
    serviceCity: "Providence",
    serviceState: "RI",
    serviceZip: "02906",
  };
  jobs = [{ id: "j1", customerId: "c1", technicianId: "t1", status: "IN_PROGRESS", serviceType: "General pest", type: "ONE_TIME", propertyClass: "RESIDENTIAL" }];
  reports = [];
  routes = [];
  // The office-approved product log. validReport applies "Suspend PolyZone",
  // which must be an active, label-approved catalog row to finalize.
  catalog = [
    {
      id: "prod_1",
      name: "Suspend PolyZone",
      epaNumber: "432-1514",
      defaultRate: "0.06%",
      reEntryHours: 4,
      active: true,
      labelApproved: true,
    },
  ];
  workItems = [];
  amendments = [];
  officeEmails.length = 0;
  amendmentPdfCalls.length = 0;
  vi.mocked(sendEmail).mockReset();
  vi.mocked(sendEmail).mockResolvedValue(true);
  // On-site-presence distance check is off unless a test opts in with a key.
  delete process.env.GOOGLE_ROUTES_API_KEY;
  // GL-12: a missing Routes key now FAILS dispatch CLOSED. Tests that are not
  // about routability opt into the explicit local-dev escape hatch; the
  // fail-closed behavior itself is asserted in its own test below.
  process.env.ALLOW_UNVERIFIED_ROUTES = "true";
  vi.mocked(drivingDistanceMetersFromPoint).mockReset();
  vi.mocked(drivingDistanceMetersFromPoint).mockResolvedValue(null);
});

describe("regulated assignment", () => {
  it("GL-12: refuses to assign when routability cannot be verified (no key, no escape hatch)", async () => {
    jobs[0].status = "UNSCHEDULED";
    routes.push({ id: "r1", technicianId: "t1", date: "2026-07-20" });
    delete process.env.ALLOW_UNVERIFIED_ROUTES;
    try {
      await expect(
        call(
          "updateJobSchedule",
          {
            jobId: "j1",
            operation: "ASSIGN",
            technicianId: "t1",
            routeId: "r1",
            routeOrder: 1,
            scheduledDate: "2026-07-20",
          },
          ["OFFICE"]
        )
      ).rejects.toThrow(/GOOGLE_ROUTES_API_KEY/);
      expect(jobs[0].status).toBe("UNSCHEDULED");
    } finally {
      process.env.ALLOW_UNVERIFIED_ROUTES = "true";
    }
  });

  it("refuses to assign an active technician whose license data is incomplete", async () => {
    jobs[0].status = "UNSCHEDULED";
    technician.licenseNumber = null;
    routes.push({ id: "r1", technicianId: "t1", date: "2026-07-20" });

    await expect(
      call(
        "updateJobSchedule",
        {
          jobId: "j1",
          operation: "ASSIGN",
          technicianId: "t1",
          routeId: "r1",
          routeOrder: 1,
          scheduledDate: "2026-07-20",
        },
        ["OFFICE"]
      )
    ).rejects.toThrow(/license number/i);
    expect(jobs[0].status).toBe("UNSCHEDULED");
  });

  it("assigns a licensed active technician through the guarded mutation", async () => {
    jobs[0].status = "UNSCHEDULED";
    routes.push({ id: "r1", technicianId: "t1", date: "2026-07-20" });

    await call(
      "updateJobSchedule",
      {
        jobId: "j1",
        operation: "ASSIGN",
        technicianId: "t1",
        routeId: "r1",
        routeOrder: 1,
        scheduledDate: "2026-07-20",
      },
      ["OFFICE"]
    );

    expect(jobs[0]).toMatchObject({
      status: "SCHEDULED",
      technicianId: "t1",
      routeId: "r1",
    });
  });

  it("refuses to route a job whose customer has no deliverable address (GL-12)", async () => {
    jobs[0].status = "UNSCHEDULED";
    customer.serviceStreet = null;
    customer.serviceZip = "";
    routes.push({ id: "r1", technicianId: "t1", date: "2026-07-20" });

    await expect(
      call(
        "updateJobSchedule",
        {
          jobId: "j1",
          operation: "ASSIGN",
          technicianId: "t1",
          routeId: "r1",
          routeOrder: 1,
          scheduledDate: "2026-07-20",
        },
        ["OFFICE"]
      )
    ).rejects.toThrow(/deliverable service address.*street.*ZIP/is);
    // Never dispatched: the stop stays in the unscheduled pool, unrouted.
    expect(jobs[0].status).toBe("UNSCHEDULED");
    expect(jobs[0].routeId).toBeUndefined();
  });

  it("blocks the address before the technician credential, so the office sees the packet gap", async () => {
    // Both are wrong: no address AND an expired license. The address minimum is
    // named first because it is the one the office fixes on the customer record.
    jobs[0].status = "UNSCHEDULED";
    customer.serviceState = "";
    technician.licenseExpiresOn = "2020-01-01";
    routes.push({ id: "r1", technicianId: "t1", date: "2026-07-20" });

    await expect(
      call(
        "updateJobSchedule",
        {
          jobId: "j1",
          operation: "ASSIGN",
          technicianId: "t1",
          routeId: "r1",
          routeOrder: 1,
          scheduledDate: "2026-07-20",
        },
        ["OFFICE"]
      )
    ).rejects.toThrow(/deliverable service address/i);
  });
});

describe("dispatch packet capture (GL-12)", () => {
  it("refuses to create a scheduled job when the address is not deliverable", async () => {
    customer.serviceZip = null;

    await expect(
      call(
        "createOfficeJob",
        {
          customerId: "c1",
          serviceType: "General pest",
          scheduledDate: "2026-07-25",
        },
        ["OFFICE"]
      )
    ).rejects.toThrow(/can't be dispatched yet.*ZIP/is);
  });

  it("captures job-specific access, safety, prep and payment facts on create", async () => {
    const res = (await call(
      "createOfficeJob",
      {
        customerId: "c1",
        serviceType: "General pest",
        accessInstructions: "Gate code 4417, park on the street",
        hazardNotes: "Large dog in the back yard; toddler on site",
        prepInstructions: "Clear under the kitchen sink",
        prepConfirmed: true,
        paymentExpectation: "COLLECT_NOTHING",
      },
      ["OFFICE"]
    )) as { jobId: string };

    const created = jobs.find((j) => j.id === res.jobId)!;
    expect(created).toMatchObject({
      accessInstructions: "Gate code 4417, park on the street",
      hazardNotes: "Large dog in the back yard; toddler on site",
      prepInstructions: "Clear under the kitchen sink",
      prepConfirmed: true,
      paymentExpectation: "COLLECT_NOTHING",
    });
  });

  it("normalizes an unapproved payment posture to the safe office default", async () => {
    const res = (await call(
      "createOfficeJob",
      {
        customerId: "c1",
        serviceType: "General pest",
        paymentExpectation: "COLLECT_ON_SITE",
      },
      ["OFFICE"]
    )) as { jobId: string };

    const created = jobs.find((j) => j.id === res.jobId)!;
    // Not stored as the invented posture; absent reads as DUE_THROUGH_OFFICE.
    expect(created.paymentExpectation).toBeUndefined();
  });

  it("edits the packet on an existing job through the guarded mutation", async () => {
    jobs[0].status = "SCHEDULED";

    await call(
      "updateJobPacket",
      {
        jobId: "j1",
        hazardNotes: "Wasp-allergic occupant",
        paymentExpectation: "DUE_THROUGH_OFFICE",
      },
      ["OFFICE"]
    );

    expect(jobs[0]).toMatchObject({
      hazardNotes: "Wasp-allergic occupant",
      paymentExpectation: "DUE_THROUGH_OFFICE",
    });
  });

  it("will not edit the packet of a closed visit — it is part of the record", async () => {
    jobs[0].status = "COMPLETED";

    await expect(
      call("updateJobPacket", { jobId: "j1", hazardNotes: "too late" }, ["OFFICE"])
    ).rejects.toThrow(/closed|record/i);
  });
});

describe("no access — the honest exit", () => {
  it("ends the job without filing a report", async () => {
    await call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" });

    expect(jobs[0].status).toBe("NO_ACCESS");
    expect(reports).toHaveLength(0);
  });

  it("does not complete the job, so no charge is armed", async () => {
    await call("reportNoAccess", { jobId: "j1", reason: "LOCKED_OUT" });

    expect(jobs[0].status).not.toBe("COMPLETED");
    expect(jobs[0].completedAt).toBeUndefined();
  });

  it("does not queue the next recurring visit — the cadence did not advance", async () => {
    const { scheduleNextRecurringVisit } = await import("../shared/recurring");

    await call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" });

    expect(scheduleNextRecurringVisit).not.toHaveBeenCalled();
  });

  it("frees the day's capacity by taking the stop off the route", async () => {
    jobs[0].routeId = "r1";
    jobs[0].routeOrder = 3;

    await call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" });

    expect(jobs[0].routeId ?? null).toBeNull();
    expect(jobs[0].routeOrder ?? null).toBeNull();
  });

  it("records the reason and the time", async () => {
    await call("reportNoAccess", { jobId: "j1", reason: "DOG_LOOSE", note: "Gate padlocked" });

    expect(jobs[0]).toMatchObject({
      noAccessReason: "DOG_LOOSE",
      noAccessNote: "Gate padlocked",
    });
    expect(jobs[0].noAccessAt).toBeTruthy();
  });

  it("tells the office, because the billing decision is not the technician's", async () => {
    await call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" });

    expect(officeEmails).toHaveLength(1);
    expect(officeEmails[0].subject).toContain("Couldn't access");
    expect(officeEmails[0].bodyHtml).toContain("no new charge was made");
  });

  it("refuses a reason it does not know rather than recording a blank one", async () => {
    await expect(
      call("reportNoAccess", { jobId: "j1", reason: "COULDNT_BE_BOTHERED" })
    ).rejects.toThrow(/unknown no-access reason/i);
    expect(jobs[0].status).toBe("IN_PROGRESS");
  });

  it("is idempotent", async () => {
    await call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" });
    const res = (await call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" })) as {
      alreadyReported: boolean;
    };

    expect(res.alreadyReported).toBe(true);
    expect(officeEmails).toHaveLength(1);
  });

  it("refuses to overwrite a completed job", async () => {
    jobs[0].status = "COMPLETED";

    await expect(
      call("reportNoAccess", { jobId: "j1", reason: "NOBODY_HOME" })
    ).rejects.toThrow(/already completed/i);
  });
});

describe("the finalize gate", () => {
  // The real flow stamps both ends of the application window on site — Start job
  // then End application — before finalize ever runs. Every gate test below
  // starts from that fully-stamped job so each one can break exactly one rule.
  beforeEach(() => {
    jobs[0].startedAt = "2026-07-16T13:05:00Z";
    jobs[0].applicationEndAt = "2026-07-16T14:10:00Z";
  });

  it("finalizes a report that is actually a record", async () => {
    reports.push(validReport());

    const res = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
      alreadyFinalized: boolean;
    };

    expect(res.alreadyFinalized).toBe(false);
    expect(reports[0].status).toBe("FINALIZED");
  });

  it("refuses to complete regulated work without the applicator license number", async () => {
    technician.licenseNumber = null;
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/applicator license number/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("refuses to complete regulated work without the license expiration", async () => {
    technician.licenseExpiresOn = null;
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/license expiration date/i);
  });

  it("refuses a license that had expired before the application", async () => {
    technician.licenseExpiresOn = "2026-07-15";
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/expired.*not valid for work/i);
  });

  it("refuses a report with no products — a pesticide record needs pesticide", async () => {
    // This used to finalize and email happily.
    reports.push(validReport({ productsUsed: JSON.stringify([]) }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/add the products you applied/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("accepts zero products when the technician says it was an inspection", async () => {
    reports.push(
      validReport({
        productsUsed: JSON.stringify([]),
        inspectionOnly: true,
        reEntryIntervalHours: null,
      })
    );

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
  });

  it("refuses a report that claims inspection-only and lists products", async () => {
    reports.push(validReport({ inspectionOnly: true }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/untick one or the other/i);
  });

  it("refuses a product with no EPA number", async () => {
    reports.push(
      validReport({
        productsUsed: JSON.stringify([{ name: "Suspend", quantity: "1 oz" }]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/needs its EPA registration number/i);
  });

  it("refuses an EPA number that is not one", async () => {
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          { name: "Suspend", epaNumber: "dunno", quantity: "1 oz" },
        ]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/isn't a valid EPA registration number/i);
  });

  it.each(["432-1514", "432-1514-4321", "1234567-12345"])(
    "accepts the real EPA format %s from an approved catalog product",
    async (epaNumber) => {
      catalog.push({
        id: `prod_${epaNumber}`,
        name: "P",
        epaNumber,
        defaultRate: "1 oz / gal",
        reEntryHours: 4,
        active: true,
        labelApproved: true,
      });
      reports.push(
        validReport({
          productsUsed: JSON.stringify([
            { name: "P", epaNumber, quantity: "1 oz", rate: "1 oz / gal" },
          ]),
        })
      );

      await call("finalizeServiceReport", { reportId: "rep_1" });

      expect(reports[0].status).toBe("FINALIZED");
    }
  );

  it("refuses a product with no quantity — 'some' is not a record", async () => {
    reports.push(
      validReport({
        productsUsed: JSON.stringify([{ name: "Suspend", epaNumber: "432-1514" }]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/how much Suspend was applied/i);
  });

  it("refuses a product with no label application rate", async () => {
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          { name: "Suspend", epaNumber: "432-1514", quantity: "1 oz" },
        ]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/label application rate or dilution/i);
  });

  it("refuses without a re-entry interval — the occupant has to be told", async () => {
    reports.push(validReport({ reEntryIntervalHours: null }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/re-entry interval/i);
  });

  it("accepts a re-entry interval of zero, which is a real answer (zero-minimum label)", async () => {
    // Bait stations / exterior-only: the label minimum itself is 0. A zero
    // report re-entry is honest here — but never below a label minimum.
    catalog[0] = { ...catalog[0], reEntryHours: 0 };
    reports.push(validReport({ reEntryIntervalHours: 0 }));

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
  });

  it("refuses a report re-entry below the product's label minimum (GL-15 fail-closed)", async () => {
    reports.push(validReport({ reEntryIntervalHours: 0 }));
    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/below .*label minimum/i);
    expect(reports[0].status).not.toBe("FINALIZED");
  });

  it("refuses without a location", async () => {
    reports.push(validReport({ geoLat: null, geoLng: null }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/capture the location/i);
  });

  it("refuses an impossible coordinate — 0,0 is not an address", async () => {
    reports.push(validReport({ geoLat: 0, geoLng: 0 }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/real point on the map/i);
  });

  it("refuses a location with no capture time or accuracy — it isn't proof", async () => {
    reports.push(validReport({ geoCapturedAt: null }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/proof you were there|time or its accuracy/i);
  });

  it("flags an imprecise location for review but never blocks the technician", async () => {
    // A technician in a basement can't GPS their way to a better fix, so this
    // completes — and raises an OPS review task instead of a wall.
    reports.push(validReport({ geoAccuracyM: 5000 }));

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
    const review = workItems.find(
      (w) => w.kind === "LOCATION_REVIEW" && w.relatedId === "rep_1"
    );
    expect(review).toBeTruthy();
    expect(String(review!.detail)).toMatch(/accurate to about 5000 m/i);
  });

  it("does not flag a precise, on-site location", async () => {
    reports.push(validReport({ geoAccuracyM: 12 }));

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
    expect(workItems.some((w) => w.kind === "LOCATION_REVIEW")).toBe(false);
  });

  it("flags a location far from the service address for review, non-blocking", async () => {
    process.env.GOOGLE_ROUTES_API_KEY = "test-key";
    vi.mocked(drivingDistanceMetersFromPoint).mockResolvedValueOnce(4800); // ~3 mi
    reports.push(validReport());

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
    const review = workItems.find(
      (w) => w.kind === "LOCATION_REVIEW" && w.relatedId === "rep_1"
    );
    expect(review).toBeTruthy();
    expect(String(review!.detail)).toMatch(/from the service address/i);
  });

  it("never flags when the address can't be routed — unknown is not far", async () => {
    process.env.GOOGLE_ROUTES_API_KEY = "test-key";
    vi.mocked(drivingDistanceMetersFromPoint).mockResolvedValueOnce(null);
    reports.push(validReport());

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
    expect(workItems.some((w) => w.kind === "LOCATION_REVIEW")).toBe(false);
  });

  it("a location within a mile of the address is not flagged", async () => {
    process.env.GOOGLE_ROUTES_API_KEY = "test-key";
    vi.mocked(drivingDistanceMetersFromPoint).mockResolvedValueOnce(800); // ~0.5 mi
    reports.push(validReport());

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(workItems.some((w) => w.kind === "LOCATION_REVIEW")).toBe(false);
  });

  it("refuses a location captured on a different day — stale for this visit", async () => {
    // Valid reading, but from yesterday: it cannot prove presence at today's visit.
    reports.push(validReport({ geoCapturedAt: "2026-07-15T13:30:00Z" }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/outside the time you were on site/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("accepts a location captured just before Start, within the grace", async () => {
    // 12:45 is 20 min before the 13:05 start — the tech captured GPS on arrival.
    reports.push(validReport({ geoCapturedAt: "2026-07-16T12:45:00Z" }));

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
  });

  it("refuses without saying what was done", async () => {
    reports.push(validReport({ servicesPerformed: "   " }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/say what was done/i);
  });

  it("refuses to resurrect a canceled job as completed", async () => {
    jobs[0].status = "CANCELED";
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/was canceled/i);
  });

  it("refuses a report on a job the technician couldn't access", async () => {
    jobs[0].status = "NO_ACCESS";
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/did not happen/i);
  });

  it("refuses a job that was never started — the record needs a real start time", async () => {
    jobs[0].status = "SCHEDULED";
    jobs[0].startedAt = null;
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/never started/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("refuses a job whose application was never ended — finalize never invents the end time", async () => {
    // The report can only reach finalize with a server-stamped end (End
    // application). Without it, the old code substituted the moment finalize
    // ran — turning "when we sent the paperwork" into "when we finished
    // spraying" on a legal record. It must refuse instead.
    jobs[0].applicationEndAt = null;
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/never ended/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("stamps the application window on the record", async () => {
    jobs[0].startedAt = "2026-07-16T13:05:00Z";
    reports.push(validReport());

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].applicationStartAt).toBe("2026-07-16T13:05:00Z");
    expect(reports[0].applicationEndAt).toBeTruthy();
  });

  it("refuses a free-text product that is not in the approved catalog", async () => {
    // Correctly shaped — a name, a format-valid EPA number, a quantity, a rate —
    // but invented on site. Format is not authorization.
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          { name: "Garage Special", epaNumber: "999-9999", quantity: "2 oz", rate: "0.1%" },
        ]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/isn't an approved product|approved product in the catalog|added to the product log/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("refuses a product whose catalog row was never label-approved", async () => {
    catalog[0].labelApproved = false;
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/approved product|product log/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("refuses a product whose catalog row has been retired", async () => {
    catalog[0].active = false;
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/approved product|product log/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("refuses a real EPA number recorded under the wrong product name", async () => {
    // 432-1514 is a real approved product (Suspend PolyZone), but not under this
    // name — a mislabeled record is still a false record.
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          { name: "Something Else", epaNumber: "432-1514", quantity: "1 oz", rate: "0.06%" },
        ]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/approved product|product log/i);
  });

  it("refuses a rate that isn't the approved label rate — free text can't authorize a strength", async () => {
    // Suspend PolyZone is approved at 0.06% (catalog defaultRate). A technician
    // typing 0.5% is applying a different strength than the label allows.
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          { name: "Suspend PolyZone", epaNumber: "432-1514", quantity: "1.5 oz", rate: "0.5%" },
        ]),
      })
    );

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/approved label rate|label rate/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("accepts the approved label rate regardless of spacing or case", async () => {
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          { name: "Suspend PolyZone", epaNumber: "432-1514", quantity: "1.5 oz", rate: " 0.06 % " },
        ]),
      })
    );

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
  });

  describe("completion and delivery are separate facts", () => {
    it("records the report as delivered when the email reaches the customer", async () => {
      reports.push(validReport());

      const res = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
        deliveryStatus: string;
      };

      expect(res.deliveryStatus).toBe("ACCEPTED");
      expect(reports[0].deliveryStatus).toBe("ACCEPTED");
      expect(reports[0].emailedAt).toBeTruthy();
      expect(reports[0].status).toBe("FINALIZED");
    });

    it("completes the report but marks delivery failed when the send bounces", async () => {
      vi.mocked(sendEmail).mockResolvedValueOnce(false);
      reports.push(validReport());

      const res = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
        deliveryStatus: string;
      };

      // The record stands — the job was done — but no one may read it as sent.
      expect(res.deliveryStatus).toBe("FAILED");
      expect(reports[0].deliveryStatus).toBe("FAILED");
      expect(reports[0].emailedAt).toBeUndefined();
      expect(reports[0].status).toBe("FINALIZED");
      expect(jobs[0].status).toBe("COMPLETED");
    });

    it("marks delivery NO_EMAIL and opens an owned delivery task when nothing is on file", async () => {
      customer.email = null;
      reports.push(validReport());

      const res = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
        deliveryStatus: string;
      };

      expect(res.deliveryStatus).toBe("NO_EMAIL");
      expect(reports[0].deliveryStatus).toBe("NO_EMAIL");
      // The record is still complete — completion does not wait on delivery.
      expect(reports[0].status).toBe("FINALIZED");
      expect(jobs[0].status).toBe("COMPLETED");
      // The undelivered record is owned work, not a silent gap.
      const task = workItems.find(
        (w) => w.kind === "MISSING_CONTACT" && w.relatedId === "rep_1"
      );
      expect(task).toBeTruthy();
      expect(String(task!.resolutionAction)).toMatch(/deliver|re-send|alternate/i);
    });

    it("does not send, so does not claim delivery, when there is no email", async () => {
      customer.email = null;
      reports.push(validReport());

      await call("finalizeServiceReport", { reportId: "rep_1" });

      expect(sendEmail).not.toHaveBeenCalled();
      expect(reports[0].emailedAt).toBeUndefined();
    });

    it("never tells the customer 'complete' before the record is durable", async () => {
      // The email must go out only after the report is FINALIZED and the job
      // COMPLETED — never ahead of the record that backs the claim.
      let statusAtSend: unknown;
      let jobStatusAtSend: unknown;
      vi.mocked(sendEmail).mockImplementationOnce(async () => {
        statusAtSend = reports[0].status;
        jobStatusAtSend = jobs[0].status;
        return true;
      });
      reports.push(validReport());

      await call("finalizeServiceReport", { reportId: "rep_1" });

      expect(statusAtSend).toBe("FINALIZED");
      expect(jobStatusAtSend).toBe("COMPLETED");
    });

    it("is resumable: a retried finalize returns the same record and never re-sends", async () => {
      reports.push(validReport());

      await call("finalizeServiceReport", { reportId: "rep_1" });
      const again = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
        alreadyFinalized: boolean;
        deliveryStatus: string;
      };

      expect(again.alreadyFinalized).toBe(true);
      expect(again.deliveryStatus).toBe("ACCEPTED");
      // The customer is emailed exactly once across both attempts.
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(reports).toHaveLength(1);
    });

    it("resumes delivery on a retry after a bounced send, without a second completion", async () => {
      vi.mocked(sendEmail).mockResolvedValueOnce(false);
      reports.push(validReport());

      // First attempt: the record stands, the send fails, no marker is written.
      await call("finalizeServiceReport", { reportId: "rep_1" });
      expect(reports[0].status).toBe("FINALIZED");
      expect(reports[0].deliveryStatus).toBe("FAILED");
      expect(reports[0].emailedAt).toBeUndefined();

      const completedAtAfterFirst = jobs[0].completedAt;

      // Retry: delivery resumes and succeeds; completion is not redone.
      const retry = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
        deliveryStatus: string;
      };
      expect(retry.deliveryStatus).toBe("ACCEPTED");
      expect(reports[0].emailedAt).toBeTruthy();
      expect(jobs[0].completedAt).toBe(completedAtAfterFirst);
      expect(sendEmail).toHaveBeenCalledTimes(2);
    });
  });
});

describe("application times are server-stamped", () => {
  it("startJob stamps the server's clock and ignores anything the browser sent", async () => {
    jobs[0].status = "SCHEDULED";
    const before = Date.now();

    await call("startJob", { jobId: "j1", startedAt: "1999-01-01T00:00:00Z" });

    expect(jobs[0].status).toBe("IN_PROGRESS");
    expect(Date.parse(jobs[0].startedAt as string)).toBeGreaterThanOrEqual(
      before
    );
  });

  it("startJob will not move a start that already happened", async () => {
    jobs[0].startedAt = "2026-07-16T13:05:00Z";

    const res = (await call("startJob", { jobId: "j1" })) as {
      alreadyStarted: boolean;
    };

    expect(res.alreadyStarted).toBe(true);
    expect(jobs[0].startedAt).toBe("2026-07-16T13:05:00Z");
  });

  it("startJob refuses a job that is not there to start", async () => {
    jobs[0].status = "CANCELED";

    await expect(call("startJob", { jobId: "j1" })).rejects.toThrow(
      /can't start a canceled job/i
    );
  });

  it("endApplication stamps the server's clock", async () => {
    const before = Date.now();

    await call("endApplication", { jobId: "j1" });

    expect(
      Date.parse(jobs[0].applicationEndAt as string)
    ).toBeGreaterThanOrEqual(before);
  });

  it("endApplication stamps once — the first end stands across retries", async () => {
    await call("endApplication", { jobId: "j1" });
    const first = jobs[0].applicationEndAt;

    const res = (await call("endApplication", { jobId: "j1" })) as {
      alreadyEnded: boolean;
    };

    expect(res.alreadyEnded).toBe(true);
    expect(jobs[0].applicationEndAt).toBe(first);
  });

  it("endApplication refuses a job that was never started", async () => {
    jobs[0].status = "SCHEDULED";

    await expect(call("endApplication", { jobId: "j1" })).rejects.toThrow(
      /never started/i
    );
  });

  it("the record carries the stamped end, not the moment finalize ran", async () => {
    // The report is written up the next morning: the end time must be
    // yesterday's stamp, not this morning's finalize.
    jobs[0].startedAt = "2026-07-16T13:05:00Z";
    jobs[0].applicationEndAt = "2026-07-16T14:10:00Z";
    reports.push(validReport());

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].applicationEndAt).toBe("2026-07-16T14:10:00Z");
  });
});

describe("a finalized report is immutable", () => {
  it("refuses to edit a report that has been issued to the customer", async () => {
    // The heart of item 7: a regulatory record that can be edited after
    // issuance is worse evidence than none.
    reports.push(validReport({ status: "FINALIZED" }));

    await expect(
      call("saveServiceReportDraft", {
        jobId: "j1",
        reportId: "rep_1",
        servicesPerformed: "actually I didn't do that",
      })
    ).rejects.toThrow(/cannot be changed/i);
    expect(reports[0].servicesPerformed).toBe(
      "Exterior barrier treatment and web removal"
    );
  });

  it("refuses to change a finalized report's photos", async () => {
    reports.push(validReport({ status: "FINALIZED" }));

    await expect(
      call("setReportPhotos", { reportId: "rep_1", photoKeys: [] })
    ).rejects.toThrow(/cannot be changed/i);
  });

  it("still lets a draft be edited", async () => {
    reports.push(validReport());

    await call("saveServiceReportDraft", {
      jobId: "j1",
      reportId: "rep_1",
      servicesPerformed: "Exterior barrier treatment, web removal, bait refresh",
    });

    expect(reports[0].servicesPerformed).toContain("bait refresh");
  });

  it("takes the technician from the token, not the request", async () => {
    await call("saveServiceReportDraft", {
      jobId: "j1",
      servicesPerformed: "Treatment",
      technicianId: "somebody-else",
    });

    expect(reports[0].technicianId).toBe("t1");
  });

  it("refuses to start a report from a login with no technician record", async () => {
    await expect(
      (handler as unknown as (e: never) => Promise<unknown>)({
        info: { fieldName: "saveServiceReportDraft" },
        arguments: { jobId: "j1", servicesPerformed: "x" },
        identity: { sub: "sub-unlinked", groups: ["TECH"], claims: {} },
      } as never)
    ).rejects.toThrow(/isn't linked to a technician record/i);
  });
});

describe("issued reports are corrected by append-only amendments", () => {
  const finalizedReport = (over: Partial<Report> = {}): Report =>
    validReport({
      status: "FINALIZED",
      pdfKey: "reports/c1/rep_1.pdf",
      servicesPerformed: "Exterior barrier treatment and web removal",
      ...over,
    });
  const CHANGES = JSON.stringify([
    { label: "Areas treated", from: "Kitchen", to: "Kitchen, basement, garage" },
  ]);

  it("issues an amendment linked to the original, with reason, author, time, and changes", async () => {
    reports.push(finalizedReport());

    const res = (await call(
      "amendServiceReport",
      { reportId: "rep_1", reason: "Missed two treated areas", changes: CHANGES },
      ["OFFICE"]
    )) as { amendmentId: string; deliveryStatus: string };

    expect(amendments).toHaveLength(1);
    const amd = amendments[0];
    expect(amd.originalReportId).toBe("rep_1");
    expect(amd.reason).toBe("Missed two treated areas");
    expect(amd.customerId).toBe("c1");
    expect(amd.issuedAt).toBeTruthy();
    // Author comes from the token, never the request body.
    expect(amd.authorEmail).toBe("marco@x.com");
    expect(JSON.parse(String(amd.changes))).toEqual([
      { label: "Areas treated", from: "Kitchen", to: "Kitchen, basement, garage" },
    ]);
    expect(amd.pdfKey).toContain("amendments/");
    expect(res.deliveryStatus).toBe("ACCEPTED");
  });

  it("never touches the original issued record", async () => {
    reports.push(finalizedReport());

    await call(
      "amendServiceReport",
      { reportId: "rep_1", reason: "Typo in areas", changes: CHANGES },
      ["OFFICE"]
    );

    // The original is preserved exactly — an amendment appends, it does not edit.
    expect(reports[0].status).toBe("FINALIZED");
    expect(reports[0].servicesPerformed).toBe(
      "Exterior barrier treatment and web removal"
    );
    expect(reports[0].areasTreated).toBe(validReport().areasTreated);
  });

  it("refuses to amend an unfinalized draft — a draft is edited, not amended", async () => {
    reports.push(finalizedReport({ status: "DRAFT" }));

    await expect(
      call(
        "amendServiceReport",
        { reportId: "rep_1", reason: "x", changes: CHANGES },
        ["OFFICE"]
      )
    ).rejects.toThrow(/only an issued report|draft/i);
    expect(amendments).toHaveLength(0);
  });

  it("refuses an amendment with no reason", async () => {
    reports.push(finalizedReport());

    await expect(
      call(
        "amendServiceReport",
        { reportId: "rep_1", reason: "   ", changes: CHANGES },
        ["OFFICE"]
      )
    ).rejects.toThrow(/reason/i);
    expect(amendments).toHaveLength(0);
  });

  it("refuses an amendment with no corrected facts", async () => {
    reports.push(finalizedReport());

    await expect(
      call(
        "amendServiceReport",
        {
          reportId: "rep_1",
          reason: "Fixing something",
          changes: JSON.stringify([{ label: "Areas treated", from: "Kitchen", to: "  " }]),
        },
        ["OFFICE"]
      )
    ).rejects.toThrow(/corrected fact|what changed/i);
    expect(amendments).toHaveLength(0);
  });

  it("a technician cannot issue an amendment — that is the office's to do", async () => {
    reports.push(finalizedReport());

    await expect(
      call("amendServiceReport", { reportId: "rep_1", reason: "x", changes: CHANGES }, [
        "TECH",
      ])
    ).rejects.toThrow(/office role required/i);
    expect(amendments).toHaveLength(0);
  });

  it("delivers the amendment and opens an owned task when there is no email", async () => {
    customer.email = null;
    reports.push(finalizedReport());

    const res = (await call(
      "amendServiceReport",
      { reportId: "rep_1", reason: "Correcting the rate", changes: CHANGES },
      ["OFFICE"]
    )) as { amendmentId: string; deliveryStatus: string };

    expect(res.deliveryStatus).toBe("NO_EMAIL");
    expect(amendments[0].deliveryStatus).toBe("NO_EMAIL");
    const task = workItems.find(
      (w) => w.kind === "MISSING_CONTACT" && w.relatedId === res.amendmentId
    );
    expect(task).toBeTruthy();
  });

  it("names the signed-in issuer on the document, not the original technician", async () => {
    reports.push(finalizedReport());

    await call(
      "amendServiceReport",
      { reportId: "rep_1", reason: "Correcting the areas", changes: CHANGES },
      ["OFFICE"],
      { name: "Priya Okafor", email: "priya@x.com" }
    );

    expect(amendmentPdfCalls).toHaveLength(1);
    // technician.name is "Marco Reyes" — the correction was issued by Priya.
    expect(amendmentPdfCalls[0].authorName).toBe("Priya Okafor");
    expect(amendmentPdfCalls[0].authorName).not.toBe("Marco Reyes");
    expect(amendments[0].authorEmail).toBe("priya@x.com");
  });

  it("falls back to the issuer's email when the token carries no name — still never the technician", async () => {
    reports.push(finalizedReport());

    await call(
      "amendServiceReport",
      { reportId: "rep_1", reason: "Correcting the areas", changes: CHANGES },
      ["OFFICE"]
    );

    // No name claim on the token, so the document names the issuer by email —
    // "marco@x.com" (the office login), never the technician's "Marco Reyes".
    expect(amendmentPdfCalls[0].authorName).toBe("marco@x.com");
  });

  it("is resumable: a retried correction lands on the same amendment, never a duplicate or a second send", async () => {
    reports.push(finalizedReport());
    const args = {
      reportId: "rep_1",
      reason: "Missed two treated areas",
      changes: CHANGES,
    };

    const first = (await call("amendServiceReport", args, ["OFFICE"])) as {
      amendmentId: string;
    };
    const again = (await call("amendServiceReport", args, ["OFFICE"])) as {
      amendmentId: string;
      alreadyIssued: boolean;
    };

    expect(amendments).toHaveLength(1);
    expect(again.amendmentId).toBe(first.amendmentId);
    expect(again.alreadyIssued).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("resumes delivery of an amendment after a bounced send, without a duplicate row", async () => {
    reports.push(finalizedReport());
    const args = {
      reportId: "rep_1",
      reason: "Correcting the rate",
      changes: CHANGES,
    };
    vi.mocked(sendEmail).mockResolvedValueOnce(false);

    const first = (await call("amendServiceReport", args, ["OFFICE"])) as {
      deliveryStatus: string;
    };
    expect(first.deliveryStatus).toBe("FAILED");

    const retry = (await call("amendServiceReport", args, ["OFFICE"])) as {
      deliveryStatus: string;
    };

    expect(retry.deliveryStatus).toBe("ACCEPTED");
    expect(amendments).toHaveLength(1);
    expect(amendments[0].emailedAt).toBeTruthy();
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });
});

describe("office completion is for administrative job types only", () => {
  it("refuses to complete field/pesticide work from the office — that needs a finalized report", async () => {
    // jobs[0] is "General pest": field work. No administrative type is defined,
    // so the office cannot complete it; the technician's report is the only path.
    await expect(call("completeJob", { jobId: "j1" }, ["OFFICE"])).rejects.toThrow(
      /finalized service report|administrative job types/i
    );
    expect(jobs[0].status).toBe("IN_PROGRESS"); // untouched — no COMPLETED, no billing
    expect(jobs[0].completedAt).toBeUndefined();
  });

  it("does not start billing or queue a next visit when it refuses", async () => {
    const { scheduleNextRecurringVisit } = await import("../shared/recurring");
    vi.mocked(scheduleNextRecurringVisit).mockClear(); // earlier finalize tests called it

    await expect(call("completeJob", { jobId: "j1" }, ["OFFICE"])).rejects.toThrow();

    expect(scheduleNextRecurringVisit).not.toHaveBeenCalled();
  });
});

describe("terminal visits are immutable — rebooking makes a new linked attempt", () => {
  const noAccessJob = () => ({
    id: "j1",
    customerId: "c1",
    servicePlanId: "p1",
    type: "RECURRING",
    serviceType: "General pest",
    status: "NO_ACCESS",
    noAccessReason: "LOCKED_OUT",
    noAccessAt: "2026-07-20T14:00:00Z",
    noAccessNote: "Gate padlocked, dog in yard",
    noAccessPhotoKey: "jobs/j1/door.jpg",
    routeId: null,
    scheduledDate: "2026-07-20",
    paidAt: "2026-07-10T12:00:00Z",
    paidPaymentIntentId: "pi_paid_once",
    accessGroups: ["cus-c1"],
  });

  it("refuses to assign a no-access visit — its reason, time, note, and photo are untouched", async () => {
    jobs = [noAccessJob()];
    routes = [{ id: "r1", technicianId: "t1", date: "2026-07-25" }];

    await expect(
      call(
        "updateJobSchedule",
        { jobId: "j1", operation: "ASSIGN", technicianId: "t1", routeId: "r1", routeOrder: 1, scheduledDate: "2026-07-25" },
        ["OFFICE"]
      )
    ).rejects.toThrow(/terminal record|rebook/i);

    // The terminal record survives completely.
    expect(jobs[0]).toMatchObject({
      status: "NO_ACCESS",
      noAccessReason: "LOCKED_OUT",
      noAccessAt: "2026-07-20T14:00:00Z",
      noAccessNote: "Gate padlocked, dog in yard",
      noAccessPhotoKey: "jobs/j1/door.jpg",
    });
  });

  it("refuses to unassign a canceled visit — terminal records don't move", async () => {
    jobs = [{ id: "j1", customerId: "c1", type: "ONE_TIME", serviceType: "General pest", status: "CANCELED", routeId: "r1", technicianId: "t1" }];

    await expect(
      call("updateJobSchedule", { jobId: "j1", operation: "UNASSIGN" }, ["OFFICE"])
    ).rejects.toThrow(/terminal record|rebook/i);
    expect(jobs[0].status).toBe("CANCELED");
  });

  it("rebooks a no-access visit as a NEW unscheduled job linked to the original", async () => {
    jobs = [noAccessJob()];

    const res = (await call("rebookJob", { jobId: "j1" }, ["OFFICE"])) as {
      jobId: string;
      rebookedFromJobId: string;
    };

    // A brand-new job was created; the original is byte-for-byte intact.
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ status: "NO_ACCESS", noAccessPhotoKey: "jobs/j1/door.jpg" });
    const fresh = jobs.find((j) => j.id === res.jobId)!;
    expect(fresh).toMatchObject({
      status: "UNSCHEDULED",
      customerId: "c1",
      servicePlanId: "p1",
      serviceType: "General pest",
      rebookedFromJobId: "j1",
      paidAt: "2026-07-10T12:00:00Z",
      paidPaymentIntentId: "pi_paid_once",
    });
    // The new attempt carries none of the terminal evidence.
    expect(fresh.noAccessReason).toBeUndefined();
    expect(fresh.noAccessPhotoKey).toBeUndefined();
    expect(res.rebookedFromJobId).toBe("j1");

    // A retried click/Lambda invocation returns the same new attempt instead
    // of quietly putting two visits into the scheduling pool.
    const retry = (await call("rebookJob", { jobId: "j1" }, ["OFFICE"])) as {
      jobId: string;
      alreadyRebooked: boolean;
    };
    expect(retry).toMatchObject({ jobId: res.jobId, alreadyRebooked: true });
    expect(jobs).toHaveLength(2);
  });

  it("refuses to rebook a completed visit — a finished visit is not retried", async () => {
    jobs = [{ id: "j1", customerId: "c1", type: "ONE_TIME", serviceType: "General pest", status: "COMPLETED" }];

    await expect(call("rebookJob", { jobId: "j1" }, ["OFFICE"])).rejects.toThrow(
      /terminal outcome/i
    );
    expect(jobs).toHaveLength(1);
  });
});

describe("GL-15 — finalize is single-winner, verified, and durable", () => {
  // Start from a fully-stamped job, exactly like the finalize-gate suite.
  beforeEach(() => {
    jobs[0].startedAt = "2026-07-16T13:05:00Z";
    jobs[0].applicationEndAt = "2026-07-16T14:10:00Z";
  });

  it("two simultaneous finalizes produce ONE completion and ONE customer email", async () => {
    reports.push(validReport());
    const [a, b] = await Promise.all([
      call("finalizeServiceReport", { reportId: "rep_1" }),
      call("finalizeServiceReport", { reportId: "rep_1" }),
    ]);
    const results = [a, b] as { inProgress?: boolean }[];
    // Exactly one winner; the loser reports the honest in-progress state.
    expect(results.filter((r) => r.inProgress).length).toBe(1);
    expect(reports[0].status).toBe("FINALIZED");
    expect(
      (sendEmail as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    ).toBe(1);
  });

  it("refuses finalization when the product has no label rate on file (fail closed)", async () => {
    catalog[0] = { ...catalog[0], defaultRate: null };
    reports.push(validReport());
    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/no approved label rate on file/i);
    expect(reports[0].status).not.toBe("FINALIZED");
  });

  it("enforces a structured quantity range when the label rule encodes one", async () => {
    catalog[0] = {
      ...catalog[0],
      labelRulesJson: JSON.stringify({
        quantity: { min: 0.5, max: 2, unit: "oz" },
      }),
    };
    reports.push(
      validReport({
        productsUsed: JSON.stringify([
          {
            name: "Suspend PolyZone",
            epaNumber: "432-1514",
            quantity: "3 oz",
            rate: "0.06%",
          },
        ]),
      })
    );
    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/outside the label range/i);
  });

  it("enforces pest applicability when the label rule encodes it", async () => {
    catalog[0] = {
      ...catalog[0],
      labelRulesJson: JSON.stringify({ allowedPests: ["ants", "spiders"] }),
    };
    reports.push(validReport({ targetPests: "ants, termites" }));
    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/isn't labeled for: termites/i);
  });

  it("marks provider acceptance ACCEPTED, never DELIVERED, and records the SENDING intent first", async () => {
    reports.push(validReport());
    await call("finalizeServiceReport", { reportId: "rep_1" });
    expect(reports[0].deliveryStatus).toBe("ACCEPTED");
    expect(reports[0].emailedAt).toBeTruthy();
  });

  it("adopts a proven prior send instead of re-emailing when the marker write was lost", async () => {
    // A prior pass wrote SENDING and the EmailLog proves the provider accepted
    // the send, but the crash lost the emailedAt marker.
    reports.push(
      validReport({
        status: "FINALIZED",
        pdfKey: "reports/c1/rep_1.pdf",
        deliveryStatus: "SENDING",
        presenceReviewStatus: "NOT_NEEDED",
      })
    );
    emailLogRows.push({
      id: "el-1",
      relatedId: "rep_1",
      template: "service-report",
      deliveryStatus: "SENT",
      sentAt: "2026-07-18T12:00:00.000Z",
    });
    const res = (await call("finalizeServiceReport", { reportId: "rep_1" })) as {
      emailed: boolean;
      deliveryStatus: string;
    };
    expect(res.emailed).toBe(false);
    expect(reports[0].deliveryStatus).toBe("ACCEPTED");
    expect(reports[0].emailedAt).toBe("2026-07-18T12:00:00.000Z");
    expect(
      (sendEmail as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    ).toBe(0);
  });

  it("keeps the presence-review obligation durable: FLAGGED persists when the case write fails, and the resume re-queues it", async () => {
    // Force the WorkItem write to fail once so openOwnedWork returns null.
    workItemCreateFails = true;
    reports.push(
      validReport({
        // Imprecise fix — warrants a review.
        geoAccuracyM: 500,
      })
    );
    await call("finalizeServiceReport", { reportId: "rep_1" });
    expect(reports[0].status).toBe("FINALIZED");
    expect(reports[0].presenceReviewStatus).toBe("FLAGGED");

    // Recovery: the next pass (sweep or resumed finalize) lands the case.
    workItemCreateFails = false;
    await call("finalizeServiceReport", { reportId: "rep_1" });
    expect(reports[0].presenceReviewStatus).toBe("QUEUED");
    // Only one delivery went out across both passes.
    expect(
      (sendEmail as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    ).toBe(1);
  });
});

describe("GL-12 — the honest one-tap exits and the versioned packet", () => {
  beforeEach(() => {
    jobs[0].startedAt = "2026-07-16T13:05:00Z";
    jobs[0].applicationEndAt = "2026-07-16T14:10:00Z";
  });

  it("scope mismatch: never starts/completes, frees the route, preserves paidAt, opens owned work, tells the customer", async () => {
    jobs[0] = {
      ...jobs[0],
      status: "SCHEDULED",
      startedAt: null,
      applicationEndAt: null,
      routeId: "r1",
      routeOrder: 3,
      paidAt: "2026-07-01T00:00:00Z",
    };
    const res = (await call("reportScopeMismatch", {
      jobId: "j1",
      reason: "DIFFERENT_PEST",
      note: "Carpenter ants, not general pest",
    })) as { status: string; alreadyReported: boolean };

    expect(res.status).toBe("SCOPE_MISMATCH");
    expect(jobs[0].status).toBe("SCOPE_MISMATCH");
    expect(jobs[0].startedAt ?? null).toBeNull();
    expect(jobs[0].completedAt ?? null).toBeNull();
    expect(jobs[0].routeId ?? null).toBeNull();
    expect(jobs[0].paidAt).toBe("2026-07-01T00:00:00Z");
    const workRow = workItems.find((w) => w.kind === "SCOPE_MISMATCH");
    expect(workRow).toBeTruthy();
    // The customer email went out (sendEmail mock records calls).
    const calls = (sendEmail as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    expect(
      calls.some(
        (c) => (c[0] as { template?: string }).template === "scope-mismatch-next-step"
      )
    ).toBe(true);
    // Idempotent re-report.
    const again = (await call("reportScopeMismatch", {
      jobId: "j1",
      reason: "DIFFERENT_PEST",
    })) as { alreadyReported: boolean };
    expect(again.alreadyReported).toBe(true);
  });

  it("prep missing opens its own owned case and next-step message", async () => {
    jobs[0] = {
      ...jobs[0],
      status: "SCHEDULED",
      startedAt: null,
      applicationEndAt: null,
    };
    await call("reportPrepMissing", {
      jobId: "j1",
      reason: "AREAS_NOT_CLEARED",
    });
    expect(jobs[0].status).toBe("PREP_MISSING");
    expect(workItems.find((w) => w.kind === "PREP_MISSING")).toBeTruthy();
  });

  it("a packet change bumps the version, records the immutable event, and blocks Start until acknowledged", async () => {
    jobs[0] = {
      ...jobs[0],
      status: "SCHEDULED",
      startedAt: null,
      applicationEndAt: null,
      packetVersion: 1,
      propertyClass: "RESIDENTIAL",
    };
    await call(
      "updateJobPacket",
      { jobId: "j1", hazardNotes: "Aggressive dog on site" },
      ["OFFICE"]
    );
    expect(jobs[0].packetVersion).toBe(2);
    expect(packetEvents).toHaveLength(1);
    expect(String(packetEvents[0].changedFields)).toContain("hazardNotes");

    // Start refuses until the technician acknowledges the new version.
    await expect(call("startJob", { jobId: "j1" })).rejects.toThrow(
      /packet changed .*acknowledge/i
    );
    await call("acknowledgePacket", { jobId: "j1", version: 2 });
    expect(jobs[0].packetAckVersion).toBe(2);
    await call("startJob", { jobId: "j1" });
    expect(jobs[0].startedAt).toBeTruthy();
  });

  it("a material change AFTER service starts requires a recorded manager reason", async () => {
    jobs[0] = {
      ...jobs[0],
      status: "IN_PROGRESS",
      startedAt: "2026-07-16T13:05:00Z",
      packetVersion: 1,
      propertyClass: "RESIDENTIAL",
    };
    await expect(
      call(
        "updateJobPacket",
        { jobId: "j1", hazardNotes: "New hazard mid-visit" },
        ["OFFICE"]
      )
    ).rejects.toThrow(/manager reason/i);
    await call(
      "updateJobPacket",
      {
        jobId: "j1",
        hazardNotes: "New hazard mid-visit",
        managerReason: "Customer reported a wasp allergy after start",
      },
      ["OFFICE"]
    );
    expect(jobs[0].packetVersion).toBe(2);
    expect(packetEvents[0].afterStart).toBe(true);
    expect(packetEvents[0].managerReason).toContain("wasp allergy");
  });

  it("assignment persists the Google Routes proof on the decision", async () => {
    process.env.GOOGLE_ROUTES_API_KEY = "key-1";
    const { driveMinutesBetween } = await import("../shared/driveTime");
    vi.mocked(driveMinutesBetween).mockResolvedValue(37);
    jobs[0] = {
      ...jobs[0],
      status: "UNSCHEDULED",
      startedAt: null,
      applicationEndAt: null,
      propertyClass: "RESIDENTIAL",
    };
    routes.push({ id: "r1", technicianId: "t1", date: "2026-07-20" });
    await call(
      "updateJobSchedule",
      {
        jobId: "j1",
        operation: "ASSIGN",
        technicianId: "t1",
        routeId: "r1",
        routeOrder: 1,
        scheduledDate: "2026-07-20",
      },
      ["OFFICE"]
    );
    expect(jobs[0].dispatchDriveMinutes).toBe(37);
    expect(jobs[0].dispatchRouteCheckedAt).toBeTruthy();
    delete process.env.GOOGLE_ROUTES_API_KEY;
  });
});

describe("GL-01 — office jobs are controlled catalog selections", () => {
  it("stamps the immutable catalog reference on a created job", async () => {
    const res = (await call(
      "createOfficeJob",
      { customerId: "c1", serviceType: "General pest control", serviceCode: "GENERAL_PEST" },
      ["OFFICE"]
    )) as { jobId: string };

    const created = jobs.find((j) => j.id === res.jobId)!;
    expect(created.serviceCode).toBe("GENERAL_PEST");
    expect(created.catalogVersion).toBeTruthy();
    expect(created.serviceType).toBe("General pest control");
  });

  it("resolves a legacy typed label to its catalog entry — never an uncataloged job", async () => {
    const res = (await call(
      "createOfficeJob",
      { customerId: "c1", serviceType: "General Pest Treatment" },
      ["OFFICE"]
    )) as { jobId: string };

    const created = jobs.find((j) => j.id === res.jobId)!;
    expect(created.serviceCode).toBe("GENERAL_PEST");
  });

  it("refuses an unknown catalog code outright", async () => {
    await expect(
      call(
        "createOfficeJob",
        { customerId: "c1", serviceType: "Whatever", serviceCode: "SNAKE_CHARMING" },
        ["OFFICE"]
      )
    ).rejects.toThrow(/Unknown catalog service/);
  });

  it("refuses unresolvable free text — jobs are never invented outside the catalog", async () => {
    const before = jobs.length;
    await expect(
      call(
        "createOfficeJob",
        { customerId: "c1", serviceType: "attic insulation restoration" },
        ["OFFICE"]
      )
    ).rejects.toThrow(/doesn't match a catalog service/);
    expect(jobs).toHaveLength(before);
  });

  it("\"Something else…\" opens an owned catalog decision and creates NO job", async () => {
    const before = jobs.length;
    const res = (await call(
      "createOfficeJob",
      {
        customerId: "c1",
        serviceType: "attic insulation restoration",
        serviceCode: "NOT_IN_CATALOG",
      },
      ["OFFICE"]
    )) as { catalogDecisionOpened?: boolean };

    expect(res.catalogDecisionOpened).toBe(true);
    expect(jobs).toHaveLength(before); // no invented job
    const decision = workItems.find((w) => w.kind === "SERVICE_CATALOG_DECISION")!;
    expect(decision).toBeTruthy();
    expect(String(decision.detail)).toContain("attic insulation restoration");
    expect(String(decision.detail)).toContain("No job was created");
  });
});

describe("GL-11 — portal requests are durable cases, never untracked calls", () => {
  const portalRequests = new Map<string, Record<string, unknown>>();
  let workItemBlocked = false;

  beforeEach(() => {
    portalRequests.clear();
    workItemBlocked = false;
    (fakeDataClient.models as Record<string, unknown>).PortalRequest = {
      get: async ({ id }: { id: string }) => ({
        data: portalRequests.get(id) ?? null,
      }),
      create: async (input: Record<string, unknown> & { id: string }) => {
        portalRequests.set(input.id, { ...input });
        return { data: portalRequests.get(input.id) };
      },
      update: async (patch: Record<string, unknown> & { id: string }) => {
        const row = portalRequests.get(patch.id);
        if (!row) return { data: null, errors: [{ message: "no row" }] };
        Object.assign(row, patch);
        return { data: { ...row } };
      },
      delete: async ({ id }: { id: string }) => {
        portalRequests.delete(id);
        return { data: null };
      },
    };
    const realCreate = fakeDataClient.models.WorkItem.create;
    (fakeDataClient.models.WorkItem as Record<string, unknown>).create = async (
      input: Record<string, unknown> & { id: string }
    ) => {
      if (workItemBlocked) return { data: null, errors: [{ message: "refused" }] };
      return realCreate(input as never);
    };
  });

  it("a customer submits for their OWN account: durable case + owned queue item + reference", async () => {
    const res = (await call(
      "submitPortalRequest",
      { customerId: "c1", kind: "HELP", message: "Is my plan seasonal?" },
      ["CUSTOMER", "cus-c1"]
    )) as { reference: string };

    expect(res.reference).toMatch(/^pr-/);
    expect(portalRequests.get(res.reference)).toMatchObject({
      customerId: "c1",
      kind: "HELP",
      status: "OPEN",
    });
    const item = workItems.find((w) => w.kind === "CUSTOMER_REQUEST")!;
    expect(item).toBeTruthy();
    expect(String(item.detail)).toContain("Is my plan seasonal?");
  });

  it("a customer cannot submit for someone else's account", async () => {
    await expect(
      call(
        "submitPortalRequest",
        { customerId: "c1", kind: "HELP", message: "hi" },
        ["CUSTOMER", "cus-OTHER"]
      )
    ).rejects.toThrow(/own account/);
  });

  it("a reschedule must name the customer's OWN live visit", async () => {
    jobs[0].status = "SCHEDULED";
    const res = (await call(
      "submitPortalRequest",
      {
        customerId: "c1",
        kind: "RESCHEDULE",
        jobId: "j1",
        preferredDate: "2026-07-30",
      },
      ["CUSTOMER", "cus-c1"]
    )) as { reference: string };
    expect(portalRequests.get(res.reference)).toMatchObject({
      kind: "RESCHEDULE",
      jobId: "j1",
    });

    await expect(
      call(
        "submitPortalRequest",
        { customerId: "c1", kind: "RESCHEDULE", jobId: "nope" },
        ["CUSTOMER", "cus-c1"]
      )
    ).rejects.toThrow(/doesn't belong/);
  });

  it("if the shared-queue item cannot be created, the submission FAILS and nothing is saved", async () => {
    workItemBlocked = true;

    await expect(
      call(
        "submitPortalRequest",
        { customerId: "c1", kind: "HELP", message: "hello" },
        ["CUSTOMER", "cus-c1"]
      )
    ).rejects.toThrow(/couldn't reach the office queue/);
    expect(portalRequests.size).toBe(0); // no half-saved promise
  });

  it("a retry of the same request CONVERGES: same reference, one row, one owned case", async () => {
    const args = { customerId: "c1", kind: "HELP", message: "Is my plan seasonal?" };
    const first = (await call("submitPortalRequest", args, ["CUSTOMER", "cus-c1"])) as {
      reference: string;
    };
    const second = (await call("submitPortalRequest", args, ["CUSTOMER", "cus-c1"])) as {
      reference: string;
    };

    expect(second.reference).toBe(first.reference);
    expect(portalRequests.size).toBe(1);
    expect(
      workItems.filter((w) => w.kind === "CUSTOMER_REQUEST")
    ).toHaveLength(1); // deduplicated — re-ensured, never duplicated
  });

  it("a queue failure then a retry: the retry lands the SAME request in the queue", async () => {
    const args = { customerId: "c1", kind: "HELP", message: "hello again" };
    workItemBlocked = true;
    await expect(
      call("submitPortalRequest", args, ["CUSTOMER", "cus-c1"])
    ).rejects.toThrow(/couldn't reach the office queue/);

    workItemBlocked = false;
    const retry = (await call("submitPortalRequest", args, ["CUSTOMER", "cus-c1"])) as {
      reference: string;
    };
    expect(portalRequests.get(retry.reference)).toMatchObject({ status: "OPEN" });
    expect(workItems.some((w) => w.kind === "CUSTOMER_REQUEST")).toBe(true);
  });

  it("resolving records the customer-visible answer and closes the queue item", async () => {
    const res = (await call(
      "submitPortalRequest",
      { customerId: "c1", kind: "HELP", message: "question" },
      ["CUSTOMER", "cus-c1"]
    )) as { reference: string };

    await call(
      "resolvePortalRequest",
      { portalRequestId: res.reference, note: "Yes — April through October." },
      ["OFFICE"]
    );

    expect(portalRequests.get(res.reference)).toMatchObject({
      status: "RESOLVED",
      resolutionNote: "Yes — April through October.",
    });
    const item = workItems.find((w) => w.kind === "CUSTOMER_REQUEST")!;
    expect(item.status).toBe("RESOLVED");
  });
});
