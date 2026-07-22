import { dataClient } from "./dataClient";
import { customerAccessGroups } from "./dynamicGroups";
import { entryForLabel, SERVICE_CATALOG_VERSION } from "./serviceCatalog";
import {
  claimMonthForJob,
  markObligation,
  releaseMonthForJob,
} from "./obligations";
import { notePoolMinutes, onsiteMinutes, POOL_TECH } from "./capacity";
import { assignVisitToTech, pickTechDayNear } from "./assignVisit";
import {
  firstWeekdayOf,
  monthKeyAfter,
  monthKeyOf,
  nextServiceMonth,
  type SeasonalPlanFacts,
} from "./season";

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
  /** The technician who ran the completed visit — the next visit is auto-
   *  assigned back onto their schedule. */
  technicianId?: string | null;
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
    // A one-time visit never spawns a successor, even if it somehow carries a
    // plan id: billing (startBillingForPlan) already gates on RECURRING, so
    // keep scheduling in lockstep and the two can never disagree. A true
    // one-time booking has no plan at all and already returned above; this
    // guards the contradictory case.
    if (job.type && job.type !== "RECURRING") return;
    const client = await dataClient();

    const { data: plan } = await client.models.ServicePlan.get({
      id: job.servicePlanId,
    });
    if (!plan || plan.status !== "ACTIVE") return;

    // Delinquency gate: a plan whose billing has died — every dunning retry on a
    // failed subscription invoice exhausted — is suspended, not canceled. Do not
    // queue its next visit, or the recurring engine keeps dispatching a
    // technician to a customer who has stopped paying. A subsequent invoice.paid
    // clears the flag (shared/recovery clearPlanDelinquency) and service resumes.
    if (plan.delinquent) {
      console.log(
        `Skipping next-visit queue for plan ${job.servicePlanId}: plan is delinquent (billing suspended)`
      );
      return;
    }

    const seasonal = Boolean((plan as SeasonalPlanFacts).seasonal);
    const interval = FREQUENCY_DAYS[plan.serviceFrequency];
    if (!interval && !seasonal) return;

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
    let dueDate = toWeekday(addDays(base, interval || 30));
    let nextMonthKey: string | null = null;
    if (seasonal) {
      // GL-17: seasonal plans owe one treatment per in-season calendar month.
      // The completed visit SATISFIES its month (an in-season first treatment
      // counts); the next visit targets the NEXT in-season month — October
      // rolls to next April, never a November date, and a missed month is
      // never compensated with a catch-up.
      const completedMonth = monthKeyOf(job.completedAt ?? new Date().toISOString());
      await markObligation({
        servicePlanId: job.servicePlanId,
        monthKey: completedMonth,
        status: "SATISFIED",
        jobId: job.id,
        note: "Treatment completed — this calendar month's obligation is met.",
      });
      nextMonthKey = nextServiceMonth(
        plan as SeasonalPlanFacts,
        monthKeyAfter(completedMonth)
      );
      dueDate = toWeekday(firstWeekdayOf(nextMonthKey));
    }

    // GL-17: for a seasonal plan, CLAIM the target month BEFORE creating the
    // visit — the obligation row is the month's mutex, so a month that already
    // has a scheduled (or satisfied) visit refuses and no second visit is ever
    // queued into it. Idempotent for this deterministic job id.
    if (seasonal && nextMonthKey) {
      const monthClaim = await claimMonthForJob({
        servicePlanId: job.servicePlanId,
        monthKey: nextMonthKey,
        jobId: `next-${job.id}`,
        customerId: job.customerId,
        accessGroups: customerAccessGroups(
          job.customerId,
          customer?.groupId ?? undefined
        ),
      });
      if (!monthClaim.ok) {
        console.log(
          monthClaim.unavailable
            ? `scheduleNextRecurringVisit: month ledger unavailable for plan ${job.servicePlanId} — visit NOT queued (fail closed; the obligation sweep re-attempts)`
            : `scheduleNextRecurringVisit: ${nextMonthKey} already ${monthClaim.status ?? "held"} for plan ${job.servicePlanId} — no second visit queued`
        );
        return;
      }
    }
    const { data: createdNext } = await client.models.Job.create({
      // GL-15: deterministic id derived from the completed job, so the create
      // is CONDITIONAL — two concurrent finalizes (or a resumed retry) collapse
      // onto one next visit instead of both passing the scan above and creating
      // two. A conflict is already-queued success, not an error.
      id: `next-${job.id}`,
      customerId: job.customerId,
      servicePlanId: job.servicePlanId,
      type: "RECURRING",
      serviceType: plan.planName,
      // GL-01: the next visit carries the plan's immutable catalog
      // reference (resolved from the plan name for pre-catalog plans).
      serviceCode:
        (plan as { serviceCode?: string | null }).serviceCode ??
        entryForLabel(plan.planName)?.id ??
        undefined,
      catalogVersion:
        (plan as { catalogVersion?: string | null }).catalogVersion ??
        (entryForLabel(plan.planName) ? SERVICE_CATALOG_VERSION : undefined),
      // Plan-covered visits carry no per-visit price (the plan bills
      // separately); plan.priceCents is a monthly figure, not a visit price.
      priceCents: null,
      status: "UNSCHEDULED",
      scheduledDate: dueDate, // target date — office confirms the slot
      // GL-04: pool facts stamped at birth — the canonical release path
      // gives exactly these minutes back exactly once on cancel/sweep.
      capacityMinutes: onsiteMinutes(null),
      notes: `Auto-queued ${plan.serviceFrequency.toLowerCase()} visit after job ${job.id}.`,
      accessGroups: customerAccessGroups(
        job.customerId,
        customer?.groupId ?? undefined
      ),
    });
    if (!createdNext) {
      // Conflict (the deterministic id already exists) is already-queued
      // success; anything else is a REAL failure — the month claim must not
      // outlive a visit that was never born.
      const { data: existingNext } = await client.models.Job.get({
        id: `next-${job.id}`,
      });
      if (!existingNext) {
        if (seasonal && nextMonthKey) {
          await releaseMonthForJob({
            servicePlanId: job.servicePlanId,
            monthKey: nextMonthKey,
            jobId: `next-${job.id}`,
            note: "Next-visit create failed — the month claim was rolled back.",
          }).catch(() => undefined);
        }
        console.error(
          `scheduleNextRecurringVisit: Job.create failed for plan ${job.servicePlanId}`
        );
        return;
      }
    }
    // Auto-assign the queued visit onto the SAME technician who ran the
    // completed visit — picking the best-fitting day around the due date (least
    // added route travel, day not at the eight-stop ceiling), exactly the way a
    // website lead lands straight on a tech's schedule. Best-effort: if the tech
    // is full / off / unroutable across the window, or facts are missing, the
    // visit stays in the office pool (the notePoolMinutes fallback below).
    // Seasonal plans keep their pool behaviour — their month-obligation ledger,
    // not a rolling window, owns which day the next treatment lands on.
    let autoAssigned = false;
    const priorTech =
      !seasonal && job.technicianId && job.technicianId !== POOL_TECH
        ? job.technicianId
        : null;
    if (priorTech) {
      const candidateAddress = [
        customer?.serviceStreet,
        customer?.serviceCity,
        customer?.serviceState,
        customer?.serviceZip,
      ]
        .map((p) => p?.trim())
        .filter(Boolean)
        .join(", ");
      const pick = candidateAddress
        ? await pickTechDayNear({
            technicianId: priorTech,
            candidateAddress,
            fromDate: dueDate,
            // ~two working weeks of candidate days: close enough to hold the
            // cadence, wide enough to find a day the tech is already nearby.
            windowDays: 14,
            // Residential on-site default, matching this path's pool sizing.
            onsite: onsiteMinutes(null),
            routesKey: process.env.GOOGLE_ROUTES_API_KEY ?? null,
          })
        : null;
      if (pick) {
        autoAssigned = await assignVisitToTech({
          jobId: `next-${job.id}`,
          date: pick.date,
          technicianId: priorTech,
          minutes: pick.minutes,
        });
        if (autoAssigned) {
          console.log(
            `Auto-assigned next ${plan.serviceFrequency} visit for plan ${job.servicePlanId} to tech ${priorTech} on ${pick.date}`
          );
        }
      }
    }

    if (!autoAssigned) {
      // GL-04: the auto-queued visit shows on the POOL accounting slot for its
      // target day (system-created — never refused, never blocking a real
      // slot; it becomes a commitment only through the assign claim, and the
      // nightly rebuild keeps this honest).
      await notePoolMinutes(dueDate, onsiteMinutes(null)).catch(
        () => undefined
      );
      console.log(
        `Queued next ${plan.serviceFrequency} visit for plan ${job.servicePlanId} on ${dueDate}`
      );
    }
  } catch (err) {
    console.error("scheduleNextRecurringVisit failed (non-fatal)", err);
  }
}

/** Next visit's target date for a plan, for the completion email copy. A
 *  seasonal plan's next treatment is the first weekday of the next in-season
 *  month — an October completion says April, never late November. */
export function nextVisitDate(
  frequency: string,
  completedIso: string,
  plan?: SeasonalPlanFacts | null
): string | null {
  if (plan?.seasonal) {
    const next = nextServiceMonth(plan, monthKeyAfter(monthKeyOf(completedIso)));
    return toWeekday(firstWeekdayOf(next));
  }
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
