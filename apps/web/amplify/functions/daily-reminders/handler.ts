import { dataClient } from "../shared/dataClient";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import { licenseFactsFor } from "../shared/licenses";
import { ensureObligation, markObligation } from "../shared/obligations";
import { isServiceMonth, monthKeyOf } from "../shared/season";
import { assertDispatchFacts } from "../shared/dispatchReadiness";
import { stripeClient } from "../shared/stripeClient";
import { resumePlanCancellation } from "../shared/planCancellation";
import { resumeVisitChange } from "../shared/visitChange";
import {
  sendInvoiceReminder,
  sendPaymentFailedNotice,
} from "../shared/receipts";
import {
  AGING_BUCKET_LABEL,
  AGING_BUCKET_ORDER,
  type AgingBucket,
  agingBucket,
  daysPastDue,
  MAX_DUNNING_ATTEMPTS,
  nextDunningAtIso,
  settleInvoiceOnCard,
  queuePresenceReview,
} from "../shared/recovery";
import {
  defaultWorkOwner,
  openMissingContactWork,
  openOwnedWork,
  resolveOwnedWork,
} from "../shared/ownedWork";
import {
  danglingChildRecords,
  reconcileBookings,
  type ReconBooking,
  type ReconInvoice,
  mismatchedChildRelationships,
  type ChildRows,
} from "../shared/bookingReconcile";
import {
  isLeadActionOverdue,
  isLeadOpen,
  staleLeadReason,
} from "../shared/leadStage";

type OwedInvoice = {
  id: string;
  customerId: string;
  servicePlanId?: string | null;
  amountCents: number;
  description?: string | null;
  status: string | null;
  issuedAt?: string | null;
  dueDate?: string | null;
  dunningAttempts?: number | null;
  nextDunningAt?: string | null;
  ownerEmail?: string | null;
  /** Present on subscription invoices — those are dunned by Stripe, not us. */
  stripeInvoiceId?: string | null;
};

/** Page an Invoice status-index query fully. */
async function allInvoicesByStatus(
  status: "OPEN" | "FAILED" | "PAID" | "DRAFT" | "VOID" | "REFUNDED"
): Promise<OwedInvoice[]> {
  const client = await dataClient();
  const rows: OwedInvoice[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Invoice.listInvoiceByStatusAndIssuedAt(
      { status },
      { nextToken, limit: 200 }
    );
    rows.push(...(page.data as OwedInvoice[]));
    nextToken = page.nextToken;
  } while (nextToken);
  return rows;
}

/** How many days before dueDate a due-soon reminder fires. */
const DUE_SOON_LEAD_DAYS = 3;

/** Days before evidenceDueBy a dispute-deadline alert fires. */
const DISPUTE_ALERT_LEAD_DAYS = 4;

/** Date N days from now (YYYY-MM-DD) in the shop's timezone. */
function easternPlusDays(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toLocaleDateString(
    "en-CA",
    { timeZone: "America/New_York" }
  );
}

const prettyDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

export const handler = async () => {
  const totals: Record<string, unknown>[] = [];
  // Do this first: an unrelated reminder failure must not stop an already
  // overdue obligation from reaching its escalation path.
  const overdueWork = await escalateOverdueOwnedWork();
  // T-1 and T-7 reminders — the cron runs once a day, so each fires once.
  // Only T-1 gets the staffing gate: a week out, most visits legitimately
  // aren't routed yet, but by the day before every dated job must be on an
  // active technician's route or the office is told.
  for (const [daysOut, phrasing] of [
    [1, "tomorrow"],
    [7, "in one week"],
  ] as const) {
    totals.push(await remind(easternPlusDays(daysOut), phrasing, daysOut === 1));
  }
  const notBilling = await reportPlansNotBilling();
  const uncharged = await reportUnchargedOneTimeJobs();
  const noNextVisit = await reportPlansWithoutNextVisit();
  // Money-out recovery lifecycle.
  const dunning = await runDunningRetries();
  const invoiceReminders = await remindOpenInvoices();
  const aging = await reportArAging();
  const disputes = await reportDisputeDeadlines();
  // GL-05: prove, against the real tables and Stripe, that every succeeded
  // booking payment has exactly one complete booking and vice versa.
  const reconciliation = await reconcilePaidBookings();
  // GL-08: resume every plan cancellation a prior attempt could not finish, so
  // an accepted cancel can never sit Pending forever with billing still live.
  const cancellations = await reconcilePlanCancellations();
  // GL-07: resume every office visit cancel a prior attempt could not finish, so
  // a refunded-but-still-scheduled visit is never stranded.
  const visitChanges = await reconcileVisitChanges();
  // GL-02: no lead may silently go cold — surface every open lead whose next
  // action is overdue as an owned follow-up, routed to its owner or the team.
  const staleLeads = await reportStaleLeads();
  // GL-15: a FLAGGED presence review whose owned case never landed is re-opened
  // here — the obligation is durable on the report and cannot silently vanish.
  const presenceReviews = await reconcilePresenceReviews();
  // GL-17: advance licence-lapse work + capacity effects of expiry.
  const licenses = await sweepLicenseLapses();
  // GL-09: stale lifecycle commands (a process stop mid-transition) are
  // escalated to owned work and stale claims reclaimed — a customer can never
  // be stuck mid-transition silently or blocked forever.
  const lifecycle = await reconcileLifecycleTransitions();
  // GL-12: tomorrow's staffed visits must pass the pure dispatch facts — a
  // missing classification or placeholder address is owned work today, not a
  // doorstep discovery tomorrow.
  const readiness = await sweepDispatchReadiness();
  // GL-17: seasonal obligations — month rollover marks missed months (no
  // catch-up) and ensures the current in-season month is visible.
  const seasonal = await sweepSeasonalObligations();
  console.log("Reminder totals:", JSON.stringify(totals));
  return [
    ...totals,
    notBilling,
    uncharged,
    noNextVisit,
    dunning,
    invoiceReminders,
    aging,
    disputes,
    overdueWork,
    reconciliation,
    cancellations,
    visitChanges,
    staleLeads,
    presenceReviews,
    licenses,
    seasonal,
    readiness,
    lifecycle,
  ];
};

/**
 * GL-09 — the lifecycle resume worker. Every non-terminal
 * CustomerLifecycleCommand whose lease has expired is a transition a process
 * stop abandoned: each gets (or re-escalates) an owned LIFECYCLE_RECOVERY case
 * whose safe resume is re-running the idempotent transition from the customer
 * screen; stale per-customer claims are reclaimed by the claim engine itself.
 * The pass PAGES (owned work), never merely logs.
 */
