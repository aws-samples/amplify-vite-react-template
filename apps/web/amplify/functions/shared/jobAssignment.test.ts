import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSyncIdentity } from "aws-lambda";

/**
 * GL-13 — technician least-privilege and assignment enforcement.
 *
 * Direct-handler proof that knowing a record id is never enough: Technician A
 * cannot start, end, report on, finalize, photograph, or pull document links
 * for Technician B's job. The assignee can; the office can; an assignee whose
 * credential lapsed cannot; and a reassignment takes effect on the next action.
 */

type Tech = {
  id: string;
  name?: string | null;
  userSub?: string | null;
  active?: boolean | null;
  licenseNumber?: string | null;
  licenseExpiresOn?: string | null;
};
type Job = {
  id: string;
  customerId: string;
  technicianId?: string | null;
  scheduledDate?: string | null;
  status?: string | null;
};
type Report = {
  id: string;
  jobId: string;
  customerId: string;
  technicianId?: string | null;
  serviceDate?: string | null;
  status?: string | null;
  pdfKey?: string | null;
  photoKeys?: string[] | null;
};

const techs = new Map<string, Tech>();
const jobs = new Map<string, Job>();
const reports = new Map<string, Report>();

const fakeDataClient = {
  models: {
    Technician: {
      list: async () => ({ data: [...techs.values()] }),
    },
    Job: {
      get: async ({ id }: { id: string }) => ({ data: jobs.get(id) ?? null }),
      list: async ({
        filter,
      }: {
        filter?: {
          customerId?: { eq: string };
          technicianId?: { eq: string };
        };
      }) => ({
        data: [...jobs.values()].filter(
          (j) =>
            (!filter?.customerId || j.customerId === filter.customerId.eq) &&
            (!filter?.technicianId || j.technicianId === filter.technicianId.eq)
        ),
      }),
    },
    ServiceReport: {
      get: async ({ id }: { id: string }) => ({
        data:
          reports.get(id) ??
          (id === "rep_a"
            ? { id: "rep_a", jobId: "job_a" }
            : id === "rep_b"
              ? { id: "rep_b", jobId: "job_b" }
              : null),
      }),
      list: async ({
        filter,
      }: {
        filter?: { customerId?: { eq: string } };
      }) => ({
        data: [...reports.values()].filter(
          (r) => !filter?.customerId || r.customerId === filter.customerId.eq
        ),
        nextToken: null,
      }),
    },
  },
};

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const {
  assertCanActOnJobId,
  assertCanActOnReportId,
  assertCanReadJob,
  technicianDocumentAllowed,
  technicianForCaller,
} = await import("./jobAssignment");

const identity = (sub: string | null, groups: string[]): AppSyncIdentity =>
  ({ sub, groups, claims: {} }) as unknown as AppSyncIdentity;

const TECH_A = identity("sub-a", ["TECH"]);
const TECH_B = identity("sub-b", ["TECH"]);
const OFFICE = identity("sub-office", ["OFFICE"]);
const UNLINKED = identity("sub-nobody", ["TECH"]);

beforeEach(() => {
  techs.clear();
  jobs.clear();
  reports.clear();
  techs.set("t_a", {
    id: "t_a",
    name: "Ana",
    userSub: "sub-a",
    active: true,
    licenseNumber: "MA-1",
    licenseExpiresOn: "2027-01-01",
  });
  techs.set("t_b", {
    id: "t_b",
    name: "Ben",
    userSub: "sub-b",
    active: true,
    licenseNumber: "MA-2",
    licenseExpiresOn: "2027-01-01",
  });
  jobs.set("job_a", {
    id: "job_a",
    customerId: "cust_a",
    technicianId: "t_a",
    scheduledDate: "2026-07-16",
  });
  jobs.set("job_b", {
    id: "job_b",
    customerId: "cust_b",
    technicianId: "t_b",
    scheduledDate: "2026-07-16",
  });
});

