import { dataClient } from "./dataClient";
import { customerAccessGroups } from "./dynamicGroups";

/** Days between visits for each recurring frequency. */
const FREQUENCY_DAYS: Record<string, number> = {
  MONTHLY: 30,
  BIMONTHLY: 60,
  QUARTERLY: 90,
};

/** Add days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC-noon anchored). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Nudge a date onto the next weekday (Mon–Fri) — BuzzKill doesn't run weekends. */
function toWeekday(isoDate: string): string {
  let d = isoDate;
  for (let i = 0; i < 3; i++) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow >= 1 && dow <= 5) return d;
    d = addDays(d, 1);
  }
  return d;
}

type JobLike = {
  id: string;
  customerId: string;
  servicePlanId?: string | null;
  serviceType: string;
  priceCents?: number | null;
  type?: string | null;
  completedAt?: string | null;
};

/**
 * After a recurring job is completed, queue the next visit so it can never
 * fall through the cracks. The next job is created UNSCHEDULED with its due
 * date as the target, so it lands in the Schedule board's "needs scheduling"
 * pool where the office places it on the most route-efficient nearby day.
 *
 * Best-effort and self-contained: any failure is logged, never thrown, so it
 * can't block job completion. Idempotent — skips if a future job already
 * exists for the plan.
 */
export async function scheduleNextRecurringVisit(job: JobLike): Promise<void> {
  try {
    if (!job.servicePlanId) return;
    const client = await dataClient();

    const { data: plan } = await client.models.ServicePlan.get({
      id: job.servicePlanId,
    });
    if (!plan || plan.status !== "ACTIVE") return;

    const interval = FREQUENCY_DAYS[plan.serviceFrequency];
    if (!interval) return;

    // Defense in depth: never queue a visit for a deactivated customer. Their
    // deactivation already cancels the plans, so an ACTIVE plan on an INACTIVE
    // customer means one slipped through — queueing the next visit anyway would
    // put a technician on the route for someone who left. The engine reads the
    // customer for access groups below regardless; this reads it once, up front.
    const { data: customer } = await client.models.Customer.get({
      id: job.customerId,
    });
    if (customer?.status === "INACTIVE") {
      console.log(
        `Skipping next-visit queue for plan ${job.servicePlanId}: customer ${job.customerId} is INACTIVE`
      );
      return;
    }

    // Idempotency: don't double-queue if a future visit already exists.
    // Query the servicePlanId index and page fully — a filtered scan would
    // miss the sibling once the Job table grows past one page.
    const today = new Date().toISOString().slice(0, 10);
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.listJobByServicePlanId(
        { servicePlanId: job.servicePlanId },
        { nextToken: token, limit: 200 }
      );
      const hasFuture = page.data.some(
        (j) =>
          j.id !== job.id &&
          j.status !== "CANCELED" &&
          j.status !== "COMPLETED" &&
          (j.scheduledDate ?? "") >= today
      );
      if (hasFuture) return;
      token = page.nextToken;
    } while (token);

    const base = (job.completedAt ?? new Date().toISOString()).slice(0, 10);
    const dueDate = toWeekday(addDays(base, interval));

    await client.models.Job.create({
      customerId: job.customerId,
      servicePlanId: job.servicePlanId,
      type: "RECURRING",
      serviceType: plan.planName,
      // Plan-covered visits carry no per-visit price (the plan bills
      // separately); plan.priceCents is a monthly figure, not a visit price.
      priceCents: null,
      status: "UNSCHEDULED",
      scheduledDate: dueDate, // target date — office confirms the slot
      notes: `Auto-queued ${plan.serviceFrequency.toLowerCase()} visit after job ${job.id}.`,
      accessGroups: customerAccessGroups(
        job.customerId,
        customer?.groupId ?? undefined
      ),
    });
    console.log(
      `Queued next ${plan.serviceFrequency} visit for plan ${job.servicePlanId} on ${dueDate}`
    );
  } catch (err) {
    console.error("scheduleNextRecurringVisit failed (non-fatal)", err);
  }
}

/** Next visit's target date for a plan, for the completion email copy. */
export function nextVisitDate(
  frequency: string,
  completedIso: string
): string | null {
  const interval = FREQUENCY_DAYS[frequency];
  if (!interval) return null;
  return toWeekday(addDays(completedIso.slice(0, 10), interval));
}

const PRETTY = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

export const prettyDate = PRETTY;
