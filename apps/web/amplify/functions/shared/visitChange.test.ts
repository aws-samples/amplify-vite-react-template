import { beforeEach, describe, expect, it, vi } from "vitest";
import { _setLockStoreForTests, memoryLockStore } from "./atomicLock";
import { capacityFixtureModels } from "./capacityTestFixture";

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
const obligations = new Map<string, Row>();
const routes = new Map<string, Row>();
const technicians = new Map<string, Row>();
const visitEvents: Row[] = [];
/** The durable single-winner command store (id = jobId). */
const visitClaims = new Map<string, Row>();

function listBy(map: Map<string, Row>, field: string, value: unknown): Row[] {
  return [...map.values()].filter((r) => r[field] === value);
}

const capacityFixture = capacityFixtureModels();

const fakeDataClient = {
  models: {
    Job: {
      listJobByScheduledDate: async ({ scheduledDate }: { scheduledDate: string }) => ({
        data: [...jobs.values()].filter((j) => j.scheduledDate === scheduledDate),
        nextToken: null,
      }),
      // A COPY, like a real AppSync read — the CAS store mutates rows in
      // place, and a live reference would let post-publish facts leak into
      // code that captured the pre-publish job.
      get: async ({ id }: { id: string }) => ({
        data: jobs.has(id) ? { ...jobs.get(id)! } : null,
      }),
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
    TreatmentObligation: {
      create: async (input: Row) => {
        if (obligations.has(input.id as string)) return { data: null };
        obligations.set(input.id as string, { ...input });
        return { data: { ...input } };
      },
      get: async ({ id }: { id: string }) => ({
        data: obligations.has(id) ? { ...obligations.get(id)! } : null,
      }),
      update: async (input: Row) => {
        const row = obligations.get(input.id as string);
        if (!row) return { data: null };
        for (const [k, v] of Object.entries(input)) if (v !== undefined) row[k] = v;
        return { data: { ...row } };
      },
    },
    Route: {
      get: async ({ id }: { id: string }) => ({ data: routes.get(id) ?? null }),
    },
    Technician: {
      get: async ({ id }: { id: string }) => ({ data: technicians.get(id) ?? null }),
      list: async () => ({ data: [...technicians.values()], nextToken: null }),
    },
    VisitChangeEvent: {
      create: async (row: Row) => {
        visitEvents.push({ ...row, id: `vce-${visitEvents.length + 1}` });
        return { data: visitEvents.at(-1) };
      },
      list: async ({ filter }: { filter?: { jobId?: { eq: string } } }) => ({
        data: filter?.jobId
          ? visitEvents.filter((e) => e.jobId === filter.jobId!.eq)
          : [...visitEvents],
        nextToken: null,
      }),
    },
    // The durable visit-change command (id = jobId). create is conditional on the
    // id not existing — the single-winner lock the wrapper relies on.
    VisitChangeClaim: {
      get: async ({ id }: { id: string }) => ({ data: visitClaims.get(id) ?? null }),
      create: async (input: Row) => {
        if (visitClaims.has(input.id)) return { data: null };
        visitClaims.set(input.id, {
          createdAt: new Date().toISOString(),
          ...input,
        });
        return { data: visitClaims.get(input.id) };
      },
      update: async (patch: Row) => {
        const row = visitClaims.get(patch.id) ?? { id: patch.id };
        Object.assign(row, patch);
        visitClaims.set(patch.id, row);
        return { data: row };
      },
      delete: async ({ id }: { id: string }) => {
        const existed = visitClaims.get(id) ?? null;
        visitClaims.delete(id);
        return { data: existed };
      },
      list: async () => ({ data: [...visitClaims.values()], nextToken: null }),
    },
  },
};
Object.assign(fakeDataClient.models, capacityFixture.models);
vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));

const sendEmail = vi.fn(async (opts: unknown) => {
  void opts;
  return true;
});
vi.mock("./email", () => ({
  sendEmail: (opts: unknown) => sendEmail(opts),
  emailShell: (heading: string, body: string) => `${heading}\n${body}`,
}));

const openOwnedWork = vi.fn(async (opts: unknown) => {
  void opts;
  return "wk_1";
});
vi.mock("./ownedWork", () => ({
  openOwnedWork: (opts: unknown) => openOwnedWork(opts),
}));

const sendRefundNotice = vi.fn(async (opts: unknown) => {
  void opts;
  return true;
});
vi.mock("./receipts", () => ({
  sendRefundNotice: (opts: unknown) => sendRefundNotice(opts),
}));

const refundsCreate = vi.fn(async () => ({ id: "re_1" }));
const intentRetrieve = vi.fn(async () => ({ status: "succeeded" }));
const intentCancel = vi.fn(async () => ({ status: "canceled" }));
const fakeStripe = {
  refunds: { create: refundsCreate },
  paymentIntents: { retrieve: intentRetrieve, cancel: intentCancel },
} as never;

