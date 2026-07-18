import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-07 — the office cancel/reschedule engine.
 *
 * The bar these hold: one guided action performs every approved consequence
 * (refund/credit computed from policy, open invoice voided, visit off its route,
 * customer notified) and records an immutable VisitChangeEvent; a partial
 * failure never reports success — it opens an owned exception and returns
 * PARTIAL; and canceling ONE visit never touches the recurring plan.
 *
 * The refund maths runs through the REAL refund + cancellationPolicy modules;
 * only the data client, email, owned-work, and receipts edges are faked.
 */

type Row = Record<string, unknown> & { id: string };

const jobs = new Map<string, Row>();
const customers = new Map<string, Row>();
const invoices = new Map<string, Row>();
const plans = new Map<string, Row>();
const routes = new Map<string, Row>();
const technicians = new Map<string, Row>();
const visitEvents: Row[] = [];

function listBy(map: Map<string, Row>, field: string, value: unknown): Row[] {
  return [...map.values()].filter((r) => r[field] === value);
}

const fakeDataClient = {
  models: {
    Job: {
      get: async ({ id }: { id: string }) => ({ data: jobs.get(id) ?? null }),
      update: async (patch: Row) => {
        if (!jobs.has(patch.id)) return { data: null, errors: [{ message: "no job" }] };
        jobs.set(patch.id, { ...jobs.get(patch.id)!, ...patch });
        return { data: jobs.get(patch.id), errors: undefined };
      },
      list: async ({ filter }: { filter?: { routeId?: { eq: string } } }) => ({
        data: filter?.routeId
          ? listBy(jobs, "routeId", filter.routeId.eq)
          : [...jobs.values()],
        nextToken: null,
      }),
    },
    Customer: {
      get: async ({ id }: { id: string }) => ({ data: customers.get(id) ?? null }),
    },
    Invoice: {
      get: async ({ id }: { id: string }) => ({ data: invoices.get(id) ?? null }),
      update: async (patch: Row) => {
        if (!invoices.has(patch.id))
          return { data: null, errors: [{ message: "no invoice" }] };
        invoices.set(patch.id, { ...invoices.get(patch.id)!, ...patch });
        return { data: invoices.get(patch.id), errors: undefined };
      },
      list: async ({ filter }: { filter?: { jobId?: { eq: string } } }) => ({
        data: filter?.jobId ? listBy(invoices, "jobId", filter.jobId.eq) : [],
        nextToken: null,
      }),
    },
    ServicePlan: {
      get: async ({ id }: { id: string }) => ({ data: plans.get(id) ?? null }),
      // Present so a test can prove canceling a visit never calls it.
      update: vi.fn(async (patch: Row) => ({ data: patch })),
    },
    Route: {
      get: async ({ id }: { id: string }) => ({ data: routes.get(id) ?? null }),
    },
    Technician: {
      get: async ({ id }: { id: string }) => ({ data: technicians.get(id) ?? null }),
    },
    VisitChangeEvent: {
      create: async (row: Row) => {
        visitEvents.push(row);
        return { data: row };
      },
    },
  },
};
vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const sendEmail = vi.fn(async () => true);
vi.mock("./email", () => ({
  sendEmail: (opts: unknown) => sendEmail(opts as never),
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
}));

const openOwnedWork = vi.fn(async () => "wk_1");
vi.mock("./ownedWork", () => ({
  openOwnedWork: (opts: unknown) => openOwnedWork(opts as never),
}));

const sendRefundNotice = vi.fn(async () => true);
vi.mock("./receipts", () => ({
  sendRefundNotice: (opts: unknown) => sendRefundNotice(opts as never),
}));

const refundsCreate = vi.fn(async () => ({ id: "re_1" }));
const fakeStripe = { refunds: { create: refundsCreate } } as never;

const { buildVisitChangePreview, cancelVisit, rescheduleVisit } = await import(
  "./visitChange"
);