describe("assertCanActOnJobId", () => {
  it("lets the assigned technician act on their own job", async () => {
    await expect(assertCanActOnJobId(TECH_A, "job_a")).resolves.toBeUndefined();
  });

  it("refuses Technician A on Technician B's job", async () => {
    await expect(assertCanActOnJobId(TECH_A, "job_b")).rejects.toThrow(
      /not authorized for this job/i
    );
  });

  it("gives the same opaque refusal for a job that does not exist", async () => {
    await expect(assertCanActOnJobId(TECH_A, "job_ghost")).rejects.toThrow(
      /not authorized for this job/i
    );
  });

  it("lets office act on any job (audited emergency/scheduling access)", async () => {
    await expect(assertCanActOnJobId(OFFICE, "job_a")).resolves.toBeUndefined();
    await expect(assertCanActOnJobId(OFFICE, "job_b")).resolves.toBeUndefined();
  });

  it("tells an unlinked login it is not linked, without leaking the job", async () => {
    await expect(assertCanActOnJobId(UNLINKED, "job_a")).rejects.toThrow(
      /isn't linked to a technician record/i
    );
  });

  it("refuses the assignee once their applicator license has expired", async () => {
    techs.get("t_a")!.licenseExpiresOn = "2026-07-15"; // day before the visit
    await expect(assertCanActOnJobId(TECH_A, "job_a")).rejects.toThrow(
      /expired.*not valid for work/i
    );
  });

  it("refuses the assignee once they are deactivated", async () => {
    techs.get("t_a")!.active = false;
    await expect(assertCanActOnJobId(TECH_A, "job_a")).rejects.toThrow(
      /inactive/i
    );
  });

  it("honors a reassignment immediately: B can act, A can no longer", async () => {
    jobs.get("job_a")!.technicianId = "t_b"; // office reassigned job_a to Ben
    await expect(assertCanActOnJobId(TECH_B, "job_a")).resolves.toBeUndefined();
    await expect(assertCanActOnJobId(TECH_A, "job_a")).rejects.toThrow(
      /not authorized for this job/i
    );
  });
});

describe("assertCanActOnReportId", () => {
  it("lets the assignee act on their own report", async () => {
    await expect(
      assertCanActOnReportId(TECH_A, "rep_a")
    ).resolves.toBeUndefined();
  });

  it("refuses Technician A on Technician B's report", async () => {
    await expect(assertCanActOnReportId(TECH_A, "rep_b")).rejects.toThrow(
      /not authorized for this job/i
    );
  });

  it("is opaque about a report that does not exist (non-office)", async () => {
    await expect(assertCanActOnReportId(TECH_A, "rep_ghost")).rejects.toThrow(
      /not authorized for this report/i
    );
  });

  it("surfaces the assignee's own credential failure, not a generic refusal", async () => {
    techs.get("t_a")!.licenseNumber = null;
    await expect(assertCanActOnReportId(TECH_A, "rep_a")).rejects.toThrow(
      /applicator license number/i
    );
  });
});

