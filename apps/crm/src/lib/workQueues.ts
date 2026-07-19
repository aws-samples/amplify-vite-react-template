/**
 * The Dashboard's two "work the money missed" queues, as pure functions so the
 * predicates are testable without a browser. Both exist because completion is
 * automatic but collection and re-booking are not — anything these return is
 * work that happened (or billing that continues) with nobody assigned to the
 * other half.
 */

export type ChargeableJob = {
  id: string;
  type?: string | null;
  status?: string | null;
  paidAt?: string | null;
  priceCents?: number | null;
  completedAt?: string | null;
};

export type JobInvoiceLike = {
  jobId?: string | null;
  status?: string | null;
};

/**
 * Whether an invoice answers a job's money question. FAILED does not — a
 * failed charge may be retried. VOID does not — a voided invoice was withdrawn
 * as wrong, which puts the job back to never-charged. Everything else (OPEN,
 * PAID, REFUNDED) means the money was taken, is in flight, or was deliberately
 * given back; none of those jobs belong in a "charge this" queue.
 * chargeOneTimeJob enforces the same rule server-side.
 */
export const invoiceCoversJob = (status: string | null | undefined): boolean =>
  status !== "FAILED" && status !== "VOID";

/**
 * Completed one-time jobs nobody has charged: work performed, no payment at
 * booking (paidAt), and no covering invoice. Oldest completion first — the
 * longest-unpaid work is the most at risk of never being paid.
 *
 * Zero-priced jobs are excluded: there is nothing for the Charge button to
 * take, and a row with no working action trains the office to ignore the list.
 */
export function unchargedOneTimeJobs<J extends ChargeableJob>(
  jobs: J[],
  invoices: JobInvoiceLike[]
): J[] {
  const covered = new Set(
    invoices
      .filter((i) => i.jobId && invoiceCoversJob(i.status))
      .map((i) => i.jobId as string)
  );
  return jobs
    .filter(
      (j) =>
        j.type === "ONE_TIME" &&
        j.status === "COMPLETED" &&
        !j.paidAt &&
        (j.priceCents ?? 0) > 0 &&
        !covered.has(j.id)
    )
    .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
}

export type PlanVisitJob = {
  servicePlanId?: string | null;
  status?: string | null;
  scheduledDate?: string | null;
};

export type NextVisitPlan = {
  seasonal?: boolean | null;
  serviceMonths?: (number | null)[] | null;
  id: string;
  status?: string | null;
};

/**
 * ACTIVE plans with no next visit anywhere: nothing queued (UNSCHEDULED),
 * nothing on the calendar (SCHEDULED today or later), nobody on site
 * (IN_PROGRESS). A customer paying monthly with no visit coming is the
 * highest-harm state in the system — and NO_ACCESS deliberately leaves a plan
 * exactly here, so this list is how that exception becomes office work.
 */
export function plansWithoutNextVisit<P extends NextVisitPlan>(
  plans: P[],
  jobs: PlanVisitJob[],
  today: string
): P[] {
  const hasVisit = new Set(
    jobs
      .filter(
        (j) =>
          j.servicePlanId &&
          (j.status === "UNSCHEDULED" ||
            j.status === "IN_PROGRESS" ||
            (j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today))
      )
      .map((j) => j.servicePlanId as string)
  );
  // GL-17: an off-season seasonal plan legitimately has no next visit — it is
  // healthy, not broken. In season it is held to the same bar as everyone.
  const month = Number(today.slice(5, 7));
  const inSeason = (p: NextVisitPlan): boolean => {
    if (!p.seasonal) return true;
    const months =
      (p.serviceMonths ?? []).filter((m): m is number => typeof m === "number");
    return (months.length ? months : [4, 5, 6, 7, 8, 9, 10]).includes(month);
  };
  return plans.filter(
    (p) => p.status === "ACTIVE" && inSeason(p) && !hasVisit.has(p.id)
  );
}