// A licence date comfortably in the future so an active tech is compliant.
const FUTURE_LICENSE = "2099-12-31";
// "Today" for the policy is real-time eastern; pick visit dates relative to it.
const daysFromNow = (n: number): string => {
  const d = new Date(Date.now() + n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const OWNER = { sub: "sub-owner", email: "owner@x.com", isOwner: true };
const OFFICE = { sub: "sub-office", email: "office@x.com", isOwner: false };

function seedPaidVisit(overrides: Partial<Row> = {}) {
  jobs.set("j1", {
    id: "j1",
    customerId: "c1",
    serviceType: "Wasp nest removal",
    status: "SCHEDULED",
    scheduledDate: daysFromNow(10),
    routeId: "r1",
    technicianId: "t1",
    routeOrder: 2,
    priceCents: 15000,
    paidAt: "2026-07-10T00:00:00.000Z",
    ...overrides,
  });
  customers.set("c1", { id: "c1", displayName: "Dana", email: "dana@example.com" });
  invoices.set("inv-paid", {
    id: "inv-paid",
    jobId: "j1",
    customerId: "c1",
    description: "Wasp nest removal",
    amountCents: 15000,
    refundedAmountCents: 0,
    status: "PAID",
    stripePaymentIntentId: "pi_paid",
  });
}

beforeEach(() => {
  jobs.clear();
  customers.clear();
  invoices.clear();
  plans.clear();
  routes.clear();
  technicians.clear();
  visitEvents.length = 0;
  sendEmail.mockClear();
  sendEmail.mockImplementation(async () => true);
  openOwnedWork.mockClear();
  sendRefundNotice.mockClear();
  refundsCreate.mockClear();
  refundsCreate.mockImplementation(async () => ({ id: "re_1" }));
  fakeDataClient.models.ServicePlan.update.mockClear();
});

describe("buildVisitChangePreview", () => {
  it("shows a full refund outside the policy window and a fee inside it", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    const out = await buildVisitChangePreview("j1");
    expect(out.policy.withinFreeWindow).toBe(true);
    expect(out.decisions.cancelRefund.amountCents).toBe(15000);
    expect(out.amountPaidCents).toBe(15000);
    expect(out.planConsequence).toMatch(/one-time visit/i);

    seedPaidVisit({ scheduledDate: daysFromNow(1) });
    const late = await buildVisitChangePreview("j1");
    expect(late.policy.withinFreeWindow).toBe(false);
    expect(late.decisions.cancelRefund.amountCents).toBe(0);
    expect(late.policy.feeCents).toBe(15000);
  });

  it("says a plan visit's cancellation does not cancel the plan", async () => {
    seedPaidVisit({ servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Quarterly Pest" });
    const out = await buildVisitChangePreview("j1");
    expect(out.planConsequence).toMatch(/does NOT cancel the plan/i);
  });
});

describe("cancelVisit — money", () => {
  it("refunds in full outside the window, cancels off route, emails, records COMPLETE", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "customer moving",
      actor: OFFICE,
    });

    expect(refundsCreate).toHaveBeenCalledOnce();
    expect(res.disposition).toBe("REFUND");
    expect(res.refundedCents).toBe(15000);
    expect(res.outcome).toBe("COMPLETE");
    expect(jobs.get("j1")).toMatchObject({
      status: "CANCELED",
      routeId: null,
      technicianId: null,
    });
    expect(invoices.get("inv-paid")!.status).toBe("REFUNDED");
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(visitEvents[0]).toMatchObject({
      action: "CANCEL",
      disposition: "REFUND",
      outcome: "COMPLETE",
      actorEmail: "office@x.com",
      reason: "customer moving",
    });
  });

  it("retains the fee inside the window on CANCEL_REFUND — no card refund", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(1) });
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "late cancel",
      actor: OFFICE,
    });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(res.disposition).toBe("FEE_RETAINED");
    expect(res.refundedCents).toBe(0);
    expect(jobs.get("j1")!.status).toBe("CANCELED");
    expect(visitEvents[0]).toMatchObject({ disposition: "FEE_RETAINED" });
  });

  it("MANAGER_EXCEPTION waives the fee for an owner and refunds in full", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(1) });
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "MANAGER_EXCEPTION",
      reason: "our error",
      actor: OWNER,
    });
    expect(res.disposition).toBe("REFUND");
    expect(res.refundedCents).toBe(15000);
  });

  it("refuses MANAGER_EXCEPTION for a non-owner", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(1) });
    await expect(
      cancelVisit(fakeStripe, {
        jobId: "j1",
        decision: "MANAGER_EXCEPTION",
        reason: "waive it",
        actor: OFFICE,
      })
    ).rejects.toThrow(/only an owner/i);
    expect(jobs.get("j1")!.status).toBe("SCHEDULED");
  });

  it("CANCEL_CREDIT keeps the money as account credit and opens an owned finance task", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_CREDIT",
      reason: "customer prefers credit",
      actor: OFFICE,
    });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(res.disposition).toBe("CREDIT");
    expect(res.creditCents).toBe(15000);
    const creditTask = openOwnedWork.mock.calls.find((c) =>
      String((c[0] as { title?: string }).title).match(/account credit/i)
    );
    expect(creditTask).toBeDefined();
    expect(jobs.get("j1")!.status).toBe("CANCELED");
  });

  it("voids an open unpaid invoice and cancels an unpaid visit with no refund", async () => {
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      serviceType: "Ant treatment",
      status: "SCHEDULED",
      scheduledDate: daysFromNow(5),
      routeId: null,
      technicianId: null,
      priceCents: 12000,
      paidAt: null,
    });
    customers.set("c1", { id: "c1", displayName: "Dana", email: "dana@example.com" });
    invoices.set("inv-open", {
      id: "inv-open",
      jobId: "j1",
      customerId: "c1",
      amountCents: 12000,
      status: "OPEN",
      stripePaymentIntentId: null,
    });

    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "double booked",
      actor: OFFICE,
    });
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(res.invoiceVoided).toBe(true);
    expect(invoices.get("inv-open")!.status).toBe("VOID");
    expect(jobs.get("j1")!.status).toBe("CANCELED");
  });
});