const {
  buildVisitChangePreview,
  cancelVisit,
  rescheduleVisit,
  resumeVisitChange,
} = await import("./visitChange");

// A licence date comfortably in the future so an active tech is compliant.
const FUTURE_LICENSE = "2099-12-31";
// "Today" for the policy is real-time eastern; pick visit dates relative to it.
const daysFromNow = (n: number): string => {
  // Always lands on a WEEKDAY: the capacity rule sells nothing on weekends,
  // so date fixtures roll forward off Saturday/Sunday.
  const d = new Date(Date.now() + n * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
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
  process.env.ALLOW_UNVERIFIED_ROUTES = "true";
  delete process.env.GOOGLE_ROUTES_API_KEY;
  capacityFixture.maps.capacityDays.clear();
  capacityFixture.maps.capacityClaims.clear();
  _setLockStoreForTests(
    memoryLockStore({
      VisitChangeClaim: visitClaims,
      CapacityDay: capacityFixture.maps.capacityDays,
      CapacityClaim: capacityFixture.maps.capacityClaims,
      TreatmentObligation: obligations,
      Job: jobs,
      Route: routes,
    })
  );
  obligations.clear();
  jobs.clear();
  customers.clear();
  invoices.clear();
  plans.clear();
  routes.clear();
  technicians.clear();
  visitEvents.length = 0;
  visitClaims.clear();
  sendEmail.mockClear();
  sendEmail.mockImplementation(async () => true);
  openOwnedWork.mockClear();
  sendRefundNotice.mockClear();
  refundsCreate.mockClear();
  refundsCreate.mockImplementation(async () => ({ id: "re_1" }));
  intentRetrieve.mockClear();
  intentRetrieve.mockImplementation(async () => ({ status: "succeeded" }));
  intentCancel.mockClear();
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
    expect(jobs.get("j1")!.status).toBe("CANCELED");
    // The guarded publish REMOVES cleared attributes (Dynamo REMOVE) — reads
    // surface them as null/undefined; both mean "off the route".
    expect(jobs.get("j1")!.routeId ?? null).toBeNull();
    expect(jobs.get("j1")!.technicianId ?? null).toBeNull();
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

  it("GL-07 R6: inside 72 hours NOBODY can override the no-refund result — not even an owner", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(1) });
    const res = await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "our error",
      actor: OWNER,
    });
    expect(res.disposition).toBe("FEE_RETAINED");
    expect(res.refundedCents).toBe(0);
    expect(refundsCreate).not.toHaveBeenCalled();
    expect(jobs.get("j1")!.status).toBe("CANCELED");
  });

  it("deletes the command on a clean cancel so the visit can be changed again later", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    await cancelVisit(fakeStripe, {
      jobId: "j1",
      decision: "CANCEL_REFUND",
      reason: "customer moving",
      actor: OFFICE,
    });
    expect(visitClaims.has("j1")).toBe(false);
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
      (c) => (c[0] as { kind?: string }).kind === "VISIT_CHANGE_RECOVERY"
    );
    expect(failCase).toBeDefined();
    expect(visitEvents.at(-1)).toMatchObject({ outcome: "PARTIAL" });
    // R1/R2: the command is KEPT (not deleted) so the sweep/retry can resume it.
    expect(visitClaims.has("j1")).toBe(true);
    expect(visitClaims.get("j1")).toMatchObject({ stage: "REQUESTED" });
  });

  it("a resumed cancel that finds the visit COMPLETED stops, owns the money conflict, and never flips it", async () => {
    // The cancel stalled after its refund; meanwhile the technician finished
    // the visit. The resume must NOT cancel the completed, billed record.
    seedPaidVisit({ status: "COMPLETED", scheduledDate: daysFromNow(1) });
    visitClaims.set("j1", {
      id: "j1",
      action: "CANCEL",
      stage: "MONEY_DONE",
      decision: "CANCEL_REFUND",
      reason: "customer moving",
      requestedAt: new Date().toISOString(),
      attemptCount: 1,
    });
    const res = await resumeVisitChange(fakeStripe, "j1", { auto: false });
    if (res.action !== "CANCEL") throw new Error("expected a cancel outcome");
    expect(res.outcome).toBe("FAILED");
    expect(res.canceled).toBe(false);
    expect(jobs.get("j1")!.status).toBe("COMPLETED");
    // Finance owns reconciling the refund-vs-performed-work conflict.
    const conflict = openOwnedWork.mock.calls.find((c) =>
      String((c[0] as { dedupeKey?: string }).dedupeKey ?? "").startsWith(
        "completed-after-cancel:"
      )
    );
    expect(conflict).toBeDefined();
    // The command is settled — the sweep will not re-drive it forever.
    expect(visitClaims.has("j1")).toBe(false);
  });

  it("resumes a stuck cancel from the recorded stage and never refunds twice", async () => {
    seedPaidVisit({ scheduledDate: daysFromNow(10) });
    // First attempt: refund succeeds, but the CANCELED flip fails (the
    // guarded publish loses its lock store) → command kept.
    const fullStore = () =>
      memoryLockStore({
        VisitChangeClaim: visitClaims,
        CapacityDay: capacityFixture.maps.capacityDays,
        CapacityClaim: capacityFixture.maps.capacityClaims,
        TreatmentObligation: obligations,
        Job: jobs,
        Route: routes,
      });
    _setLockStoreForTests(
      memoryLockStore({
        VisitChangeClaim: visitClaims,
        CapacityDay: capacityFixture.maps.capacityDays,
        CapacityClaim: capacityFixture.maps.capacityClaims,
        TreatmentObligation: obligations,
        // No Job wiring: the CANCELED flip fails closed, exactly like a
        // refused conditional write.
      })
    );
    await expect(
      cancelVisit(fakeStripe, {
        jobId: "j1",
        decision: "CANCEL_REFUND",
        reason: "customer moving",
        actor: OFFICE,
      })
    ).rejects.toThrow(/could not be canceled/i);
    expect(refundsCreate).toHaveBeenCalledOnce();
    expect(visitClaims.get("j1")).toMatchObject({ stage: "MONEY_DONE" });
    // The invoice is now REFUNDED, so a re-refund would throw — the resume must
    // skip the money step. Restore the flip and resume.
    _setLockStoreForTests(fullStore());
    const res = await resumeVisitChange(fakeStripe, "j1", { auto: false });
    if (res.action !== "CANCEL") throw new Error("expected a cancel outcome");
    expect(res.outcome).toBe("COMPLETE");
    expect(res.refundedCents).toBe(15000);
    // Still only ONE refund across the whole flow (R2: never twice).
    expect(refundsCreate).toHaveBeenCalledOnce();
    expect(jobs.get("j1")!.status).toBe("CANCELED");
    expect(visitClaims.has("j1")).toBe(false);
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

  it("GL-07: the day's LAST STOP cannot be double-taken — the loser gets a plain refusal and holds nothing", async () => {
    const newDate = daysFromNow(9);
    seedForReschedule(newDate);
    // The technician's day already carries the full stop count (as a
    // concurrent winner would leave it) — this move must refuse atomically.
    const stopRow = `stops#${newDate}#t1`;
    capacityFixture.maps.capacityDays.set(stopRow, {
      id: stopRow,
      technicianId: "t1",
      committedStops: 8,
      verified: true,
    });

    await expect(
      rescheduleVisit({
        jobId: "j1",
        scheduledDate: newDate,
        technicianId: "t1",
        routeId: "r-new",
        reason: "customer request",
        actor: OFFICE,
      })
    ).rejects.toThrow(/day is full \(8 stops\)/);
    // Nothing moved, nothing held: the counter is untouched and the visit
    // stays where it was.
    expect(
      capacityFixture.maps.capacityDays.get(stopRow)!.committedStops
    ).toBe(8);
    expect(jobs.get("j1")!.routeId).not.toBe("r-new");
  });

  it("GL-07: a successful move claims one stop on the new day and releases the old day's stop", async () => {
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
    expect(
      capacityFixture.maps.capacityDays.get(`stops#${newDate}#t1`)!
        .committedStops
    ).toBe(1);
  });

  it("GL-17: a cross-month reschedule claims the target month and releases the prior month", async () => {
    seedForReschedule("2026-09-10");
    jobs.set("j1", { ...jobs.get("j1")!, scheduledDate: "2026-08-05", servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Mosquito", seasonal: true });
    obligations.set("p1#2026-08", {
      id: "p1#2026-08",
      servicePlanId: "p1",
      monthKey: "2026-08",
      status: "SCHEDULED",
      jobId: "j1",
    });
    const res = await rescheduleVisit({
      jobId: "j1",
      scheduledDate: "2026-09-10",
      technicianId: "t1",
      routeId: "r-new",
      reason: "customer request",
      actor: OFFICE,
    });
    expect(res.assignedToRoute).toBe(true);
    expect(obligations.get("p1#2026-09")).toMatchObject({
      status: "SCHEDULED",
      jobId: "j1",
    });
    // The prior month is owed again — not stranded SCHEDULED forever.
    expect(obligations.get("p1#2026-08")).toMatchObject({ status: "DUE" });
  });

  it("GL-17: refuses to move a seasonal visit into a month another visit already holds", async () => {
    seedForReschedule("2026-09-10");
    jobs.set("j1", { ...jobs.get("j1")!, scheduledDate: "2026-08-05", servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Mosquito", seasonal: true });
    obligations.set("p1#2026-09", {
      id: "p1#2026-09",
      servicePlanId: "p1",
      monthKey: "2026-09",
      status: "SCHEDULED",
      jobId: "OTHER-JOB",
    });
    await expect(
      rescheduleVisit({
        jobId: "j1",
        scheduledDate: "2026-09-10",
        technicianId: "t1",
        routeId: "r-new",
        reason: "customer request",
        actor: OFFICE,
      })
    ).rejects.toThrow(/already has its 2026-09 visit/);
    // Nothing moved, and the holder kept its month.
    expect(jobs.get("j1")).toMatchObject({ scheduledDate: "2026-08-05" });
    expect(obligations.get("p1#2026-09")).toMatchObject({ jobId: "OTHER-JOB" });
  });

  it("GL-17: refuses an off-season date for a seasonal plan", async () => {
    seedForReschedule("2026-11-10");
    jobs.set("j1", { ...jobs.get("j1")!, scheduledDate: "2026-08-05", servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Mosquito", seasonal: true });
    await expect(
      rescheduleVisit({
        jobId: "j1",
        scheduledDate: "2026-11-10",
        technicianId: "t1",
        routeId: "r-new",
        reason: "customer request",
        actor: OFFICE,
      })
    ).rejects.toThrow(/April–October/);
    expect(jobs.get("j1")).toMatchObject({ scheduledDate: "2026-08-05" });
  });

  it("GL-17: a publish against a STALE schedule read loses — the ledger is never clobbered", async () => {
    seedForReschedule("2026-09-10");
    jobs.set("j1", { ...jobs.get("j1")!, scheduledDate: "2026-08-05", servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Mosquito", seasonal: true });
    // Simulate a concurrent mover landing between this attempt's read and its
    // publish: the read returns an OLD date while the stored row has moved on.
    const origGet = fakeDataClient.models.Job.get;
    (fakeDataClient.models.Job as unknown as { get: unknown }).get = async ({
      id,
    }: {
      id: string;
    }) => {
      const row = jobs.get(id);
      return {
        data: row ? { ...row, scheduledDate: "2026-07-06" } : null,
      };
    };
    try {
      await expect(
        rescheduleVisit({
          jobId: "j1",
          scheduledDate: "2026-09-10",
          technicianId: "t1",
          routeId: "r-new",
          reason: "customer request",
          actor: OFFICE,
        })
      ).rejects.toThrow(/changed while rescheduling/);
    } finally {
      (fakeDataClient.models.Job as unknown as { get: unknown }).get = origGet;
    }
    // The stored row was NOT clobbered by the stale publish, and the month
    // claimed for the failed move was rolled back.
    expect(jobs.get("j1")).toMatchObject({ scheduledDate: "2026-08-05" });
    expect(obligations.get("p1#2026-09")?.jobId ?? null).not.toBe("j1");
  });

  it("GL-17: a month claimed for a move that fails validation is rolled back", async () => {
    seedForReschedule("2026-09-10");
    jobs.set("j1", { ...jobs.get("j1")!, scheduledDate: "2026-08-05", servicePlanId: "p1" });
    plans.set("p1", { id: "p1", planName: "Mosquito", seasonal: true });
    // The route belongs to a DIFFERENT technician — validation fails AFTER
    // the month claim is taken.
    routes.set("r-new", { id: "r-new", technicianId: "someone-else", date: "2026-09-10" });
    await expect(
      rescheduleVisit({
        jobId: "j1",
        scheduledDate: "2026-09-10",
        technicianId: "t1",
        routeId: "r-new",
        reason: "customer request",
        actor: OFFICE,
      })
    ).rejects.toThrow(/doesn't belong/);
    // The claimed target month was rolled back — not stranded on j1.
    const sept = obligations.get("p1#2026-09");
    expect(sept?.jobId ?? null).not.toBe("j1");
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
        reason: "customer request",
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
    // GL-07 R4: a dated move with no technician is NOT published as a clean
    // SCHEDULED — it stays visibly pending assignment with a CONFIRMED owned
    // staffing case, and the notice promises confirmation, not a set time.
    expect(jobs.get("j1")).toMatchObject({
      scheduledDate: newDate,
      status: "UNSCHEDULED",
    });
    expect(jobs.get("j1")!.routeId ?? null).toBeNull();
    expect(jobs.get("j1")!.technicianId ?? null).toBeNull();
    expect(openOwnedWork).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "UNSTAFFED_VISIT" })
    );
    expect(sendEmail).toHaveBeenCalledOnce();
    const [mail] = sendEmail.mock.calls[0] as unknown as [{ html: string }];
    expect(mail.html).toMatch(/we'll confirm your appointment/i);
  });
});