describe("technicianDocumentAllowed (GL-13 per-document proof)", () => {
  const OWN_PDF = "reports/cust_a/own.pdf";
  const OTHER_PDF = "reports/cust_a/other.pdf";
  beforeEach(() => {
    // Ana's own finalized report at cust_a, plus another tech's report at the
    // SAME customer — the shared-customer case the old predicate over-granted.
    reports.set("rep_own", {
      id: "rep_own",
      jobId: "job_a",
      customerId: "cust_a",
      technicianId: "t_a",
      serviceDate: "2026-06-01T00:00:00.000Z",
      status: "FINALIZED",
      pdfKey: OWN_PDF,
    });
    reports.set("rep_other", {
      id: "rep_other",
      jobId: "job_other",
      customerId: "cust_a",
      technicianId: "t_b",
      serviceDate: "2026-06-01T00:00:00.000Z",
      status: "FINALIZED",
      pdfKey: OTHER_PDF,
    });
  });

  it("allows a technician's personally authored report", async () => {
    expect(await technicianDocumentAllowed(TECH_A, OWN_PDF)).toBe(true);
  });

  it("refuses another technician's report at a SHARED customer", async () => {
    expect(await technicianDocumentAllowed(TECH_A, OTHER_PDF)).toBe(false);
  });

  it("allows report photos by report id when personally authored", async () => {
    expect(
      await technicianDocumentAllowed(
        TECH_A,
        "reports/cust_a/photos/rep_own/1.jpg"
      )
    ).toBe(true);
    expect(
      await technicianDocumentAllowed(
        TECH_A,
        "reports/cust_a/photos/rep_other/1.jpg"
      )
    ).toBe(false);
  });

  it("never allows agreements for a technician", async () => {
    expect(
      await technicianDocumentAllowed(TECH_A, "agreements/cust_a/contract.pdf")
    ).toBe(false);
  });

  it("refuses a report older than the seven-year record period", async () => {
    reports.set("rep_own", {
      ...reports.get("rep_own")!,
      serviceDate: "2018-01-01T00:00:00.000Z",
    });
    expect(await technicianDocumentAllowed(TECH_A, OWN_PDF)).toBe(false);
  });

  it("refuses everything for an inactive technician, even their own report", async () => {
    techs.set("t_a", { ...techs.get("t_a")!, active: false });
    expect(await technicianDocumentAllowed(TECH_A, OWN_PDF)).toBe(false);
  });

  it("is false for an unlinked login", async () => {
    expect(await technicianDocumentAllowed(UNLINKED, OWN_PDF)).toBe(false);
  });

  it("allows a report on a job currently assigned to the caller (live work context)", async () => {
    reports.set("rep_ctx", {
      id: "rep_ctx",
      jobId: "job_a",
      customerId: "cust_a",
      technicianId: "t_b",
      serviceDate: "2026-06-01T00:00:00.000Z",
      status: "FINALIZED",
      pdfKey: "reports/cust_a/ctx.pdf",
    });
    // job_a is currently assigned to Ana, so the prior report travels with the
    // live work context.
    expect(
      await technicianDocumentAllowed(TECH_A, "reports/cust_a/ctx.pdf")
    ).toBe(true);
    // ...but not once her licence lapses (no new customer context).
    techs.set("t_a", { ...techs.get("t_a")!, licenseExpiresOn: "2020-01-01" });
    expect(
      await technicianDocumentAllowed(TECH_A, "reports/cust_a/ctx.pdf")
    ).toBe(false);
  });
});

describe("assertCanReadJob boundaries (GL-13)", () => {
  it("refuses every read for an inactive technician with a live session", async () => {
    techs.set("t_a", { ...techs.get("t_a")!, active: false });
    await expect(
      assertCanReadJob(TECH_A, jobs.get("job_a"))
    ).rejects.toThrow(/not authorized/i);
  });

  it("limits a lapsed-licence technician to their own COMPLETED work", async () => {
    techs.set("t_a", { ...techs.get("t_a")!, licenseExpiresOn: "2020-01-01" });
    jobs.set("job_done", {
      id: "job_done",
      customerId: "cust_a",
      technicianId: "t_a",
      scheduledDate: "2026-01-10",
      status: "COMPLETED",
    });
    // Own completed work: allowed.
    await expect(
      assertCanReadJob(TECH_A, jobs.get("job_done"))
    ).resolves.toBeUndefined();
    // Own SCHEDULED (current/future) work: refused.
    jobs.set("job_a", { ...jobs.get("job_a")!, status: "SCHEDULED" });
    await expect(
      assertCanReadJob(TECH_A, jobs.get("job_a"))
    ).rejects.toThrow(/not authorized/i);
  });
});

describe("technicianForCaller", () => {
  it("resolves the Technician linked to the signed-in user", async () => {
    expect((await technicianForCaller(TECH_A))?.id).toBe("t_a");
  });

  it("is null for an unlinked login", async () => {
    expect(await technicianForCaller(UNLINKED)).toBeNull();
  });
});
