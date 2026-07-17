import { beforeEach, describe, expect, it, vi } from "vitest";

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
let routes: Record<string, unknown>[] = [];
const officeEmails: { subject: string; bodyHtml: string }[] = [];

const fakeDataClient = {
  models: {
    Job: {
      get: async ({ id }: { id: string }) => ({
        data: jobs.find((j) => j.id === id) ?? null,
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
        data: { id, displayName: "Dana Whitlock", groupId: null },
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
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async () => true,
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
vi.mock("../shared/pdf", () => ({ renderServiceReportPdf: async () => new Uint8Array([1]) }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { async send() { return {}; } },
  PutObjectCommand: class {},
  GetObjectCommand: class {},
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: async () => "https://s3.example/put",
}));

const { handler } = await import("./handler");

const call = (
  field: string,
  args: Record<string, unknown>,
  groups: string[] = ["TECH"]
) =>
  (handler as unknown as (e: never) => Promise<unknown>)({
    info: { fieldName: field },
    arguments: args,
    identity: { sub: "sub-tech", groups, claims: { email: "marco@x.com" } },
  } as never);

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
  ...over,
});

beforeEach(() => {
  process.env.DOCS_BUCKET = "docs";
  technician = {
    name: "Marco Reyes",
    userSub: "sub-tech",
    active: true,
    licenseNumber: "MA-12345",
    licenseExpiresOn: "2027-07-16",
  };
  jobs = [{ id: "j1", customerId: "c1", technicianId: "t1", status: "IN_PROGRESS", serviceType: "General pest", type: "ONE_TIME" }];
  reports = [];
  routes = [];
  officeEmails.length = 0;
});

describe("regulated assignment", () => {
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

    expect(jobs[0].routeId).toBeNull();
    expect(jobs[0].routeOrder).toBeNull();
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
    "accepts the real EPA format %s",
    async (epaNumber) => {
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

  it("accepts a re-entry interval of zero, which is a real answer", async () => {
    reports.push(validReport({ reEntryIntervalHours: 0 }));

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].status).toBe("FINALIZED");
  });

  it("refuses without a location", async () => {
    reports.push(validReport({ geoLat: null, geoLng: null }));

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/capture the location/i);
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
    reports.push(validReport());

    await expect(
      call("finalizeServiceReport", { reportId: "rep_1" })
    ).rejects.toThrow(/never started/i);
    expect(reports[0].status).toBe("DRAFT");
  });

  it("stamps the application window on the record", async () => {
    jobs[0].startedAt = "2026-07-16T13:05:00Z";
    reports.push(validReport());

    await call("finalizeServiceReport", { reportId: "rep_1" });

    expect(reports[0].applicationStartAt).toBe("2026-07-16T13:05:00Z");
    expect(reports[0].applicationEndAt).toBeTruthy();
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
      /no-access or canceled/i
    );
    expect(jobs).toHaveLength(1);
  });
});