export async function reconcileLifecycleTransitions() {
  const client = await dataClient();
  if (!("CustomerLifecycleCommand" in client.models)) {
    return { task: "reconcile-lifecycle" as const, stale: 0, escalated: 0 };
  }
  let stale = 0;
  let escalated = 0;
  try {
    const now = Date.now();
    let token: string | null | undefined;
    do {
      const page = await client.models.CustomerLifecycleCommand.list({
        limit: 200,
        nextToken: token,
      });
      for (const cmd of page.data ?? []) {
        if (cmd.stage === "COMPLETE" || cmd.stage === "FAILED") continue;
        const leaseExpired =
          !cmd.leaseUntil || Date.parse(cmd.leaseUntil) < now;
        if (!leaseExpired) continue;
        stale++;
        const opened = await openOwnedWork({
          kind: "LIFECYCLE_RECOVERY",
          dedupeKey: `lifecycle-command:${cmd.id}`,
          title: `A customer ${cmd.action.toLowerCase()} is stuck mid-transition`,
          detail: `Command ${cmd.id} for customer ${cmd.customerId} stopped at stage ${cmd.stage}${cmd.lastError ? ` (${cmd.lastError})` : ""}. Billing, schedule, access, status, audit, or the customer notice may be part-done.`,
          customerId: cmd.customerId,
          relatedId: cmd.customerId,
          sourceUrl: `/customers/${cmd.customerId}`,
          resolutionAction: `Open the customer and re-run the ${cmd.action === "DEACTIVATE" ? "deactivation" : "reactivation"} — it is idempotent and resumes from the last confirmed step — then confirm the command reads COMPLETE.`,
          ownerTeam: "OPS",
        });
        if (opened) escalated++;
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("reconcileLifecycleTransitions failed", err);
  }
  return { task: "reconcile-lifecycle" as const, stale, escalated };
}

/**
 * GL-12 — day-before dispatch readiness. Every SCHEDULED visit dated tomorrow
 * is re-checked against the pure dispatch facts (routable-shaped MA/RI
 * address, no placeholders, explicit property classification). Failures open
 * owned DISPATCH_NOT_READY work with the exact office fix named; the verified
 * close re-runs the same checks.
 */
export async function sweepDispatchReadiness() {
  const client = await dataClient();
  if (!("Job" in client.models)) {
    return { task: "dispatch-readiness" as const, checked: 0, notReady: 0 };
  }
  let checked = 0;
  let notReady = 0;
  try {
    const tomorrow = easternPlusDays(1);
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.listJobByScheduledDate(
        { scheduledDate: tomorrow },
        { limit: 200, nextToken: token }
      );
      for (const job of page.data ?? []) {
        if (job.status !== "SCHEDULED") continue;
        checked++;
        const { data: customer } = await client.models.Customer.get({
          id: job.customerId,
        });
        try {
          assertDispatchFacts(customer ?? {}, {
            propertyClass: job.propertyClass,
            serviceType: job.serviceType,
          });
        } catch (err) {
          notReady++;
          await openOwnedWork({
            kind: "DISPATCH_NOT_READY",
            dedupeKey: `dispatch-ready:${job.id}`,
            title: `Tomorrow's visit isn't dispatch-ready: ${customer?.displayName ?? job.customerId}`,
            detail:
              err instanceof Error ? err.message : "The dispatch facts are incomplete.",
            customerId: job.customerId,
            relatedId: job.id,
            sourceUrl: `/customers/${job.customerId}`,
            resolutionAction:
              "Fix the named facts on the customer/visit, then confirm the visit is dispatch-ready (or reschedule it with the customer).",
            ownerTeam: "OPS",
          });
        }
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("sweepDispatchReadiness failed", err);
  }
  return { task: "dispatch-readiness" as const, checked, notReady };
}

/** GL-17 — licences expiring within this many days open advance owned work. */
const LICENSE_WARN_DAYS = 30;

/**
 * GL-17 — the daily licence sweep. For every ACTIVE technician:
 *  - licence expiring within LICENSE_WARN_DAYS → advance LICENSE_LAPSE work
 *    ("renew or plan reassignment") so customers move before service dates;
 *  - licence already lapsed → LICENSE_LAPSE plus one UNSTAFFED_VISIT case per
 *    future SCHEDULED visit still assigned to them. Visits are NOT silently
 *    unassigned — the office decides — but capacity everywhere else already
 *    excludes the technician (availability, assignment, T-1 staffing).
 */
export async function sweepLicenseLapses() {
  const client = await dataClient();
  if (!("Technician" in client.models)) {
    return { task: "license-lapses" as const, warned: 0, lapsed: 0, visitsFlagged: 0 };
  }
  let warned = 0;
  let lapsed = 0;
  let visitsFlagged = 0;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const warnDate = new Date(Date.now() + LICENSE_WARN_DAYS * 86400_000)
      .toISOString()
      .slice(0, 10);
    let token: string | null | undefined;
    do {
      const page = await client.models.Technician.list({
        limit: 200,
        nextToken: token,
      });
      for (const tech of page.data ?? []) {
        if (!tech.active) continue;
        const factsNow = await licenseFactsFor(tech, today);
        const factsAtWarn = await licenseFactsFor(tech, warnDate);
        // A records READ FAILURE is not a lapse: enforcement (dispatch,
        // capacity, reads) already fails closed on ERROR — fabricating a
        // "licence lapsed" case out of an outage would be a false record.
        if (factsNow.source === "ERROR" || factsAtWarn.source === "ERROR") {
          continue;
        }
        if (factsNow.current && factsAtWarn.current) continue;
        const expiresOn = factsNow.expiresOn ?? "unknown";
        if (factsNow.current && !factsAtWarn.current) {
          warned++;
          await openOwnedWork({
            kind: "LICENSE_LAPSE",
            dedupeKey: `license-lapse:${tech.id}:${factsNow.expiresOn ?? "none"}`,
            title: `${tech.name}'s applicator licence expires ${expiresOn}`,
            detail: `${tech.name}'s licence is current today but expires ${expiresOn} — within ${LICENSE_WARN_DAYS} days. From that date they contribute no capacity and cannot be assigned. Renew the licence on file, or plan reassignment of their later visits now.`,
            relatedId: tech.id,
            sourceUrl: "/schedule",
            resolutionAction:
              "Record the renewed licence (technician's licence records), or reassign their visits past the expiry date — then confirm.",
            ownerTeam: "OPS",
          });
          continue;
        }
        // Already lapsed.
        lapsed++;
        await openOwnedWork({
          kind: "LICENSE_LAPSE",
          dedupeKey: `license-lapse:${tech.id}:lapsed`,
          title: `${tech.name} has no current applicator licence`,
          detail: `${tech.name} is active but holds no current licence record. They contribute no capacity, cannot be assigned, and their remaining future visits must be reassigned.`,
          relatedId: tech.id,
          sourceUrl: "/schedule",
          resolutionAction:
            "Record a current licence, or reassign their future visits and offboard/deactivate — then confirm.",
          ownerTeam: "OPS",
        });
        let jobToken: string | null | undefined;
        do {
          const jobsPage = await client.models.Job.list({
            filter: { technicianId: { eq: tech.id } },
            limit: 200,
            nextToken: jobToken,
          });
          for (const job of jobsPage.data ?? []) {
            if (job.status !== "SCHEDULED" || (job.scheduledDate ?? "") < today) {
              continue;
            }
            visitsFlagged++;
            await openOwnedWork({
              kind: "UNSTAFFED_VISIT",
              dedupeKey: `license-unstaffed:${job.id}`,
              title: `Visit assigned to an unlicensed technician: ${tech.name}`,
              detail: `Visit ${job.id} (${job.scheduledDate ?? "undated"}) is assigned to ${tech.name}, who has no current applicator licence. It cannot legally happen as scheduled — reassign or reschedule it with the customer.`,
              customerId: job.customerId,
              relatedId: job.id,
              sourceUrl: "/schedule",
              resolutionAction:
                "Reassign the visit to a licensed technician (or reschedule/cancel it with the customer), then confirm it is staffed.",
              ownerTeam: "OPS",
            });
          }
          jobToken = jobsPage.nextToken;
        } while (jobToken);
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("sweepLicenseLapses failed", err);
  }
  return { task: "license-lapses" as const, warned, lapsed, visitsFlagged };
}

/**
 * GL-17 — seasonal obligations bookkeeping. For every ACTIVE seasonal plan:
 *  - ensure the current in-season month's obligation row exists (visible DUE);
 *  - mark every PAST in-season month that never reached SATISFIED as
 *    SKIPPED_MISSED — durable history, and per the locked rule it creates NO
 *    catch-up visit.
 */
export async function sweepSeasonalObligations() {
  const client = await dataClient();
  if (!("ServicePlan" in client.models) || !("TreatmentObligation" in client.models)) {
    return { task: "seasonal-obligations" as const, ensured: 0, skipped: 0 };
  }
  let ensured = 0;
  let skipped = 0;
  try {
    const nowMonth = monthKeyOf(new Date().toISOString());
    let token: string | null | undefined;
    do {
      const page = await client.models.ServicePlan.list({
        filter: { status: { eq: "ACTIVE" } },
        limit: 200,
        nextToken: token,
      });
      for (const plan of page.data ?? []) {
        if (!plan.seasonal) continue;
        // Current month, when in season, is a visible obligation.
        if (isServiceMonth(plan, nowMonth)) {
          const { created } = await ensureObligation({
            servicePlanId: plan.id,
            customerId: plan.customerId,
            monthKey: nowMonth,
            accessGroups: plan.accessGroups?.filter(
              (g): g is string => typeof g === "string"
            ),
          });
          if (created) ensured++;
        }
        // Past months that never reached SATISFIED become SKIPPED_MISSED.
        const { data: obligations } =
          await client.models.TreatmentObligation.listTreatmentObligationByServicePlanIdAndMonthKey(
            { servicePlanId: plan.id },
            { limit: 200 }
          );
        for (const ob of obligations ?? []) {
          if (
            ob.monthKey < nowMonth &&
            (ob.status === "DUE" || ob.status === "SCHEDULED")
          ) {
            const ok = await markObligation({
              servicePlanId: plan.id,
              monthKey: ob.monthKey,
              status: "SKIPPED_MISSED",
              note: "The month ended without a completed treatment. Per the seasonal policy a missed month creates no catch-up visit.",
            });
            if (ok) skipped++;
          }
        }
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("sweepSeasonalObligations failed", err);
  }
  return { task: "seasonal-obligations" as const, ensured, skipped };
}

/**
 * GL-15 — re-open the owned presence-review case for every report whose
 * FLAGGED marker never reached QUEUED (the case write failed at finalize).
 * The marker on the report is the durable obligation; this sweep is its
 * recovery path. Idempotent: openOwnedWork dedupes on the report id.
 */
export async function reconcilePresenceReviews() {
  const client = await dataClient();
  if (!("ServiceReport" in client.models)) {
    return { task: "reconcile-presence-reviews" as const, requeued: 0, failed: 0 };
  }
  let requeued = 0;
  let failed = 0;
  try {
    let token: string | null | undefined;
    do {
      const page = await client.models.ServiceReport.list({
        filter: { presenceReviewStatus: { eq: "FLAGGED" } },
        limit: 200,
        nextToken: token,
      });
      for (const report of page.data ?? []) {
        try {
          const { data: customer } = await client.models.Customer.get({
            id: report.customerId,
          });
          const ok = await queuePresenceReview({
            reportId: report.id,
            customerId: report.customerId,
            customerName: customer?.displayName ?? "a customer",
            serviceType: "service",
            detail: `A finalized service report (${report.id}) was flagged for an on-site presence review, but the review case did not persist when it was finalized. The record stands; this is a check, not a hold.`,
          });
          if (ok) requeued++;
          else failed++;
        } catch (err) {
          console.error("reconcilePresenceReviews: report failed", report.id, err);
          failed++;
        }
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("reconcilePresenceReviews failed", err);
    failed++;
  }
  return { task: "reconcile-presence-reviews" as const, requeued, failed };
}

/**
 * GL-07 R1 — resume every office visit cancel/reschedule a prior attempt could
 * not carry to a terminal outcome. Each open VisitChangeClaim is a durable
 * command; resumeVisitChange re-drives the idempotent cancel from its last
 * completed step (never re-refunding). A one-shot AppSync mutation nobody
 * redelivers, so this sweep is the only thing that finishes a stuck visit change.
 */
export async function reconcileVisitChanges() {
  const client = await dataClient();
  if (!("VisitChangeClaim" in client.models)) {
    return {
      task: "reconcile-visit-changes" as const,
      open: 0,
      completed: 0,
      stillPending: 0,
      failed: 0,
    };
  }
  const stripe = stripeClient();
  const ids: string[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.VisitChangeClaim.list({
      limit: 200,
      nextToken: token,
    });
    for (const cmd of page.data) ids.push(cmd.id);
    token = page.nextToken;
  } while (token);

  let completed = 0;
  let stillPending = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const outcome = await resumeVisitChange(stripe, id, { auto: true });
      if (outcome.outcome === "COMPLETE" || outcome.alreadyCanceled) completed++;
      else stillPending++;
    } catch (err) {
      failed++;
      console.error(`reconcileVisitChanges: could not resume ${id}`, err);
    }
  }
  if (stillPending > 0 || failed > 0) {
    console.warn(
      `reconcileVisitChanges: ${completed} completed, ${stillPending} still pending, ${failed} errored of ${ids.length} open command(s)`
    );
  }
  return {
    task: "reconcile-visit-changes" as const,
    open: ids.length,
    completed,
    stillPending,
    failed,
  };
}

/**
 * GL-08 R1 — the reconcile sweep that guarantees no accepted plan cancellation
 * can strand. Every open PlanCancellationClaim is a durable command a prior
 * attempt did not carry to a terminal outcome; this resumes each idempotently,
 * respecting its next-attempt time and the auto-retry cap. A plan already
 * canceled is cleaned up inside resumePlanCancellation; a still-failing one
 * keeps its FINANCE PLAN_CANCELLATION_RECOVERY case and is left to a human once
 * the cap is hit. A customer cancel is a one-shot AppSync mutation nobody
 * redelivers, so this sweep is the ONLY thing that re-drives a stuck cancel.
 */
export async function reconcilePlanCancellations() {
  const client = await dataClient();
  // A Lambda container briefly straddling a schema deploy (or a unit-test fake)
  // may not have the model yet — never let that fail the whole reminder run.
  if (!("PlanCancellationClaim" in client.models)) {
    return {
      task: "reconcile-plan-cancellations" as const,
      open: 0,
      completed: 0,
      stillPending: 0,
      failed: 0,
    };
  }
  const stripe = stripeClient();
  const ids: string[] = [];
  let token: string | null | undefined;
  do {
    const page = await client.models.PlanCancellationClaim.list({
      limit: 200,
      nextToken: token,
    });
    for (const cmd of page.data) {
      // Settled commands persist as the readable outcome (stage COMPLETE) —
      // they are done, not open work.
      if (cmd.stage === "COMPLETE") continue;
      ids.push(cmd.id);
    }
    token = page.nextToken;
  } while (token);

  let completed = 0;
  let stillPending = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const outcome = await resumePlanCancellation(stripe, id, { auto: true });
      // GL-08 R2: a CANCELED plan whose settlement is NOT proved (visits,
      // full late-charge refund, provider record, or notice outstanding) is
      // STILL PENDING — the old tally counted it complete every day while its
      // command stayed open and nothing escalated.
      if (outcome.status === "CANCELED" && outcome.settled !== false) {
        completed++;
      } else {
        stillPending++;
      }
    } catch (err) {
      failed++;
      console.error(`reconcilePlanCancellations: could not resume ${id}`, err);
    }
  }
  if (stillPending > 0 || failed > 0) {
    console.warn(
      `reconcilePlanCancellations: ${completed} completed, ${stillPending} still pending, ${failed} errored of ${ids.length} open command(s)`
    );
  }
  return {
    task: "reconcile-plan-cancellations" as const,
    open: ids.length,
    completed,
    stillPending,
    failed,
  };
}

/**
 * GL-02 stale-lead sweep. Scans every open lead, and for each whose next action
 * is overdue (or which was never contacted past its first-touch window) opens or
 * re-announces a LEAD_FOLLOWUP owned-work row — routed to the lead's assigned
 * owner when set, else the SALES team inbox. The deterministic id (kind+customer)
 * collapses daily re-runs into one row while appending a recurrence event, so a
 * lead that stays cold keeps announcing itself without spamming new rows. Any
 * real touch, booking link, lost/DNC decision, or conversion resolves it — so
 * the queue is self-healing and no lead can fall out of the pipeline unnoticed.
 */
async function reportStaleLeads() {
  const client = await dataClient();
  const now = new Date();
  let opened = 0;
  let scanned = 0;
  let token: string | null | undefined;
  try {
    do {
      const page = await client.models.Customer.listCustomerByStatusAndDisplayName(
        { status: "LEAD" },
        { limit: 200, nextToken: token }
      );
      for (const lead of page.data ?? []) {
        scanned++;
        if (!isLeadOpen(lead) || !isLeadActionOverdue(lead, now)) continue;
        const reason =
          staleLeadReason(lead, now) ??
          "This open lead needs a next step.";
        await openOwnedWork({
          kind: "LEAD_FOLLOWUP",
          dedupeKey: lead.id,
          title: `Follow up: ${lead.displayName}`,
          detail: `${reason}${lead.leadSource ? ` Source: ${lead.leadSource}.` : ""} Contact them and record the outcome, or mark the lead lost / do-not-contact.`,
          customerId: lead.id,
          relatedId: lead.id,
          sourceUrl: `/customers/${lead.id}`,
          resolutionAction:
            "Contact the lead and log the touch, send the booking link, or mark it lost / do-not-contact. This closes automatically when you do.",
          ownerTeam: "SALES",
          ownerSub: lead.leadOwnerSub ?? undefined,
          ownerEmail: lead.leadOwnerEmail ?? undefined,
        });
        opened++;
      }
      token = page.nextToken;
    } while (token);
  } catch (err) {
    console.error("reportStaleLeads failed", err);
  }
  return { staleLeadsScanned: scanned, staleLeadsOpened: opened };
}

/**
 * Serviced-but-not-billing digest.
 *
 * Job completion already emails the office the moment a plan fails to start
 * billing, and the Dashboard lists them. Both can be missed: the email gets
 * triaged away, and the Dashboard only exists for whoever opens it. This is the
 * backstop that keeps announcing a plan being serviced for free until somebody
 * actually fixes it — each row is roughly $1,188/yr.
 */
async function reportPlansNotBilling() {
  const client = await dataClient();

  const plans: {
    id: string;
    customerId: string;
    planName: string;
    priceCents: number;
    status: string | null;
    stripeSubscriptionId?: string | null;
  }[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.ServicePlan.list({
      filter: { status: { eq: "ACTIVE" } },
      nextToken,
      limit: 200,
    });
    plans.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  const unbilled = plans.filter((p) => !p.stripeSubscriptionId);
  if (unbilled.length === 0) {
    console.log("Not-billing digest: none");
    return { notBilling: 0, notified: false };
  }

  // Only plans whose first visit has actually happened are owed money. One that
  // hasn't been serviced yet is *supposed* to be unbilled; listing it would
  // train the office to ignore this email.
  const serviced: typeof unbilled = [];
  for (const plan of unbilled) {
    const { data: jobs } = await client.models.Job.listJobByServicePlanId(
      { servicePlanId: plan.id },
      { limit: 50 }
    );
    if (jobs.some((j) => j.status === "COMPLETED")) serviced.push(plan);
  }
  if (serviced.length === 0) {
    console.log(
      `Not-billing digest: ${unbilled.length} unbilled plans, none serviced yet`
    );
    return { notBilling: 0, notified: false };
  }

  const rows = await Promise.all(
    serviced.map(async (p) => {
      const { data: customer } = await client.models.Customer.get({
        id: p.customerId,
      });
      return `<li><strong>${customer?.displayName ?? p.customerId}</strong> — ${p.planName}, $${(p.priceCents / 100).toFixed(2)}/mo</li>`;
    })
  );
  const annual = serviced.reduce((s, p) => s + p.priceCents * 12, 0);

  const notified = await notifyOffice({
    subject: `${serviced.length} plan${serviced.length === 1 ? " is" : "s are"} being serviced without billing`,
    heading: "Serviced but not billing",
    template: "ops-not-billing-digest",
    bodyHtml: `<p>These plans have had their first visit but no subscription is running, so they are being serviced for free. Together that is about <strong>$${(annual / 100).toFixed(2)}/yr</strong>.</p>
       <ul>${rows.join("")}</ul>
       <p>Usually this means no payment method on file. Collect one on the customer record, then use <strong>Start billing</strong> on the plan.</p>`,
  });

  console.log(
    `Not-billing digest: ${serviced.length} serviced plans not billing, notified=${notified}`
  );
  return { notBilling: serviced.length, notified };
}

/**
 * Completed-but-never-charged digest — the one-time side of the money.
 *
 * Completion auto-starts billing for recurring plans; a one-time job's money
 * moves only when someone presses Charge on the customer record, and nothing
 * used to feed that button. The Dashboard lists these too, but the Dashboard
 * only exists for whoever opens it — this repeats daily until every job is
 * charged, invoiced, or paid.
 */
async function reportUnchargedOneTimeJobs() {
  const client = await dataClient();

  const jobs: {
    id: string;
    customerId: string;
    serviceType: string;
    priceCents?: number | null;
    paidAt?: string | null;
    completedAt?: string | null;
    scheduledDate?: string | null;
  }[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByStatusAndScheduledDate(
      { status: "COMPLETED" },
      { filter: { type: { eq: "ONE_TIME" } }, nextToken, limit: 200 }
    );
    jobs.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  // paidAt means paid up front at online booking. Zero-priced jobs are left
  // out: there is nothing for the Charge button to take, and a row nobody can
  // clear trains the office to ignore the list.
  const candidates = jobs.filter((j) => !j.paidAt && (j.priceCents ?? 0) > 0);
  if (candidates.length === 0) {
    console.log("Uncharged-jobs digest: none");
    return { unchargedJobs: 0, notified: false };
  }

  // One pass over the ledger. FAILED may be retried and VOID was withdrawn as
  // wrong — neither answers the job's money question. OPEN, PAID and REFUNDED
  // all do. chargeOneTimeJob enforces the same rule server-side.
  const covered = new Set<string>();
  let invToken: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({
      nextToken: invToken,
      limit: 200,
    });
    for (const inv of page.data) {
      if (inv.jobId && inv.status !== "FAILED" && inv.status !== "VOID") {
        covered.add(inv.jobId);
      }
    }
    invToken = page.nextToken;
  } while (invToken);

  const uncharged = candidates.filter((j) => !covered.has(j.id));
  if (uncharged.length === 0) {
    console.log(
      `Uncharged-jobs digest: ${candidates.length} completed one-time jobs, all covered`
    );
    return { unchargedJobs: 0, notified: false };
  }

  const rows = await Promise.all(
    uncharged.map(async (j) => {
      const { data: customer } = await client.models.Customer.get({
        id: j.customerId,
      });
      const when = (j.completedAt ?? j.scheduledDate ?? "").slice(0, 10);
      return `<li><strong>${customer?.displayName ?? j.customerId}</strong> — ${j.serviceType}${when ? `, completed ${when}` : ""}: $${((j.priceCents ?? 0) / 100).toFixed(2)}</li>`;
    })
  );
  const total = uncharged.reduce((s, j) => s + (j.priceCents ?? 0), 0);

  const notified = await notifyOffice({
    subject: `${uncharged.length} completed job${uncharged.length === 1 ? " has" : "s have"} never been charged`,
    heading: "Completed but never charged",
    template: "ops-uncharged-jobs-digest",
    bodyHtml: `<p>The work is done and no charge or invoice exists for ${uncharged.length === 1 ? "this job" : "these jobs"} — together <strong>$${(total / 100).toFixed(2)}</strong> nobody is collecting.</p>
       <ul>${rows.join("")}</ul>
       <p>Open each customer and use <strong>Charge</strong> on the job, or record an offline payment if the money arrived another way. They also appear under <strong>Completed but never charged</strong> on the Dashboard until cleared.</p>`,
  });

  console.log(
    `Uncharged-jobs digest: ${uncharged.length} jobs uncharged, notified=${notified}`
  );
  return { unchargedJobs: uncharged.length, notified };
}

/**
 * Billing-with-no-visit digest — the service direction of "not billing".
 *
 * The recurring engine queues the next visit when one completes, but a
 * NO_ACCESS exit deliberately queues nothing, a canceled visit leaves nothing
 * behind, and a plan created without its first job starts life here. A
 * customer paying monthly with no visit on the calendar is the highest-harm
 * state in the system, and until this digest existed it appeared nowhere.
 */
async function reportPlansWithoutNextVisit() {
  const client = await dataClient();
  const today = easternPlusDays(0);

  const plans: {
    id: string;
    customerId: string;
    planName: string;
    priceCents: number;
    status: string | null;
    stripeSubscriptionId?: string | null;
  }[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.ServicePlan.list({
      filter: { status: { eq: "ACTIVE" } },
      nextToken,
      limit: 200,
    });
    plans.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  // A plan has a next visit if anything is queued (UNSCHEDULED), on the
  // calendar today or later (SCHEDULED), or being worked right now
  // (IN_PROGRESS). A visit dated in the past that never happened does not
  // count — nobody is coming.
  const missing: typeof plans = [];
  for (const plan of plans) {
    let hasVisit = false;
    let token: string | null | undefined;
    do {
      const page = await client.models.Job.listJobByServicePlanId(
        { servicePlanId: plan.id },
        { nextToken: token, limit: 200 }
      );
      hasVisit = page.data.some(
        (j) =>
          j.status === "UNSCHEDULED" ||
          j.status === "IN_PROGRESS" ||
          (j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today)
      );
      token = hasVisit ? null : page.nextToken;
    } while (token);
    if (!hasVisit) missing.push(plan);
  }

  if (missing.length === 0) {
    console.log("Plan-no-visit digest: none");
    return { plansWithoutVisit: 0, notified: false };
  }

  const rows = await Promise.all(
    missing.map(async (p) => {
      const { data: customer } = await client.models.Customer.get({
        id: p.customerId,
      });
      return `<li><strong>${customer?.displayName ?? p.customerId}</strong> — ${p.planName}, $${(p.priceCents / 100).toFixed(2)}/mo${p.stripeSubscriptionId ? " — <strong>billing is running</strong>" : ""}</li>`;
    })
  );

  const notified = await notifyOffice({
    subject: `${missing.length} active plan${missing.length === 1 ? " has" : "s have"} no next visit`,
    heading: "Billing with no visit on the calendar",
    template: "ops-plan-no-visit-digest",
    bodyHtml: `<p>${missing.length === 1 ? "This plan is" : "These plans are"} active — any with a subscription are still charging the customer — and no visit is scheduled or queued for them. A paying customer nobody is coming back to is a cancellation or a chargeback in the making; a no-access exit or a canceled visit leaves a plan in exactly this state.</p>
       <ul>${rows.join("")}</ul>
       <p><strong>Book the next visit</strong> from each customer's record — or pause or cancel the plan if service really should stop. They also appear under <strong>Active plans with no next visit</strong> on the Dashboard until cleared.</p>`,
  });

  console.log(
    `Plan-no-visit digest: ${missing.length} plans without a next visit, notified=${notified}`
  );
  return { plansWithoutVisit: missing.length, notified };
}

type DatedJob = {
  customerId: string;
  serviceType: string;
  timeWindow?: string | null;
  status: string | null;
  id: string;
  routeId?: string | null;
};

/**
 * Which of tomorrow's jobs somebody is actually staffed to make: the job is on
 * a route dated the same day, and that route's technician is still active. A
 * job that fails any of those checks would leave the customer's "BuzzKill is
 * scheduled to visit tomorrow" email a lie — nobody's day sheet contains it.
 */
async function splitByStaffing(date: string, jobs: DatedJob[]) {
  const client = await dataClient();
  const routeCache = new Map<
    string,
    { date: string; technicianId: string } | null
  >();
  const techCache = new Map<string, { name: string; active: boolean } | null>();
  const licenseCache = new Map<string, boolean>();

  const staffed: DatedJob[] = [];
  const unstaffed: { job: DatedJob; why: string }[] = [];
  for (const job of jobs) {
    if (!job.routeId) {
      unstaffed.push({ job, why: "on no technician's route" });
      continue;
    }
    if (!routeCache.has(job.routeId)) {
      const { data } = await client.models.Route.get({ id: job.routeId });
      routeCache.set(
        job.routeId,
        data ? { date: data.date, technicianId: data.technicianId } : null
      );
    }
    const route = routeCache.get(job.routeId) ?? null;
    if (!route) {
      unstaffed.push({ job, why: "its route no longer exists" });
      continue;
    }
    if (route.date !== date) {
      unstaffed.push({
        job,
        why: `its route is dated ${route.date}, not ${date}`,
      });
      continue;
    }
    if (!techCache.has(route.technicianId)) {
      const { data } = await client.models.Technician.get({
        id: route.technicianId,
      });
      techCache.set(
        route.technicianId,
        data ? { name: data.name, active: data.active === true } : null
      );
    }
    const tech = techCache.get(route.technicianId) ?? null;
    if (!tech) {
      unstaffed.push({ job, why: "its technician record no longer exists" });
      continue;
    }
    if (!tech.active) {
      unstaffed.push({
        job,
        why: `assigned to ${tech.name}, who is deactivated`,
      });
      continue;
    }
    // GL-17: a route staffed by a technician with no licence current on the
    // service date is an unstaffed visit — caught the day before, not at the
    // doorstep.
    const licKey = `${route.technicianId}:${date}`;
    if (!licenseCache.has(licKey)) {
      const { data: fullTech } = await client.models.Technician.get({
        id: route.technicianId,
      });
      licenseCache.set(
        licKey,
        fullTech ? (await licenseFactsFor(fullTech, date)).current : false
      );
    }
    if (!licenseCache.get(licKey)) {
      unstaffed.push({
        job,
        why: `assigned to ${tech.name}, whose applicator licence is not current on ${date}`,
      });
      continue;
    }
    staffed.push(job);
  }
  return { staffed, unstaffed };
}

/**
 * Tomorrow's staffing gaps, as one office alert. These customers were NOT
 * reminded — a reminder for a visit nobody is staffed to make books the
 * no-show in writing — so the office has today to staff the visit or move it.
 */
async function reportUnstaffedJobs(
  date: string,
  gaps: { job: DatedJob; why: string }[]
) {
  const client = await dataClient();
  const names = new Map<string, string>();
  const rows: string[] = [];
  for (const { job, why } of gaps) {
    if (!names.has(job.customerId)) {
      const { data: customer } = await client.models.Customer.get({
        id: job.customerId,
      });
      names.set(job.customerId, customer?.displayName ?? job.customerId);
    }
    rows.push(
      `<li><strong>${names.get(job.customerId)}</strong> — ${job.serviceType}${job.timeWindow ? `, ${job.timeWindow}` : ""}: ${why}</li>`
    );
    await openOwnedWork({
      kind: "UNSTAFFED_VISIT",
      dedupeKey: job.id,
      title: `Staff tomorrow's visit: ${names.get(job.customerId)}`,
      detail: `${job.serviceType}${job.timeWindow ? ` (${job.timeWindow})` : ""} is scheduled for ${date}, but ${why}. The customer reminder was suppressed.`,
      customerId: job.customerId,
      relatedId: job.id,
      sourceUrl: "/schedule",
      resolutionAction:
        "Assign the visit to an active technician or move it, then notify the customer of the confirmed plan.",
      ownerTeam: "OPS",
    });
  }

  return notifyOffice({
    subject: `${gaps.length} visit${gaps.length === 1 ? "" : "s"} tomorrow ${gaps.length === 1 ? "has" : "have"} nobody coming (${prettyDate(date)})`,
    heading: "Tomorrow has visits nobody is staffed to make",
    template: "ops-unstaffed-visits",
    bodyHtml: `<p>These visits are dated <strong>${prettyDate(date)}</strong> but are not on an active technician's route, so as things stand nobody will show up. <strong>No reminder was sent to these customers.</strong></p>
       <ul>${rows.join("")}</ul>
       <p>Put each one on an active technician's route on the Schedule, or move it to a day that works and tell the customer.</p>`,
  });
}

async function remind(date: string, phrasing: string, staffingGate: boolean) {
  const client = await dataClient();
  const jobs: DatedJob[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Job.listJobByScheduledDate(
      { scheduledDate: date },
      { nextToken, limit: 200 }
    );
    jobs.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);

  const scheduled = jobs.filter((j) => j.status === "SCHEDULED");

  // R21: no customer reminder for a visit nobody is staffed to make. Only the
  // day-before pass checks — a week out, routes legitimately don't exist yet.
  // Pool jobs whose target date is tomorrow never got a reminder anyway, but
  // they are dated work nobody is coming to, so they join the office alert.
  let remindable = scheduled;
  let unstaffedCount = 0;
  if (staffingGate) {
    const { staffed, unstaffed } = await splitByStaffing(date, scheduled);
    const gaps = [
      ...unstaffed,
      ...jobs
        .filter((j) => j.status === "UNSCHEDULED")
        .map((job) => ({
          job,
          why: "still in the needs-scheduling pool — it was never placed on a route",
        })),
    ];
    remindable = staffed;
    unstaffedCount = gaps.length;
    if (gaps.length > 0) await reportUnstaffedJobs(date, gaps);
  }

  // One email per customer even if they have multiple visits tomorrow.
  const byCustomer = new Map<string, typeof remindable>();
  for (const job of remindable) {
    const list = byCustomer.get(job.customerId) ?? [];
    list.push(job);
    byCustomer.set(job.customerId, list);
  }

  let sent = 0;
  for (const [customerId, customerJobs] of byCustomer) {
    const { data: customer } = await client.models.Customer.get({
      id: customerId,
    });
    if (!customer?.email) {
      if (customer) {
        await openMissingContactWork({
          customerId,
          displayName: customer.displayName,
          context: `The ${phrasing} service reminder for ${prettyDate(date)} could not be sent.`,
        });
      }
      continue;
    }

    const visitLines = customerJobs
      .map(
        (j) =>
          `<li><strong>${j.serviceType}</strong>${j.timeWindow ? ` — ${j.timeWindow}` : ""}</li>`
      )
      .join("");
    const ok = await sendEmail({
      to: customer.email,
      subject: `Reminder: BuzzKill service visit ${prettyDate(date)}`,
      template: "upcoming-service",
      customerId,
      relatedId: customerJobs[0].id,
      html: emailShell(
        `Your service visit is ${phrasing}`,
        `<p>Hi ${customer.contactName ?? customer.displayName},</p>
         <p>This is a friendly reminder that BuzzKill Pest Control is scheduled to visit on <strong>${prettyDate(date)}</strong>:</p>
         <ul>${visitLines}</ul>
         <p style="color:#666;font-size:13px;">Need to reschedule? Reply to this email or give us a call.</p>`
      ),
    });
    if (ok) sent++;
  }

  console.log(
    `Reminders for ${date}: ${scheduled.length} scheduled jobs, ${byCustomer.size} customers, ${sent} emails sent${staffingGate ? `, ${unstaffedCount} unstaffed` : ""}`
  );
  return {
    date,
    jobs: scheduled.length,
    customers: byCustomer.size,
    sent,
    ...(staffingGate ? { unstaffed: unstaffedCount } : {}),
  };
}

/**
 * The dunning retry cadence (R02). A FAILED invoice carries nextDunningAt; when
 * it comes due this re-attempts the saved card, advances the schedule (+3, +5,
 * +7 days — DUNNING_RETRY_OFFSET_DAYS), and after the final failed attempt
 * SUSPENDS the plan so the recurring engine stops dispatching technicians to a
 * customer who has stopped paying. A subsequent invoice.paid clears the
 * suspension (shared/recovery clearPlanDelinquency, via the webhook).
 */
async function runDunningRetries() {
  const client = await dataClient();
  const nowIso = new Date().toISOString();
  const failed = await allInvoicesByStatus("FAILED");
  const due = failed.filter(
    (inv) =>
      inv.nextDunningAt &&
      inv.nextDunningAt <= nowIso &&
      // Subscription invoices are Stripe's to retry — it runs its own smart
      // retries against the same card. A parallel PaymentIntent from here
      // would charge the card twice AND, on success, still leave the Stripe
      // invoice past_due (we never called invoices.pay) so Stripe eventually
      // cancels the sub. We only ever retry standalone CRM invoices.
      !inv.stripeInvoiceId
  );
  if (due.length === 0) {
    console.log("Dunning: no invoices due for retry");
    return { dunningRetried: 0, dunningRecovered: 0, dunningSuspended: 0 };
  }

  const stripe = stripeClient();
  let recovered = 0;
  let suspended = 0;
  for (const inv of due) {
    const attempts = inv.dunningAttempts ?? 0;
    let paid = false;
    try {
      const outcome = await settleInvoiceOnCard(stripe, {
        invoiceId: inv.id,
        attemptTag: `dun${attempts}`,
      });
      paid = outcome.status === "PAID" || outcome.alreadyPaid === true;
    } catch (err) {
      // No card on file, or an unexpected error — counts as a failed attempt so
      // the cadence still advances toward suspension.
      console.error(`Dunning retry threw for invoice ${inv.id}`, err);
    }
    if (paid) {
      recovered++;
      continue; // settleInvoiceOnCard cleared dunning + delinquency + receipt
    }

    const attemptsMade = attempts + 1;
    const next = nextDunningAtIso(attemptsMade, nowIso);
    if (next) {
      // More retries to go — advance the schedule.
      await client.models.Invoice.update({
        id: inv.id,
        dunningAttempts: attemptsMade,
        nextDunningAt: next,
        lastDunningAt: nowIso,
      });
    } else {
      // Cadence exhausted — stop the money bleed and stop the trucks.
      await client.models.Invoice.update({
        id: inv.id,
        dunningAttempts: attemptsMade,
        nextDunningAt: null,
        lastDunningAt: nowIso,
      });
      const didSuspend = await suspendPlanForDelinquency(inv);
      if (didSuspend) suspended++;
    }
  }

  console.log(
    `Dunning: ${due.length} retried, ${recovered} recovered, ${suspended} suspended`
  );
  return {
    dunningRetried: due.length,
    dunningRecovered: recovered,
    dunningSuspended: suspended,
  };
}

/**
 * Every card retry on this invoice failed. Suspend its plan (delinquent flag,
 * which recurring.ts respects) so no further visits dispatch, and tell the
 * office and the customer. A one-time invoice with no plan just alerts — there
 * is no plan to suspend.
 */
async function suspendPlanForDelinquency(inv: OwedInvoice): Promise<boolean> {
  const client = await dataClient();
  const { data: customer } = await client.models.Customer.get({
    id: inv.customerId,
  });
  const name = customer?.displayName ?? inv.customerId;
  const amount = `$${(inv.amountCents / 100).toFixed(2)}`;

  let suspended = false;
  if (inv.servicePlanId) {
    const { data: plan } = await client.models.ServicePlan.get({
      id: inv.servicePlanId,
    });
    if (plan && !plan.delinquent) {
      await client.models.ServicePlan.update({
        id: inv.servicePlanId,
        delinquent: true,
        delinquentSince: new Date().toISOString(),
      });
      suspended = true;
    }
  }

  if (customer?.email) {
    await sendPaymentFailedNotice({
      customerId: inv.customerId,
      amountCents: inv.amountCents,
      description: inv.description,
      reason:
        "We've tried your card several times without success, so your service has been paused. Please update your payment method to resume.",
      invoiceId: inv.id,
    });
  }

  await notifyOffice({
    subject: `ACTION REQUIRED — ${suspended ? "plan suspended" : "unpaid invoice"} after failed retries: ${name} (${amount})`,
    heading: suspended
      ? "A plan was suspended for non-payment"
      : "An invoice went unpaid after every retry",
    template: "ops-dunning-exhausted",
    customerId: inv.customerId,
    relatedId: inv.id,
    bodyHtml: `<p><strong>${name}</strong>'s ${amount} charge failed every retry (${MAX_DUNNING_ATTEMPTS} attempts).</p>
       ${
         suspended
           ? "<p>Their plan is now <strong>suspended</strong> — the recurring engine will not dispatch any more visits until they pay. When a payment lands the suspension lifts automatically.</p>"
           : "<p>There is no plan to suspend, but this money is still outstanding.</p>"
       }
       <p>Owner: ${inv.ownerEmail ? escapeHtmlLite(inv.ownerEmail) : "<strong>unassigned</strong>"}. Call the customer and collect a working card.</p>`,
  });
  return suspended;
}

/**
 * Open-invoice reminders (R52). A due-soon nudge fires exactly
 * DUE_SOON_LEAD_DAYS before dueDate; overdue reminders fire the day after due
 * and then weekly, each with the pay link — a daily overdue email trains
 * customers to ignore it.
 */
async function remindOpenInvoices() {
  const now = new Date();
  const open = await allInvoicesByStatus("OPEN");
  let dueSoon = 0;
  let overdue = 0;
  for (const inv of open) {
    if (!inv.dueDate && !inv.issuedAt) continue;
    const days = daysPastDue({
      dueDate: inv.dueDate,
      issuedAt: inv.issuedAt,
      now,
    });
    const kind = reminderKind(days, Boolean(inv.dueDate));
    if (!kind) continue;
    const ok = await sendInvoiceReminder({
      customerId: inv.customerId,
      amountCents: inv.amountCents,
      description: inv.description,
      dueDate: inv.dueDate,
      overdue: kind === "OVERDUE",
      invoiceId: inv.id,
    });
    if (ok) kind === "OVERDUE" ? overdue++ : dueSoon++;
  }
  console.log(
    `Invoice reminders: ${dueSoon} due-soon, ${overdue} overdue sent`
  );
  return { invoiceRemindersDueSoon: dueSoon, invoiceRemindersOverdue: overdue };
}

/**
 * Whether to remind about an open invoice today, given how many days past due
 * it is. Due-soon only fires when there's a real dueDate to count back from.
 */
export function reminderKind(
  days: number,
  hasDueDate: boolean
): "DUE_SOON" | "OVERDUE" | null {
  if (hasDueDate && days === -DUE_SOON_LEAD_DAYS) return "DUE_SOON";
  if (days > 0 && (days === 1 || days % 7 === 0)) return "OVERDUE";
  return null;
}

/**
 * AR-aging digest for the office (R52): every outstanding invoice — OPEN plus
 * FAILED (in dunning) — bucketed current / 1-30 / 31-60 / 61-90 / 90+ by how
 * overdue it is, with the dollar total in each bucket.
 */
async function reportArAging() {
  const now = new Date();
  const outstanding = [
    ...(await allInvoicesByStatus("OPEN")),
    ...(await allInvoicesByStatus("FAILED")),
  ];
  if (outstanding.length === 0) {
    console.log("AR aging: nothing outstanding");
    return { arOutstanding: 0, notified: false };
  }

  const totals = new Map<AgingBucket, { cents: number; count: number }>();
  for (const b of AGING_BUCKET_ORDER) totals.set(b, { cents: 0, count: 0 });
  let grand = 0;
  for (const inv of outstanding) {
    const bucket = agingBucket(
      daysPastDue({ dueDate: inv.dueDate, issuedAt: inv.issuedAt, now })
    );
    const t = totals.get(bucket)!;
    t.cents += inv.amountCents;
    t.count += 1;
    grand += inv.amountCents;
  }

  const rows = AGING_BUCKET_ORDER.map((b) => {
    const t = totals.get(b)!;
    return `<tr><td style="padding:4px 12px 4px 0;">${AGING_BUCKET_LABEL[b]}</td><td style="padding:4px 0;text-align:right;">$${(t.cents / 100).toFixed(2)}</td><td style="padding:4px 0 4px 12px;text-align:right;color:#888;">${t.count}</td></tr>`;
  }).join("");

  const notified = await notifyOffice({
    subject: `AR aging: $${(grand / 100).toFixed(2)} outstanding across ${outstanding.length} invoice${outstanding.length === 1 ? "" : "s"}`,
    heading: "Accounts receivable — aging",
    template: "ops-ar-aging",
    bodyHtml: `<p>Money owed to BuzzKill right now, by how overdue it is:</p>
       <table style="border-collapse:collapse;font-size:14px;"><tbody>${rows}</tbody></table>
       <p style="margin-top:12px;"><strong>Total outstanding: $${(grand / 100).toFixed(2)}</strong></p>
       <p style="color:#666;font-size:13px;">The oldest buckets are the ones to work first — the longer money sits, the less of it comes back.</p>`,
  });
  console.log(
    `AR aging: ${outstanding.length} invoices, $${(grand / 100).toFixed(2)} outstanding, notified=${notified}`
  );
  return { arOutstanding: outstanding.length, arTotalCents: grand, notified };
}

/**
 * Dispute-deadline alerts (R52/R02): any open dispute whose evidence deadline
 * is within DISPUTE_ALERT_LEAD_DAYS. Missing an evidence deadline loses the
 * dispute by default, so this is the last-chance nudge — with the owner named.
 */
async function reportDisputeDeadlines() {
  const client = await dataClient();
  const now = Date.now();
  const disputes: {
    id: string;
    stripeDisputeId: string;
    customerId?: string | null;
    amountCents: number;
    evidenceDueBy?: string | null;
    ownerEmail?: string | null;
  }[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Dispute.listDisputeByStatus(
      { status: "NEEDS_RESPONSE" },
      { nextToken, limit: 200 }
    );
    disputes.push(...(page.data as (typeof disputes)[number][]));
    nextToken = page.nextToken;
  } while (nextToken);

  const soon = disputes.filter((d) => {
    if (!d.evidenceDueBy) return false;
    const ms = new Date(d.evidenceDueBy).getTime() - now;
    return ms <= DISPUTE_ALERT_LEAD_DAYS * 86_400_000; // due within the window (incl. past)
  });
  if (soon.length === 0) {
    console.log("Dispute deadlines: none near");
    return { disputesDueSoon: 0, notified: false };
  }

  const rows = await Promise.all(
    soon.map(async (d) => {
      const name = d.customerId
        ? (await client.models.Customer.get({ id: d.customerId })).data
            ?.displayName ?? d.customerId
        : "unknown customer";
      const due = d.evidenceDueBy
        ? new Date(d.evidenceDueBy).toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: "UTC",
          })
        : "unknown";
      return `<li><strong>${escapeHtmlLite(String(name))}</strong> — $${(d.amountCents / 100).toFixed(2)}, evidence due <strong>${due}</strong>. Owner: ${d.ownerEmail ? escapeHtmlLite(d.ownerEmail) : "<strong>unassigned</strong>"}</li>`;
    })
  );

  const notified = await notifyOffice({
    subject: `${soon.length} card dispute${soon.length === 1 ? "" : "s"} need${soon.length === 1 ? "s" : ""} evidence soon`,
    heading: "Card disputes with a near deadline",
    template: "ops-dispute-deadline",
    bodyHtml: `<p>These open disputes have an evidence deadline within ${DISPUTE_ALERT_LEAD_DAYS} days. Miss it and the dispute is lost by default and the money is gone. Respond in the Stripe dashboard.</p>
       <ul>${rows.join("")}</ul>`,
  });
  console.log(
    `Dispute deadlines: ${soon.length} near, notified=${notified}`
  );
  return { disputesDueSoon: soon.length, notified };
}

/**
 * GL-05 production reconciliation. Reads the real CRM booking and invoice
 * tables and the set of succeeded booking PaymentIntents from Stripe, then
 * proves the relationship in both directions:
 *
 *   - every succeeded booking payment has exactly one complete BOOKED booking
 *     for the exact amount, and
 *   - every BOOKED booking's checkpoint IDs still resolve to real child rows
 *     (a nonblank jobId is not proof the Job exists — it is loaded and checked).
 *
 * Every disagreement becomes (or updates) an owned Finance case; a booking that
 * proves whole resolves the case a failed finalization may have left open. The
 * pure set logic lives in shared/bookingReconcile (unit-tested); this function
 * is the scheduled IO around it, run from the daily cron.
 */
export async function reconcilePaidBookings() {
  const client = await dataClient();

  let succeeded: {
    ids: string[];
    paidCentsByPi: Record<string, number>;
    truncated?: boolean;
  };
  try {
    succeeded = await fetchSucceededBookingPayments();
  } catch (err) {
    // A provider failure must be loud owned work, not a silent skip: a Stripe
    // outage that made us read zero payments would otherwise look "all clear".
    console.error("reconcilePaidBookings: could not read Stripe payments", err);
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: "recon-stripe-unavailable",
      title: "Booking reconciliation could not read Stripe",
      detail: `The daily paid-booking reconciliation could not list succeeded payments from Stripe: ${err instanceof Error ? err.message : String(err)}. Until it runs clean, a stuck paid booking could go unseen.`,
      relatedId: "reconciliation",
      resolutionAction:
        "Check Stripe API health and the webhook/secret keys, then re-run the daily reconciliation and confirm it completes clean.",
      ownerTeam: "FINANCE",
    });
    return { reconciled: false, reason: "stripe-unavailable" as const };
  }

  const bookings = await allBookingsForReconcile();
  const invoices = await allInvoicesForReconcile();
  const recon = reconcileBookings(
    bookings,
    invoices,
    succeeded.ids,
    succeeded.paidCentsByPi
  );

  const paidInvoiceByPi = new Map<
    string,
    ReconInvoiceRow
  >();
  for (const i of invoices) {
    if (i.status === "PAID" && i.stripePaymentIntentId?.trim()) {
      paidInvoiceByPi.set(i.stripePaymentIntentId.trim(), i);
    }
  }
  const bookingByPi = new Map<string, ReconBooking>();
  for (const b of bookings) {
    const pi = b.stripePaymentIntentId?.trim();
    if (pi) bookingByPi.set(pi, b);
  }
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  // One owned-work item per booking, combining every reason that booking is not
  // whole, so an amount mismatch and a dangling child do not fight over the row.
  const issues = new Map<string, string[]>();
  const addIssue = (bookingId: string, reason: string) => {
    const list = issues.get(bookingId) ?? [];
    list.push(reason);
    issues.set(bookingId, list);
  };

  for (const m of recon.amountMismatches) {
    addIssue(
      m.bookingId,
      `Stripe captured $${(m.paidCents / 100).toFixed(2)} but the booking committed to $${(m.bookedCents / 100).toFixed(2)}`
    );
  }

  // A succeeded payment with no BOOKED booking: if a (stuck) booking still
  // references the PI, key the case on that booking so it lines up with the one
  // finalization opened; a PI referenced by no booking at all is a true orphan.
  const orphanPis: string[] = [];
  for (const { stripePaymentIntentId: pi } of recon.paymentsMissingBooking) {
    const b = bookingByPi.get(pi);
    if (b) {
      addIssue(
        b.id,
        `payment ${pi} succeeded but the booking is ${b.status ?? "unknown"}, not BOOKED`
      );
    } else {
      orphanPis.push(pi);
    }
  }

  // Dangling / missing child records on BOOKED bookings — the load-bearing
  // "nonblank ID is not proof" check.
  const healthyBooked: string[] = [];
  for (const b of bookings) {
    if (b.status !== "BOOKED") continue;
    const { exists, rows } = await childExistenceFor(b, paidInvoiceByPi);
    const missing = missingChildRecords(b, exists);
    if (missing.length) {
      addIssue(b.id, `BOOKED but missing: ${missing.join(", ")}`);
    }
    // GL-05: a child that RESOLVES but belongs to someone else is worse than a
    // missing one — a cross-link. Relationships are validated, not existence.
    const crossLinked = mismatchedChildRelationships(
      b as Parameters<typeof mismatchedChildRelationships>[0],
      rows
    );
    if (crossLinked.length) {
      addIssue(b.id, `BOOKED but cross-linked: ${crossLinked.join("; ")}`);
    }
    if (!missing.length && !crossLinked.length && !issues.has(b.id)) {
      healthyBooked.push(b.id);
    }
  }

  let opened = 0;
  for (const [bookingId, reasons] of issues) {
    const b = bookingById.get(bookingId);
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: bookingId,
      title: `Reconciliation: paid booking is not whole${b?.name ? `: ${b.name}` : ""}`,
      detail: `Daily reconciliation found this paid booking out of agreement with Stripe or the ledger: ${reasons.join("; ")}.`,
      customerId: b?.customerId ?? undefined,
      relatedId: bookingId,
      sourceUrl: b?.customerId ? `/customers/${b.customerId}` : undefined,
      resolutionAction:
        "Open the booking and use “Retry finalization” to complete the missing records, or refund the payment in Stripe and tell the customer.",
      ownerTeam: "FINANCE",
    });
    opened++;
  }

  for (const pi of orphanPis) {
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: `recon-missing-pi:${pi}`,
      title: "Succeeded booking payment has no booking",
      detail: `Stripe PaymentIntent ${pi} (tagged as a booking payment) succeeded for $${((succeeded.paidCentsByPi[pi] ?? 0) / 100).toFixed(2)}, but no BookingRequest references it. Money is captured with nothing behind it.`,
      relatedId: pi,
      resolutionAction:
        "Find this PaymentIntent in Stripe; recreate and finalize the booking from the receipt, or refund the charge and tell the customer.",
      ownerTeam: "FINANCE",
    });
    opened++;
  }

  for (const d of recon.duplicateBookingsForPayment) {
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: `recon-dup-booking:${d.stripePaymentIntentId}`,
      title: "One payment made two bookings",
      detail: `Payment ${d.stripePaymentIntentId} is behind more than one BOOKED booking (${d.bookingIds.join(", ")}) — a duplicated commitment. One customer paid once but has two bookings/jobs.`,
      relatedId: d.stripePaymentIntentId,
      resolutionAction:
        "Cancel the duplicate booking/job (keep one), verify no double visit is scheduled, and confirm the customer was charged once.",
      ownerTeam: "FINANCE",
    });
    opened++;
  }

  for (const d of recon.duplicatePaidInvoices) {
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: `recon-dup-invoice:${d.stripePaymentIntentId}`,
      title: "One payment recorded as two paid invoices",
      detail: `Payment ${d.stripePaymentIntentId} backs more than one PAID invoice (${d.invoiceIds.join(", ")}) — the money is double-counted as revenue.`,
      relatedId: d.stripePaymentIntentId,
      resolutionAction:
        "Void the duplicate invoice so the payment is counted once, and reconcile revenue.",
      ownerTeam: "FINANCE",
    });
    opened++;
  }

  // GL-05: a truncated provider scan reconciled against a PARTIAL payment set.
  // It may not auto-resolve anything (a real anomaly could hide in the unread
  // pages) and may not report green — it is owned Finance/Engineering work.
  if (succeeded.truncated) {
    await openOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: "recon-truncated",
      title: "Booking reconciliation was TRUNCATED — results are partial",
      detail: `The daily reconciliation hit its Stripe page cap and reconciled against a partial payment set (${succeeded.ids.length} payments read). Anomalies below are real, but a clean-looking booking may still be broken in the unread pages. Prior open cases were left untouched.`,
      relatedId: "reconciliation",
      resolutionAction:
        "Narrow RECONCILE_WINDOW_DAYS or raise the page cap, re-run the reconciliation, and confirm it completes without truncation.",
      ownerTeam: "FINANCE",
    });
    const ok = false;
    console.log(
      `Reconciliation TRUNCATED: ${bookings.length} bookings, ${succeeded.ids.length} payments (partial), ok=${ok}`
    );
    return {
      reconciled: false as const,
      reason: "truncated" as const,
      bookings: bookings.length,
      succeededPayments: succeeded.ids.length,
      anomaliesOpened: opened,
      resolved: 0,
      ok,
    };
  }

  // A booking that proves whole clears any exception a failed finalization left
  // open — reconciliation resolves, not just opens.
  let resolved = 0;
  for (const id of healthyBooked) {
    const did = await resolveOwnedWork({
      kind: "PAID_NOT_FINALIZED",
      dedupeKey: id,
      note: "Daily reconciliation confirmed this booking is complete: every child record exists, belongs to this booking, and the payment matches the committed amount.",
    });
    if (did) resolved++;
  }

  const ok = issues.size === 0 && orphanPis.length === 0 && recon.ok;
  console.log(
    `Reconciliation: ${bookings.length} bookings, ${succeeded.ids.length} succeeded payments, ${opened} anomalies opened, ${resolved} resolved, ok=${ok}`
  );
  return {
    reconciled: true as const,
    bookings: bookings.length,
    succeededPayments: succeeded.ids.length,
    anomaliesOpened: opened,
    resolved,
    ok,
  };
}