describe("cancelVisit — fail-safe", () => {
  it("does NOT cancel when the refund fails: opens an owned case, records PARTIAL, throws", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    refundsCreate.mockImplementationOnce(async () => {
      throw new Error("card network down");
    });
    await expect(
      cancelVisit(fakeStripe, {
        jobId: "j1",
        decision: "CANCEL_REFUND",
        reason: "customer moving",
        actor: OFFICE,
      })
    ).rejects.toThrow(/refund could not be issued/i);
    // The visit is NOT canceled — no false completion.
    expect(jobs.get("j1")!.status).toBe("SCHEDULED");
    const failCase = openOwnedWork.mock.calls.find(
      (c) => (c[0] as { kind?: string }).kind === "PAID_VISIT_CANCELLATION"
    );
    expect(failCase).toBeDefined();
    expect(visitEvents.at(-1)).toMatchObject({ outcome: "PARTIAL" });
  });

  it("still cancels but reports PARTIAL when the customer notice fails", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    sendEmail.mockImplementationOnce(async () => false);
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "customer moving",
      actor: OFFICE,
    });
    expect(res.canceled).toBe(true);
    expect(res.communicationResult).toBe("FAILED");
    expect(res.outcome).toBe("PARTIAL");
    expect(jobs.get("j1")!.status).toBe("CANCELED");
  });

  it("is idempotent — a second cancel on an already-canceled visit is a no-op success", async () => {
    seedPaidVisit({ status: "CANCELED" });
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "again",
      actor: OFFICE,
    });
    expect(res.alreadyCanceled).toBe(true);
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    seedPaidVisit();
    await expect(
      cancelVisit(fakeStripe, {
        jobId: "j1",
        decision: "CANCEL_REFUND",
        reason: "  ",
        actor: OFFICE,
      })
    ).rejects.toThrow(/reason is required/i);
  });

  it("never cancels the recurring plan when canceling a plan visit", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10), servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Quarterly Pest", status: "ACTIVE" });
    await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "just this visit",
      actor: OFFICE,
    });
    expect(fakeDataClient.models.ServicePlan.update).not.toHaveBeenCalled();
    expect(plans.get("p1")!.status).toBe("ACTIVE");
  });
});

describe("rescheduleVisit", () => {
  function seedForReschedule(routeDate: string) {
    jobs.set("j1", {
      id: "j1",
      customerId: "c1",
      serviceType: "Wasp nest removal",
      status: "SCHEDULED",
      scheduledDate: daysFromNow(3),
      timeWindow: "AM",
      routeId: "r0",
      technicianId: "t1",
    });
    customers.set("c1", { id: "c1", displayName: "Dana", email: "dana@example.com" });
    technicians.set("t1", {
      id: "t1",
      name: "Marcus",
      active: true,
      licenseNumber: "APP-1",
      licenseExpiresOn: FUTURE_LICENSE,
    });
    routes.set("r-new", { id: "r-new", technicianId: "t1", date: routeDate });
  }

  it("revalidates the tech + route, moves the visit, and emails old and new details", async () => {
    const newDate = daysFromNow(9);
    seedForReschedule(newDate);
    const res = await rescheduleVisit({
      jobId: "j1",
      scheduledDate: newDate,
      technicianId: "t1",
      routeId: "r-new",
      reason: "customer request",
      actor: OFFICE,
    });
    expect(res.assignedToRoute).toBe(true);
    expect(res.newScheduledDate).toBe(newDate);
    expect(jobs.get("j1")).toMatchObject({ scheduledDate: newDate, routeId: "r-new" });
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(visitEvents[0]).toMatchObject({ action: "RESCHEDULE", outcome: "COMPLETE" });
  });

  it("refuses a route whose technician's license is expired for the new date", async () => {
    const newDate = daysFromNow(9);
    seedForReschedule(newDate);
    technicians.set("t1", {
      id: "t1",
      name: "Marcus",
      active: true,
      licenseNumber: "APP-1",
      licenseExpiresOn: "2020-01-01",
    });
    await expect(
      rescheduleVisit({
        jobId: "j1",
        scheduledDate: newDate,
        technicianId: "t1",
        routeId: "r-new",
        actor: OFFICE,
      })
    ).rejects.toThrow(/licen[sc]e/i);
    expect(jobs.get("j1")!.scheduledDate).toBe(daysFromNow(3));
  });

  it("moves the date to the pool when no technician is chosen, and notifies", async () => {
    const newDate = daysFromNow(12);
    seedForReschedule(newDate);
    const res = await rescheduleVisit({
      jobId: "j1",
      scheduledDate: newDate,
      reason: "weather",
      actor: OFFICE,
    });
    expect(res.assignedToRoute).toBe(false);
    expect(jobs.get("j1")).toMatchObject({
      scheduledDate: newDate,
      routeId: null,
      technicianId: null,
      status: "SCHEDULED",
    });
    expect(sendEmail).toHaveBeenCalledOnce();
  });
});
