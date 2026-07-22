import { describe, expect, it } from "vitest";
import {
  invoiceCoversJob,
  plansWithoutNextVisit,
  unchargedOneTimeJobs,
  type ChargeableJob,
  type NextVisitPlan,
  type PlanVisitJob,
} from "./workQueues";

/**
 * R04 / R06: the two Dashboard queues that stop "All caught up" from being a
 * lie. Completion is automatic; charging a one-time job and re-booking a plan
 * visit are not, and until these lists existed neither gap appeared anywhere.
 */

let seq = 0;
const job = (over: Partial<ChargeableJob> = {}): ChargeableJob => ({
  id: `j${++seq}`,
  type: "ONE_TIME",
  status: "COMPLETED",
  paidAt: null,
  priceCents: 29900,
  completedAt: "2026-07-10T15:00:00.000Z",
  ...over,
});

describe("invoiceCoversJob", () => {
  it("treats OPEN, PAID and REFUNDED as answering the money question", () => {
    expect(invoiceCoversJob("OPEN")).toBe(true);
    expect(invoiceCoversJob("PAID")).toBe(true);
    expect(invoiceCoversJob("REFUNDED")).toBe(true);
  });

  it("treats FAILED and VOID as leaving the job unpaid", () => {
    // A failed charge may be retried; a voided invoice was withdrawn as wrong.
    expect(invoiceCoversJob("FAILED")).toBe(false);
    expect(invoiceCoversJob("VOID")).toBe(false);
  });
});

describe("unchargedOneTimeJobs", () => {
  it("lists a completed one-time job with no invoice at all", () => {
    const j = job();
    expect(unchargedOneTimeJobs([j], [])).toEqual([j]);
  });

  it("drops a job paid up front at online booking", () => {
    expect(
      unchargedOneTimeJobs([job({ paidAt: "2026-07-01T00:00:00.000Z" })], [])
    ).toHaveLength(0);
  });

  it("drops a job covered by a PAID or OPEN invoice", () => {
    const j = job();
    expect(
      unchargedOneTimeJobs([j], [{ jobId: j.id, status: "PAID" }])
    ).toHaveLength(0);
    expect(
      unchargedOneTimeJobs([j], [{ jobId: j.id, status: "OPEN" }])
    ).toHaveLength(0);
  });

  it("drops a job whose charge was deliberately refunded", () => {
    // Refunding is a decision with a reason; re-listing the job would prompt
    // re-charging a customer someone chose to give the money back to.
    const j = job();
    expect(
      unchargedOneTimeJobs([j], [{ jobId: j.id, status: "REFUNDED" }])
    ).toHaveLength(0);
  });

  it("keeps a job whose only invoice FAILED — the work is still unpaid", () => {
    const j = job();
    expect(
      unchargedOneTimeJobs([j], [{ jobId: j.id, status: "FAILED" }])
    ).toEqual([j]);
  });

  it("keeps a job whose only invoice was voided — withdrawn means never charged", () => {
    const j = job();
    expect(
      unchargedOneTimeJobs([j], [{ jobId: j.id, status: "VOID" }])
    ).toEqual([j]);
  });

  it("ignores an invoice for a different job", () => {
    const j = job();
    expect(
      unchargedOneTimeJobs([j], [{ jobId: "other", status: "PAID" }])
    ).toEqual([j]);
  });

  it("ignores recurring plan visits — the subscription bills those", () => {
    expect(
      unchargedOneTimeJobs([job({ type: "RECURRING" })], [])
    ).toHaveLength(0);
  });

  it("ignores jobs that are not completed", () => {
    for (const status of ["SCHEDULED", "UNSCHEDULED", "IN_PROGRESS", "NO_ACCESS", "CANCELED"]) {
      expect(unchargedOneTimeJobs([job({ status })], [])).toHaveLength(0);
    }
  });

  it("ignores zero-priced jobs — a Charge button with nothing to take is a dead end", () => {
    expect(unchargedOneTimeJobs([job({ priceCents: 0 })], [])).toHaveLength(0);
    expect(unchargedOneTimeJobs([job({ priceCents: null })], [])).toHaveLength(0);
  });

  it("orders the longest-unpaid work first", () => {
    const older = job({ completedAt: "2026-07-01T09:00:00.000Z" });
    const newer = job({ completedAt: "2026-07-12T09:00:00.000Z" });
    expect(unchargedOneTimeJobs([newer, older], []).map((j) => j.id)).toEqual([
      older.id,
      newer.id,
    ]);
  });
});

const plan = (over: Partial<NextVisitPlan> = {}): NextVisitPlan => ({
  id: `p${++seq}`,
  status: "ACTIVE",
  ...over,
});
const visit = (
  planId: string,
  over: Partial<PlanVisitJob> = {}
): PlanVisitJob => ({
  servicePlanId: planId,
  status: "SCHEDULED",
  scheduledDate: "2026-07-20",
  ...over,
});

const TODAY = "2026-07-16";

describe("plansWithoutNextVisit", () => {
  it("flags an active plan with no jobs at all", () => {
    const p = plan();
    expect(plansWithoutNextVisit([p], [], TODAY)).toEqual([p]);
  });

  it("flags a plan whose only visit ended NO_ACCESS", () => {
    // The honest tech exit queues nothing — this list is where that visit
    // becomes office work instead of silence.
    const p = plan();
    expect(
      plansWithoutNextVisit([p], [visit(p.id, { status: "NO_ACCESS" })], TODAY)
    ).toEqual([p]);
  });

  it("flags a plan whose visits are all completed or canceled", () => {
    const p = plan();
    const jobs = [
      visit(p.id, { status: "COMPLETED" }),
      visit(p.id, { status: "CANCELED" }),
    ];
    expect(plansWithoutNextVisit([p], jobs, TODAY)).toEqual([p]);
  });

  it("flags a plan whose only scheduled visit is in the past — nobody is coming", () => {
    const p = plan();
    expect(
      plansWithoutNextVisit(
        [p],
        [visit(p.id, { scheduledDate: "2026-07-10" })],
        TODAY
      )
    ).toEqual([p]);
  });

  it("stays quiet about a plan with a future scheduled visit", () => {
    const p = plan();
    expect(
      plansWithoutNextVisit([p], [visit(p.id, { scheduledDate: "2026-08-01" })], TODAY)
    ).toHaveLength(0);
  });

  it("counts a visit scheduled today as a next visit", () => {
    const p = plan();
    expect(
      plansWithoutNextVisit([p], [visit(p.id, { scheduledDate: TODAY })], TODAY)
    ).toHaveLength(0);
  });

  it("counts a queued (UNSCHEDULED) visit — it is in the pool, not lost", () => {
    const p = plan();
    expect(
      plansWithoutNextVisit(
        [p],
        [visit(p.id, { status: "UNSCHEDULED", scheduledDate: null })],
        TODAY
      )
    ).toHaveLength(0);
  });

  it("counts a tech on site right now (IN_PROGRESS) as a visit", () => {
    const p = plan();
    expect(
      plansWithoutNextVisit(
        [p],
        [visit(p.id, { status: "IN_PROGRESS", scheduledDate: null })],
        TODAY
      )
    ).toHaveLength(0);
  });

  it("ignores paused and canceled plans", () => {
    expect(
      plansWithoutNextVisit(
        [plan({ status: "PAUSED" }), plan({ status: "CANCELED" })],
        [],
        TODAY
      )
    ).toHaveLength(0);
  });

  it("does not let another plan's visit cover this one", () => {
    const p = plan();
    expect(plansWithoutNextVisit([p], [visit("other-plan")], TODAY)).toEqual([p]);
  });
});