/** All succeeded booking-funnel PaymentIntents Stripe knows about in the recent
 *  window, with their captured amounts. Bounded by RECONCILE_WINDOW_DAYS and a
 *  hard page cap so a volume spike cannot run the Lambda out of time silently. */
async function fetchSucceededBookingPayments(): Promise<{
  ids: string[];
  paidCentsByPi: Record<string, number>;
  truncated: boolean;
}> {
  const stripe = stripeClient();
  const configured = Number(process.env.RECONCILE_WINDOW_DAYS ?? 45);
  const windowDays = Number.isFinite(configured) && configured > 0 ? configured : 45;
  const gte = Math.floor((Date.now() - windowDays * 86_400_000) / 1000);
  const ids: string[] = [];
  const paidCentsByPi: Record<string, number> = {};
  let startingAfter: string | undefined;
  let pages = 0;
  let truncated = false;
  const MAX_PAGES = 100; // 100 * 100 = 10k PaymentIntents — a runaway backstop
  for (;;) {
    const page = await stripe.paymentIntents.list({
      created: { gte },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const pi of page.data) {
      if (pi.status === "succeeded" && pi.metadata?.bookingRequestId) {
        ids.push(pi.id);
        paidCentsByPi[pi.id] = pi.amount_received ?? 0;
      }
    }
    pages++;
    if (!page.has_more) break;
    if (pages >= MAX_PAGES) {
      // GL-05: a truncated scan may NOT quietly report green — the caller
      // opens owned work, skips auto-resolution, and returns not-ok.
      truncated = true;
      console.error(
        `reconcilePaidBookings: stopped paging Stripe at ${MAX_PAGES} pages — narrow RECONCILE_WINDOW_DAYS or investigate volume`
      );
      break;
    }
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }
  return { ids, paidCentsByPi, truncated };
}

async function allBookingsForReconcile(): Promise<ReconBooking[]> {
  const client = await dataClient();
  const rows: ReconBooking[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.BookingRequest.list({ nextToken, limit: 200 });
    for (const b of page.data as unknown as (ReconBooking & {
      selectedDate?: string | null;
    })[]) {
      rows.push({
        id: b.id,
        status: b.status,
        stripePaymentIntentId: b.stripePaymentIntentId,
        amountCents: b.amountCents,
        customerId: b.customerId,
        jobId: b.jobId,
        agreementId: b.agreementId,
        servicePlanId: b.servicePlanId,
        recurring: b.recurring,
        name: b.name,
        email: b.email,
        // GL-05: the committed date, for the relationship check.
        selectedDate: b.selectedDate,
      } as ReconBooking);
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return rows;
}

type ReconInvoiceRow = ReconInvoice & {
  customerId?: string | null;
  jobId?: string | null;
  amountCents?: number | null;
};

async function allInvoicesForReconcile(): Promise<ReconInvoiceRow[]> {
  const client = await dataClient();
  const rows: ReconInvoiceRow[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.Invoice.list({ nextToken, limit: 200 });
    for (const inv of page.data as unknown as ReconInvoiceRow[]) {
      rows.push({
        id: inv.id,
        status: inv.status,
        stripePaymentIntentId: inv.stripePaymentIntentId,
        // GL-05: ownership facts — reconciliation validates relationships,
        // not just that a paid row with this PaymentIntent exists somewhere.
        customerId: inv.customerId,
        jobId: inv.jobId,
        amountCents: inv.amountCents,
      });
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return rows;
}

/**
 * A get() on a single model, structurally. The generated V6 client type is too
 * deep for the compiler to name across a function boundary (TS2321), so the
 * reconciliation's existence checks go through this minimal shape — we only need
 * to know whether a row came back.
 */
type ChildLookupClient = {
  models: Record<
    "Customer" | "Job" | "Agreement" | "ServicePlan",
    { get: (args: { id: string }) => Promise<{ data: unknown }> }
  >;
};

/** Load each child record a BOOKED booking's checkpoint IDs claim — the FULL
 *  rows, not booleans, so reconciliation can check both existence AND
 *  ownership (a resolving cross-linked child must never count healthy). */
async function childExistenceFor(
  booking: ReconBooking,
  paidInvoiceByPi: Map<
    string,
    { id: string; customerId?: string | null; jobId?: string | null; amountCents?: number | null; stripePaymentIntentId?: string | null }
  >
) {
  const client = (await dataClient()) as unknown as ChildLookupClient;
  const [customerRow, jobRow, agreementRow, planRow] = await Promise.all([
    booking.customerId
      ? client.models.Customer.get({ id: booking.customerId }).then((r) => r.data)
      : Promise.resolve(null),
    booking.jobId
      ? client.models.Job.get({ id: booking.jobId }).then((r) => r.data)
      : Promise.resolve(null),
    booking.agreementId
      ? client.models.Agreement.get({ id: booking.agreementId }).then((r) => r.data)
      : Promise.resolve(null),
    booking.servicePlanId
      ? client.models.ServicePlan.get({ id: booking.servicePlanId }).then((r) => r.data)
      : Promise.resolve(null),
  ]);
  const pi = booking.stripePaymentIntentId?.trim();
  const paidInvoiceRow = pi ? paidInvoiceByPi.get(pi) ?? null : null;
  const exists = {
    customer: Boolean(customerRow),
    job: Boolean(jobRow),
    agreement: Boolean(agreementRow),
    paidInvoice:
      (booking.amountCents ?? 0) <= 0 ? true : Boolean(paidInvoiceRow),
    plan: Boolean(planRow),
  };
  const rows: ChildRows = {
    customer: (customerRow as { id: string } | null) ?? null,
    job: (jobRow as ChildRows["job"]) ?? null,
    agreement: (agreementRow as ChildRows["agreement"]) ?? null,
    plan: (planRow as ChildRows["plan"]) ?? null,
    paidInvoice: paidInvoiceRow,
  };
  return { exists, rows };
}

/** Every child record a BOOKED booking is missing — whether the checkpoint ID
 *  is blank (never written) or dangling (written, no longer resolves). */
function missingChildRecords(
  booking: ReconBooking,
  exists: {
    customer: boolean;
    job: boolean;
    agreement: boolean;
    paidInvoice: boolean;
    plan: boolean;
  }
): string[] {
  const missing = new Set<string>();
  if (!booking.customerId) missing.add("customer");
  if (!booking.jobId) missing.add("job");
  if (!booking.agreementId) missing.add("agreement");
  if (booking.recurring && !booking.servicePlanId) missing.add("service plan");
  for (const d of danglingChildRecords(booking, exists)) missing.add(d);
  return [...missing];
}

/**
 * Escalate every overdue exception exactly once. The queue row is still the
 * authority; email is only the manager nudge, and a failed nudge creates its
 * own EMAIL_FAILURE work item through sendEmail.
 */
export async function escalateOverdueOwnedWork() {
  const client = await dataClient();
  if (!("WorkItem" in client.models) || !("WorkEvent" in client.models)) {
    return { overdueWorkEscalated: 0 };
  }
  const now = new Date().toISOString();
  const overdue: {
    id: string;
    title: string;
    detail: string;
    ownerEmail: string;
    ownerTeam: string;
    dueAt: string;
    customerId?: string | null;
  }[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await client.models.WorkItem.listWorkItemByStatusAndDueAt(
      { status: "OPEN" },
      { nextToken, limit: 200 }
    );
    overdue.push(
      ...page.data.filter((item) => !item.escalatedAt && item.dueAt < now)
    );
    nextToken = page.nextToken;
  } while (nextToken);

  let escalated = 0;
  for (const item of overdue) {
    try {
      const escalationSent = await sendEmail({
        to: defaultWorkOwner("OPS"),
        subject: `OVERDUE owned work — ${item.title}`,
        template: "owned-work-overdue",
        customerId: item.customerId,
        relatedId: item.id,
        html: emailShell(
          "Owned work is overdue",
          `<p><strong>${escapeHtmlLite(item.title)}</strong> was due ${escapeHtmlLite(item.dueAt)}.</p>
           <p>Owner: <strong>${escapeHtmlLite(item.ownerEmail)}</strong> (${escapeHtmlLite(item.ownerTeam)}).</p>
           <p>${escapeHtmlLite(item.detail)}</p>
           <p><a href="${process.env.CRM_APP_URL ?? ""}/work">Open the work queue</a></p>`
        ),
      });
      const escalatedAt = new Date().toISOString();
      // History lands first. If the row update fails, a later pass may append
      // a second overdue event, but it can never claim escalation happened
      // while leaving no permanent record of it.
      const event = await client.models.WorkEvent.create({
        workItemId: item.id,
        eventType: "OVERDUE",
        actorEmail: "system@pestbuzzkill.com",
        note: escalationSent
          ? `Deadline passed; escalated to ${defaultWorkOwner("OPS")}.`
          : `Deadline passed; escalation email failed and created separate email-failure work.`,
        occurredAt: escalatedAt,
      });
      if (!event.data) {
        throw new Error(
          event.errors?.map((error) => error.message).join("; ") ||
            "Could not record overdue history"
        );
      }
      const updated = await client.models.WorkItem.update({ id: item.id, escalatedAt });
      if (!updated.data) {
        throw new Error(
          updated.errors?.map((error) => error.message).join("; ") ||
            "Could not mark work escalated"
        );
      }
      escalated++;
    } catch (err) {
      // One broken row must not suppress escalation of the rest of the queue.
      console.error("Owned-work escalation failed", item.id, err);
    }
  }
  return { overdueWorkEscalated: escalated };
}

/** Small HTML escaper — email bodies here interpolate names and emails. */
function escapeHtmlLite(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
