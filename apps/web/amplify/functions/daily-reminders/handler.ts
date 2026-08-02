import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { oneBusinessDayDeadline } from "../shared/businessDays";
import { easternPlusDays, todayEastern, todayUtc } from "../shared/dates";
import { dataClient } from "../shared/dataClient";
import { forEachPage, listAll } from "../shared/pagination";
import {
  emailShell,
  notifyOffice,
  resendQueuedEmail,
  sendEmail,
} from "../shared/email";
import { licenseFactsFor } from "../shared/licenses";
import { isLowStock, onHandFromEntries } from "../shared/inventory";
import { ensureObligation, markObligation } from "../shared/obligations";
import { isWeekday, reconcileCapacityDay } from "../shared/capacity";
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
  openMissingContactWork,
  openOwnedWork,
  resolveOwnedWork,
  workItemId,
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
import { finalizeBooking } from "../shared/bookingFinalize";
import { recordFunnelPaymentFailure } from "../shared/bookingPaymentFailure";
import { stampProcessingNextCheck } from "../shared/bookingPayment";
import {
  computeMoneyMismatches,
  computePlanMismatches,
  computeStateMismatches,
  type Mismatch as ReconMismatch,
  type LedgerInvoice,
  type PlanJobRow,
  type PlanRow,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderSubscription,
  type CustomerRow,
  type StateInvoiceRow,
  type StateJobRow,
} from "../shared/leadershipRecon";
import { formatMoney, formatMonthly, formatYearly } from "../shared/money";

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
  return (await listAll(
    (nextToken) =>
      client.models.Invoice.listInvoiceByStatusAndIssuedAt(
        { status },
        { nextToken, limit: 200 }
      ),
    { pageErrors: "ignore" }
  )) as OwedInvoice[];
}

/** How many days before dueDate a due-soon reminder fires. */
const DUE_SOON_LEAD_DAYS = 3;

/** Days before evidenceDueBy a dispute-deadline alert fires. */
const DISPUTE_ALERT_LEAD_DAYS = 4;

const prettyDate = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

export const handler = async () => {
  const totals: Record<string, unknown>[] = [];
  // GL-22: a subtask that fails must not (a) stop the remaining subtasks, or
  // (b) let the run report a healthy scheduled invocation. Each failure is
  // collected; at the end the run opens ONE owned item naming every failed
  // subtask and THROWS — so the Lambda Errors alarm fires and the invocation
  // is visibly unhealthy, never a caught-and-swallowed "success".
  const failures: { task: string; error: string }[] = [];
  const run = async <T>(
    task: string,
    fn: () => Promise<T>
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`daily-reminders: subtask ${task} FAILED`, err);
      failures.push({
        task,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  // Do this first: an unrelated reminder failure must not stop an already
  // overdue obligation from reaching its escalation path.
  const overdueWork = await run("escalateOverdueOwnedWork", escalateOverdueOwnedWork);
  // T-1 and T-7 reminders — the cron runs once a day, so each fires once.
  // Only T-1 gets the staffing gate: a week out, most visits legitimately
  // aren't routed yet, but by the day before every dated job must be on an
  // active technician's route or the office is told.
  for (const [daysOut, phrasing] of [
    [1, "tomorrow"],
    [7, "in one week"],
  ] as const) {
    const r = await run(`remind:${phrasing}`, () =>
      remind(easternPlusDays(daysOut), phrasing, daysOut === 1)
    );
    if (r) totals.push(r);
  }
  const notBilling = await run("reportPlansNotBilling", reportPlansNotBilling);
  const uncharged = await run("reportUnchargedOneTimeJobs", reportUnchargedOneTimeJobs);
  // Light inventory: nudge the office to reorder any tracked product at or
  // below its reorder point. Informational digest (not owned work), repeats
  // daily until a restock lifts it back above the line.
  const lowStock = await run("reportLowStock", reportLowStock);
  const noNextVisit = await run("reportPlansWithoutNextVisit", reportPlansWithoutNextVisit);
  // Money-out recovery lifecycle.
  const dunning = await run("runDunningRetries", runDunningRetries);
  const invoiceReminders = await run("remindOpenInvoices", remindOpenInvoices);
  const aging = await run("reportArAging", reportArAging);
  const disputes = await run("reportDisputeDeadlines", reportDisputeDeadlines);
  // GL-05: prove, against the real tables and Stripe, that every succeeded
  // booking payment has exactly one complete booking and vice versa.
  const reconciliation = await run("reconcilePaidBookings", reconcilePaidBookings);
  // GL-19: the leadership reconciliations — provider money vs the ledger,
  // provider subscriptions vs plans, and lifecycle/visit state vs money.
  const moneyRecon = await run("reconcileMoneyDaily", reconcileMoneyDaily);
  const planRecon = await run("reconcilePlansDaily", reconcilePlansDaily);
  const stateRecon = await run("reconcileStateDaily", reconcileStateDaily);
  // GL-06: re-read Stripe for every booking still PROCESSING — a missed
  // webhook can never leave a pending debit and its scheduled visit in limbo.
  const processingPayments = await run(
    "reconcileProcessingPayments",
    reconcileProcessingPayments
  );
  // GL-08: resume every plan cancellation a prior attempt could not finish, so
  // an accepted cancel can never sit Pending forever with billing still live.
  const cancellations = await run(
    "reconcilePlanCancellations",
    reconcilePlanCancellations
  );
  const capacity = await run("reconcileCapacity", reconcileCapacity);
  // GL-07: resume every office visit cancel a prior attempt could not finish, so
  // a refunded-but-still-scheduled visit is never stranded.
  const visitChanges = await run("reconcileVisitChanges", reconcileVisitChanges);
  // GL-02: no lead may silently go cold — surface every open lead whose next
  // action is overdue as an owned follow-up, routed to its owner or the team.
  const staleLeads = await run("reportStaleLeads", reportStaleLeads);
  // GL-15: a FLAGGED presence review whose owned case never landed is re-opened
  // here — the obligation is durable on the report and cannot silently vanish.
  const presenceReviews = await run(
    "reconcilePresenceReviews",
    reconcilePresenceReviews
  );
  // GL-17: advance licence-lapse work + capacity effects of expiry.
  const licenses = await run("sweepLicenseLapses", sweepLicenseLapses);
  // GL-09: stale lifecycle commands (a process stop mid-transition) are
  // escalated to owned work and stale claims reclaimed — a customer can never
  // be stuck mid-transition silently or blocked forever.
  const lifecycle = await run(
    "reconcileLifecycleTransitions",
    reconcileLifecycleTransitions
  );
  // GL-12: tomorrow's staffed visits must pass the pure dispatch facts — a
  // missing classification or placeholder address is owned work today, not a
  // doorstep discovery tomorrow.
  const readiness = await run("sweepDispatchReadiness", sweepDispatchReadiness);
  // GL-17: seasonal obligations — month rollover marks missed months (no
  // catch-up) and ensures the current in-season month is visible.
  const seasonal = await run("sweepSeasonalObligations", sweepSeasonalObligations);
  // GL-11: a customer request may never exist without deduplicated office
  // ownership — this repairs the crash window between "row saved" and
  // "queue item opened" for portal requests and guarantee callbacks.
  const requestOwnership = await run(
    "reconcileRequestOwnership",
    reconcileRequestOwnership
  );
  // GL-11: a group change that stopped partway (PARTIAL / stale lease) is
  // re-driven to a VERIFIED completion through crm-admin, and one that
  // keeps failing becomes visible owned work.
  const groupChanges = await run("reconcileGroupChanges", reconcileGroupChanges);
  // GL-03: QUEUED means retried — throttled sends are re-sent from their
  // stored bodies; stuck/expired/unresendable ones become owned work.
  const emailRetries = await run("retryQueuedEmails", retryQueuedEmails);
  console.log("Reminder totals:", JSON.stringify(totals));
  const results = [
    ...totals,
    notBilling,
    uncharged,
    lowStock,
    noNextVisit,
    dunning,
    invoiceReminders,
    aging,
    disputes,
    overdueWork,
    reconciliation,
    moneyRecon,
    planRecon,
    stateRecon,
    processingPayments,
    cancellations,
    capacity,
    visitChanges,
    staleLeads,
    presenceReviews,
    licenses,
    seasonal,
    readiness,
    lifecycle,
    requestOwnership,
    groupChanges,
    emailRetries,
  ];
  if (failures.length) {
    await openOwnedWork({
      kind: "INFRA_ALERT",
      dedupeKey: `daily-reminders-incomplete:${todayUtc()}`,
      title: `Daily operations run incomplete — ${failures.length} subtask${failures.length === 1 ? "" : "s"} failed`,
      detail: `Today's scheduled operations run finished with failures. Obligations those subtasks watch (reminders, dunning, reconciliation, sweeps) may be unmet until they run clean:\n${failures
        .map((f) => `- ${f.task}: ${f.error}`)
        .join("\n")}`,
      relatedId: "daily-reminders",
      resolutionAction:
        "Check the daily-reminders logs, fix or escalate the failing subtask, and re-run (or wait for tomorrow's run) — then verify it completes clean.",
      ownerTeam: "OPS",
    }).catch((err) =>
      console.error("daily-reminders: could not record the failed run", err)
    );
    // The invocation itself must read FAILED — a partially completed
    // scheduled run is not a healthy scheduled run.
    throw new Error(
      `daily-reminders: ${failures.length} subtask(s) failed: ${failures
        .map((f) => f.task)
        .join(", ")}`
    );
  }
  return results;
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
    await forEachPage(
      (nextToken) =>
        client.models.CustomerLifecycleCommand.list({
          limit: 200,
          nextToken,
        }),
      async (items) => {
        for (const cmd of items) {
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
      },
      { pageErrors: "ignore" }
    );
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
    await forEachPage(
      (nextToken) =>
        client.models.Job.listJobByScheduledDate(
          { scheduledDate: tomorrow },
          { limit: 200, nextToken }
        ),
      async (items) => {
        for (const job of items) {
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
      },
      { pageErrors: "ignore" }
    );
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
    const today = todayEastern();
    const warnDate = easternPlusDays(LICENSE_WARN_DAYS);
    await forEachPage(
      (nextToken) =>
        client.models.Technician.list({
          limit: 200,
          nextToken,
        }),
      async (techs) => {
      for (const tech of techs) {
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
        await forEachPage(
          (nextToken) =>
            client.models.Job.list({
              filter: { technicianId: { eq: tech.id } },
              limit: 200,
              nextToken,
            }),
          async (jobs) => {
            for (const job of jobs) {
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
          },
          { pageErrors: "ignore" }
        );
      }
      },
      { pageErrors: "ignore" }
    );
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
    await forEachPage(
      (nextToken) =>
        client.models.ServicePlan.list({
          filter: { status: { eq: "ACTIVE" } },
          limit: 200,
          nextToken,
        }),
      async (plansPage) => {
      for (const plan of plansPage) {
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
        const obligations = await listAll(
          (nextToken) =>
            client.models.TreatmentObligation.listTreatmentObligationByServicePlanIdAndMonthKey(
              { servicePlanId: plan.id },
              { limit: 200, nextToken }
            ),
          { pageErrors: "ignore" }
        );
        for (const ob of obligations) {
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
      },
      { pageErrors: "ignore" }
    );
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
    await forEachPage(
      (nextToken) =>
        client.models.ServiceReport.list({
          filter: { presenceReviewStatus: { eq: "FLAGGED" } },
          limit: 200,
          nextToken,
        }),
      async (reports) => {
        for (const report of reports) {
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
      },
      { pageErrors: "ignore" }
    );
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
  const ids: string[] = (
    await listAll(
      (nextToken) =>
        client.models.VisitChangeClaim.list({
          limit: 200,
          nextToken,
        }),
      { pageErrors: "ignore" }
    )
  ).map((cmd) => cmd.id);

  let completed = 0;
  let stillPending = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const outcome = await resumeVisitChange(stripe, id, { auto: true });
      const done =
        outcome.outcome === "COMPLETE" ||
        ("alreadyCanceled" in outcome && outcome.alreadyCanceled === true);
      if (done) completed++;
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
  for (const cmd of await listAll(
    (nextToken) =>
      client.models.PlanCancellationClaim.list({
        limit: 200,
        nextToken,
      }),
    { pageErrors: "ignore" }
  )) {
    // Settled commands persist as the readable outcome (stage COMPLETE) —
    // they are done, not open work.
    if (cmd.stage === "COMPLETE") continue;
    ids.push(cmd.id);
  }

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
 * GL-04 — heal every upcoming day's capacity ledger from ground truth (jobs +
 * live claims) and release expired checkout claims, so counter drift or a
 * crashed checkout can never hold (or leak) capacity for more than a day.
 */
export async function reconcileCapacity() {
  let reconciled = 0;
  let expired = 0;
  let unverified = 0;
  try {
    const today = new Date();
    for (let i = 0; i < 45; i++) {
      const date = new Date(today.getTime() + i * 86_400_000)
        .toISOString()
        .slice(0, 10);
      if (!isWeekday(date)) continue;
      const res = await reconcileCapacityDay(
        date,
        process.env.GOOGLE_ROUTES_API_KEY ?? null
      );
      reconciled++;
      expired += res.expiredClaims;
      unverified += res.unverified;
    }
  } catch (err) {
    console.error("reconcileCapacity failed", err);
  }
  return {
    task: "reconcile-capacity" as const,
    reconciled,
    expiredClaims: expired,
    unverifiedSlots: unverified,
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
  try {
    await forEachPage(
      (nextToken) =>
        client.models.Customer.listCustomerByStatusAndDisplayName(
          { status: "LEAD" },
          { limit: 200, nextToken }
        ),
      async (leads) => {
      for (const lead of leads) {
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
      },
      { pageErrors: "ignore" }
    );
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
/**
 * Low-stock reorder digest. Sums the append-only ProductStockEntry ledger per
 * tracked product and emails the office the ones at or below their reorder
 * point. Repeats daily until restocked — the office adds a PURCHASE entry on
 * More → Inventory, which lifts on-hand back above the line and clears it.
 */
async function reportLowStock() {
  const client = await dataClient();
  const products = await listAll(
    (nextToken) => client.models.Product.list({ limit: 1000, nextToken }),
    { pageErrors: "ignore" }
  );
  // Only an active, tracked product with a reorder point can be "low".
  const tracked = products.filter(
    (p) => p.active && p.trackInventory && typeof p.reorderPoint === "number"
  );
  if (tracked.length === 0) return { lowStock: 0, notified: false };

  const fmtQty = (n: number) =>
    (Math.round(n * 100) / 100).toString();
  const low: {
    name: string;
    onHand: number;
    reorderPoint: number;
    unit: string;
  }[] = [];
  for (const p of tracked) {
    const entries: { deltaBaseUnits?: number | null }[] = await listAll(
      (nextToken) =>
        client.models.ProductStockEntry.listProductStockEntryByProductId(
          { productId: p.id },
          { nextToken, limit: 500 }
        ),
      { pageErrors: "ignore" }
    );
    const onHand = onHandFromEntries(entries);
    if (isLowStock(p, onHand)) {
      low.push({
        name: p.name,
        onHand,
        reorderPoint: p.reorderPoint as number,
        unit: p.stockUnit ?? "",
      });
    }
  }
  if (low.length === 0) {
    console.log("Low-stock digest: none");
    return { lowStock: 0, notified: false };
  }

  const rows = low
    .sort((a, b) => a.onHand - b.onHand)
    .map(
      (l) =>
        `<li><strong>${l.name}</strong> — ${fmtQty(l.onHand)} ${l.unit} on hand (reorder at ${fmtQty(l.reorderPoint)} ${l.unit})</li>`
    );
  const notified = await notifyOffice({
    subject: `${low.length} product${low.length === 1 ? " is" : "s are"} low on stock`,
    heading: "Low on stock — time to reorder",
    template: "ops-low-stock-digest",
    bodyHtml: `<p>These products are at or below their reorder point:</p>
       <ul>${rows.join("")}</ul>
       <p>Once the order arrives, record it on <strong>More &rsaquo; Inventory</strong> to clear this.</p>`,
  });
  console.log(`Low-stock digest: ${low.length} low, notified=${notified}`);
  return { lowStock: low.length, notified };
}

async function reportPlansNotBilling() {
  const client = await dataClient();

  const plans: {
    id: string;
    customerId: string;
    planName: string;
    priceCents: number;
    status: string | null;
    stripeSubscriptionId?: string | null;
  }[] = await listAll(
    (nextToken) =>
      client.models.ServicePlan.list({
        filter: { status: { eq: "ACTIVE" } },
        nextToken,
        limit: 200,
      }),
    { pageErrors: "ignore" }
  );

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
    let hasCompleted = false;
    await forEachPage(
      (nextToken) =>
        client.models.Job.listJobByServicePlanId(
          { servicePlanId: plan.id },
          { limit: 50, nextToken }
        ),
      (jobs) => {
        if (jobs.some((j) => j.status === "COMPLETED")) {
          hasCompleted = true;
          return false;
        }
      },
      { pageErrors: "ignore" }
    );
    if (hasCompleted) serviced.push(plan);
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
      return `<li><strong>${customer?.displayName ?? p.customerId}</strong> — ${p.planName}, ${formatMonthly(p.priceCents)}</li>`;
    })
  );
  const annual = serviced.reduce((s, p) => s + p.priceCents * 12, 0);

  const notified = await notifyOffice({
    subject: `${serviced.length} plan${serviced.length === 1 ? " is" : "s are"} being serviced without billing`,
    heading: "Serviced but not billing",
    template: "ops-not-billing-digest",
    bodyHtml: `<p>These plans have had their first visit but no subscription is running, so they are being serviced for free. Together that is about <strong>${formatYearly(annual)}</strong>.</p>
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
  }[] = await listAll(
    (nextToken) =>
      client.models.Job.listJobByStatusAndScheduledDate(
        { status: "COMPLETED" },
        { filter: { type: { eq: "ONE_TIME" } }, nextToken, limit: 200 }
      ),
    { pageErrors: "ignore" }
  );

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
  await forEachPage(
    (nextToken) =>
      client.models.Invoice.list({
        nextToken,
        limit: 200,
      }),
    (invs) => {
      for (const inv of invs) {
        if (inv.jobId && inv.status !== "FAILED" && inv.status !== "VOID") {
          covered.add(inv.jobId);
        }
      }
    },
    { pageErrors: "ignore" }
  );

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
      return `<li><strong>${customer?.displayName ?? j.customerId}</strong> — ${j.serviceType}${when ? `, completed ${when}` : ""}: ${formatMoney(j.priceCents ?? 0)}</li>`;
    })
  );
  const total = uncharged.reduce((s, j) => s + (j.priceCents ?? 0), 0);

  const notified = await notifyOffice({
    subject: `${uncharged.length} completed job${uncharged.length === 1 ? " has" : "s have"} never been charged`,
    heading: "Completed but never charged",
    template: "ops-uncharged-jobs-digest",
    bodyHtml: `<p>The work is done and no charge or invoice exists for ${uncharged.length === 1 ? "this job" : "these jobs"} — together <strong>${formatMoney(total)}</strong> nobody is collecting.</p>
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
  const today = todayEastern();

  const plans: {
    id: string;
    customerId: string;
    planName: string;
    priceCents: number;
    status: string | null;
    stripeSubscriptionId?: string | null;
  }[] = await listAll(
    (nextToken) =>
      client.models.ServicePlan.list({
        filter: { status: { eq: "ACTIVE" } },
        nextToken,
        limit: 200,
      }),
    { pageErrors: "ignore" }
  );

  // A plan has a next visit if anything is queued (UNSCHEDULED), on the
  // calendar today or later (SCHEDULED), or being worked right now
  // (IN_PROGRESS). A visit dated in the past that never happened does not
  // count — nobody is coming.
  const missing: typeof plans = [];
  for (const plan of plans) {
    let hasVisit = false;
    await forEachPage(
      (nextToken) =>
        client.models.Job.listJobByServicePlanId(
          { servicePlanId: plan.id },
          { nextToken, limit: 200 }
        ),
      (jobsPage) => {
        hasVisit = jobsPage.some(
          (j) =>
            j.status === "UNSCHEDULED" ||
            j.status === "IN_PROGRESS" ||
            (j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today)
        );
        if (hasVisit) return false;
      },
      { pageErrors: "ignore" }
    );
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
      return `<li><strong>${customer?.displayName ?? p.customerId}</strong> — ${p.planName}, ${formatMonthly(p.priceCents)}${p.stripeSubscriptionId ? " — <strong>billing is running</strong>" : ""}</li>`;
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
      `<li><strong>${names.get(job.customerId)}</strong> — ${job.serviceType}: ${why}</li>`
    );
    await openOwnedWork({
      kind: "UNSTAFFED_VISIT",
      dedupeKey: job.id,
      title: `Staff tomorrow's visit: ${names.get(job.customerId)}`,
      detail: `${job.serviceType} is scheduled for ${date}, but ${why}. The customer reminder was suppressed.`,
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
  const jobs: DatedJob[] = await listAll(
    (nextToken) =>
      client.models.Job.listJobByScheduledDate(
        { scheduledDate: date },
        { nextToken, limit: 200 }
      ),
    { pageErrors: "ignore" }
  );

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
      .map((j) => `<li><strong>${j.serviceType}</strong></li>`)
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
  const amount = formatMoney(inv.amountCents);

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
    // GL-06: an in-flight bank debit is not collectable — reminding (or any
    // collection) while it clears would double-pay the customer.
    if ((inv as { pendingDebitIntentId?: string | null }).pendingDebitIntentId)
      continue;
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
    // GL-06: an in-flight bank debit is not receivable-late — it is money in
    // transit, tracked by the processing-payments reconcile, not AR aging.
  ].filter(
    (inv) =>
      !(inv as { pendingDebitIntentId?: string | null }).pendingDebitIntentId
  );
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
    return `<tr><td style="padding:4px 12px 4px 0;">${AGING_BUCKET_LABEL[b]}</td><td style="padding:4px 0;text-align:right;">${formatMoney(t.cents)}</td><td style="padding:4px 0 4px 12px;text-align:right;color:#888;">${t.count}</td></tr>`;
  }).join("");

  const notified = await notifyOffice({
    subject: `AR aging: ${formatMoney(grand)} outstanding across ${outstanding.length} invoice${outstanding.length === 1 ? "" : "s"}`,
    heading: "Accounts receivable — aging",
    template: "ops-ar-aging",
    bodyHtml: `<p>Money owed to BuzzKill right now, by how overdue it is:</p>
       <table style="border-collapse:collapse;font-size:14px;"><tbody>${rows}</tbody></table>
       <p style="margin-top:12px;"><strong>Total outstanding: ${formatMoney(grand)}</strong></p>
       <p style="color:#666;font-size:13px;">The oldest buckets are the ones to work first — the longer money sits, the less of it comes back.</p>`,
  });
  console.log(
    `AR aging: ${outstanding.length} invoices, ${formatMoney(grand)} outstanding, notified=${notified}`
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
  const disputes = (await listAll(
    (nextToken) =>
      client.models.Dispute.listDisputeByStatus(
        { status: "NEEDS_RESPONSE" },
        { nextToken, limit: 200 }
      ),
    { pageErrors: "ignore" }
  )) as {
    id: string;
    stripeDisputeId: string;
    customerId?: string | null;
    amountCents: number;
    evidenceDueBy?: string | null;
    ownerEmail?: string | null;
  }[];

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
      return `<li><strong>${escapeHtmlLite(String(name))}</strong> — ${formatMoney(d.amountCents)}, evidence due <strong>${due}</strong>. Owner: ${d.ownerEmail ? escapeHtmlLite(d.ownerEmail) : "<strong>unassigned</strong>"}</li>`;
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
/**
 * GL-06 — the processing-payment reconcile sweep. The webhook is the primary
 * signal; this pass is the safety net that re-reads Stripe for every booking
 * still PROCESSING, so a missed/undelivered webhook can never leave a pending
 * debit (and its scheduled visit) in limbo:
 *
 *  - provider says succeeded → the normal success finalization resumes onto
 *    the same records and flips them paid;
 *  - provider says failed/canceled → the shared failure path unwinds or
 *    converts the commitment and notices the customer, exactly once;
 *  - still processing → the next-check stamp advances, and once the expected
 *    settlement date passes, an owned Finance case (one business day) exists
 *    until the provider result lands;
 *  - a PROCESSING booking whose commitment never completed (no job yet)
 *    resumes the idempotent pending finalization;
 *  - an unreadable provider result is owned work, never a silent skip.
 */
export async function reconcileProcessingPayments() {
  const client = await dataClient();
  // Unit fakes (and a container straddling a deploy) may lack the model.
  if (!("BookingRequest" in client.models)) return { processingPayments: 0 };
  const now = new Date();
  type ProcessingBookingRow = {
    id: string;
    jobId?: string | null;
    stripePaymentIntentId?: string | null;
    processingNextCheckAt?: string | null;
    processingExpectedBy?: string | null;
    processingMethodLabel?: string | null;
    name?: string | null;
    email?: string | null;
    amountCents?: number | null;
    selectedDate?: string | null;
    customerId?: string | null;
  };
  // Belt-and-braces status filter — a lister that ignores the filter (unit
  // fakes) must not make this pass reconcile settled bookings.
  const rows: ProcessingBookingRow[] = (
    (await listAll(
      (nextToken) =>
        client.models.BookingRequest.list({
          filter: { status: { eq: "PROCESSING" } },
          nextToken,
          limit: 200,
        }),
      { pageErrors: "ignore" }
    )) as unknown as (ProcessingBookingRow & {
      status?: string | null;
    })[]
  ).filter((b) => b.status === "PROCESSING");
  if (rows.length === 0) {
    return { processingPayments: 0 };
  }
  let stripe: ReturnType<typeof stripeClient>;
  try {
    stripe = stripeClient();
  } catch (err) {
    // No provider access = no reconciliation — loud, never a silent all-clear.
    console.error("reconcileProcessingPayments: no Stripe client", err);
    await openOwnedWork({
      kind: "PAYMENT_PROCESSING_OVERDUE",
      dedupeKey: "processing-recon-stripe-unavailable",
      title: "Processing-payment reconciliation could not reach Stripe",
      detail: `${rows.length} booking(s) are PROCESSING but the daily reconcile has no Stripe access: ${err instanceof Error ? err.message : String(err)}.`,
      relatedId: "reconciliation",
      resolutionAction:
        "Fix the STRIPE_SECRET_KEY configuration, then re-run the daily reconcile.",
      ownerTeam: "FINANCE",
    });
    return { processingPayments: rows.length, skipped: "stripe-unavailable" };
  }

  let settled = 0;
  let failed = 0;
  let stillProcessing = 0;
  let overdue = 0;
  let resumedFinalize = 0;
  let unreadable = 0;
  for (const b of rows) {
    try {
      if (!b.stripePaymentIntentId) {
        // Contradictory: PROCESSING with no payment attempt behind it.
        unreadable++;
        await openOwnedWork({
          kind: "PAYMENT_PROCESSING_OVERDUE",
          dedupeKey: b.id,
          title: `Processing booking has no payment attempt: ${b.name ?? b.id}`,
          detail: `Booking ${b.id} is PROCESSING but records no PaymentIntent, so its provider state cannot be read. Find the customer's payment in Stripe and reconcile by hand.`,
          customerId: b.customerId ?? undefined,
          relatedId: b.id,
          resolutionAction:
            "Search Stripe for this customer's payment. Reconcile the booking to the real payment state, then confirm the money state.",
          ownerTeam: "FINANCE",
        });
        continue;
      }
      const pi = await stripe.paymentIntents.retrieve(b.stripePaymentIntentId);
      if (pi.status === "succeeded") {
        settled++;
        await finalizeBooking({
          bookingRequestId: b.id,
          paymentIntentId: pi.id,
          amountReceived: pi.amount_received,
          paymentMethodId:
            typeof pi.payment_method === "string"
              ? pi.payment_method
              : (pi.payment_method?.id ?? null),
        });
      } else if (
        pi.status === "requires_payment_method" ||
        pi.status === "canceled"
      ) {
        failed++;
        await recordFunnelPaymentFailure({
          bookingRequestId: b.id,
          intentId: pi.id,
          reason:
            pi.last_payment_error?.message ??
            (pi.status === "canceled"
              ? "The payment was canceled before it completed."
              : "The bank payment did not go through."),
        });
      } else {
        // Still in flight. Resume an incomplete pending finalization first —
        // a missed processing webhook must not leave the customer with a
        // held debit and no scheduled commitment.
        if (!b.jobId) {
          resumedFinalize++;
          await finalizeBooking({
            bookingRequestId: b.id,
            paymentIntentId: pi.id,
            amountReceived: pi.amount,
            paymentMethodId:
              typeof pi.payment_method === "string"
                ? pi.payment_method
                : (pi.payment_method?.id ?? null),
            pending: { methodLabel: b.processingMethodLabel ?? null },
          });
        }
        stillProcessing++;
        await stampProcessingNextCheck(
          b.id,
          new Date(now.getTime() + 6 * 60 * 60_000).toISOString()
        );
        if (
          b.processingExpectedBy &&
          now.toISOString().slice(0, 10) > b.processingExpectedBy
        ) {
          overdue++;
          await openOwnedWork({
            kind: "PAYMENT_PROCESSING_OVERDUE",
            dedupeKey: b.id,
            title: `Bank payment overdue: ${b.name ?? b.id}`,
            detail: `The ${formatMoney(((b.amountCents ?? 0) as number))} bank debit for booking ${b.id} (${b.email ?? "no email"}, visit ${b.selectedDate ?? "unscheduled"}) was expected to settle by ${b.processingExpectedBy} and Stripe still reports it processing. The scheduled visit is riding on money that hasn't arrived.`,
            customerId: b.customerId ?? undefined,
            relatedId: b.id,
            sourceUrl: b.customerId ? `/customers/${b.customerId}` : undefined,
            resolutionAction:
              "Check the PaymentIntent in Stripe. If it settled or failed, re-run the reconcile; if it is stuck, contact Stripe support and decide the visit with the customer.",
            ownerTeam: "FINANCE",
          });
        }
      }
    } catch (err) {
      // A provider read failure is owned, never a silent skip.
      unreadable++;
      console.error("reconcileProcessingPayments:", b.id, err);
      await openOwnedWork({
        kind: "PAYMENT_PROCESSING_OVERDUE",
        dedupeKey: b.id,
        title: `Could not reconcile a processing payment: ${b.name ?? b.id}`,
        detail: `The daily processing-payment reconcile could not resolve booking ${b.id} against Stripe: ${err instanceof Error ? err.message : String(err)}. The booking remains PROCESSING and will be retried tomorrow; resolve sooner if the visit date is near.`,
        customerId: b.customerId ?? undefined,
        relatedId: b.id,
        resolutionAction:
          "Open the PaymentIntent in Stripe, confirm its real state, and re-run the reconcile (or finalize/fail the booking by hand).",
        ownerTeam: "FINANCE",
      });
    }
  }
  return {
    processingPayments: rows.length,
    settled,
    failed,
    stillProcessing,
    overdue,
    resumedFinalize,
    unreadable,
  };
}


// ---------------------------------------------------------------------------
// GL-19 — daily leadership reconciliations (money / plans / state)
// ---------------------------------------------------------------------------

/** Persist one ReconRun row per kind/day so the Command view reads the
 *  morning's answer without an engineering query. */
async function writeReconRun(
  kind: "MONEY" | "PLANS" | "STATE",
  summary: Record<string, unknown>,
  mismatches: number
): Promise<void> {
  try {
    const client = await dataClient();
    if (!("ReconRun" in client.models)) return;
    const runDate = todayEastern();
    const id = `${kind}#${runDate}`;
    const row = {
      id,
      kind,
      runDate,
      summary: JSON.stringify(summary),
      mismatches,
      healthy: mismatches === 0,
    };
    const { data: created } = await client.models.ReconRun.create(row);
    if (!created) await client.models.ReconRun.update(row);
  } catch (err) {
    console.error(`writeReconRun ${kind} failed`, err);
  }
}

async function openReconMismatches(
  kind: "MONEY_MISMATCH" | "PLAN_MISMATCH" | "STATE_MISMATCH",
  mismatches: ReconMismatch[]
): Promise<void> {
  for (const m of mismatches) {
    await openOwnedWork({
      kind,
      dedupeKey: m.key,
      title: m.title,
      detail: m.detail,
      customerId: m.customerId ?? undefined,
      relatedId: m.relatedId,
      sourceUrl: m.customerId ? `/customers/${m.customerId}` : undefined,
      resolutionAction:
        kind === "STATE_MISMATCH"
          ? "Make status, schedule, and money agree (correct the wrong one), then close with the verified state."
          : "Reconcile the provider record against the CRM, correct whichever is wrong, and close with Finance's sign-off.",
      ownerTeam: m.team,
    });
  }
}

/**
 * GL-19 — daily MONEY reconciliation: every succeeded provider payment in
 * the window equals one CRM paid invoice (funnel money is the GL-05 pass's),
 * every provider refund is recorded, and net cash is explainable. Mismatches
 * are owned Finance work; the summary lands on the Command view.
 */
export async function reconcileMoneyDaily() {
  const client = await dataClient();
  if (!("ReconRun" in client.models)) return { skipped: "no-model" };
  let stripe: ReturnType<typeof stripeClient>;
  try {
    stripe = stripeClient();
  } catch (err) {
    console.error("reconcileMoneyDaily: no Stripe client", err);
    throw err instanceof Error ? err : new Error(String(err));
  }
  const configured = Number(process.env.RECONCILE_WINDOW_DAYS ?? 45);
  const windowDays =
    Number.isFinite(configured) && configured > 0 ? configured : 45;
  const windowStartIso = new Date(
    Date.now() - windowDays * 86_400_000
  ).toISOString();
  const gte = Math.floor(Date.parse(windowStartIso) / 1000);

  const payments: ProviderPayment[] = [];
  let startingAfter: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await stripe.paymentIntents.list({
      created: { gte },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const pi of page.data) {
      if (pi.status !== "succeeded") continue;
      payments.push({
        id: pi.id,
        amountCents: pi.amount_received ?? 0,
        bookingRequestId: pi.metadata?.bookingRequestId ?? null,
        stripeInvoiceId: ((): string | null => {
          // Older API shapes carry `invoice` on the PaymentIntent; the
          // current SDK types omit it — read it loosely either way.
          const inv = (pi as unknown as { invoice?: string | { id: string } | null })
            .invoice;
          return typeof inv === "string" ? inv : (inv?.id ?? null);
        })(),
      });
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }
  const refunds: ProviderRefund[] = [];
  startingAfter = undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await stripe.refunds.list({
      created: { gte },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const r of page.data) {
      if (r.status === "failed" || r.status === "canceled") continue;
      const pi =
        typeof r.payment_intent === "string"
          ? r.payment_intent
          : (r.payment_intent?.id ?? null);
      if (pi) refunds.push({ paymentIntentId: pi, amountCents: r.amount });
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }

  const invoices: LedgerInvoice[] = (await listAll(
    (nextToken) => client.models.Invoice.list({ nextToken, limit: 200 }),
    { pageErrors: "ignore" }
  )) as unknown as LedgerInvoice[];

  const { mismatches, summary } = computeMoneyMismatches({
    payments,
    refunds,
    invoices,
    windowStartIso,
  });
  await openReconMismatches("MONEY_MISMATCH", mismatches);
  await writeReconRun("MONEY", { ...summary, windowDays }, mismatches.length);
  return { moneyRecon: summary };
}

/**
 * GL-19 — daily PLAN reconciliation: provider subscriptions vs CRM plans
 * (canceled-still-billing, active-but-provider-canceled, provider-only
 * billing, delinquent plans with scheduled visits).
 */
export async function reconcilePlansDaily() {
  const client = await dataClient();
  if (!("ReconRun" in client.models)) return { skipped: "no-model" };
  const stripe = stripeClient();
  const subscriptions: ProviderSubscription[] = [];
  let startingAfter: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await stripe.subscriptions.list({
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const s of page.data) {
      subscriptions.push({ id: s.id, status: s.status });
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1]?.id;
    if (!startingAfter) break;
  }
  const plans: PlanRow[] = (await listAll(
    (nextToken) => client.models.ServicePlan.list({ nextToken, limit: 200 }),
    { pageErrors: "ignore" }
  )) as unknown as PlanRow[];
  const jobs: PlanJobRow[] = (await listAll(
    (nextToken) =>
      client.models.Job.list({
        nextToken,
        limit: 200,
      }),
    { pageErrors: "ignore" }
  )) as unknown as PlanJobRow[];

  const { mismatches, summary } = computePlanMismatches({
    subscriptions,
    plans,
    jobs,
    todayIso: todayEastern(),
  });
  await openReconMismatches("PLAN_MISMATCH", mismatches);
  await writeReconRun("PLANS", summary, mismatches.length);
  return { planRecon: summary };
}

/**
 * GL-19 — daily STATE reconciliation: lifecycle vs schedule vs money
 * (deactivated customers with live work/plans; canceled visits holding open
 * invoices).
 */
export async function reconcileStateDaily() {
  const client = await dataClient();
  if (!("ReconRun" in client.models)) return { skipped: "no-model" };
  const listAllRows = <T>(model: {
    list(o: {
      nextToken?: string | null;
      limit?: number;
    }): Promise<{ data: unknown[]; nextToken?: string | null }>;
  }): Promise<T[]> =>
    listAll((nextToken) => model.list({ nextToken, limit: 200 }), {
      pageErrors: "ignore",
    }) as Promise<T[]>;
  const customers = await listAllRows<CustomerRow>(client.models.Customer);
  const jobs = await listAllRows<StateJobRow>(client.models.Job);
  const plans = await listAllRows<PlanRow>(client.models.ServicePlan);
  const invoices = await listAllRows<StateInvoiceRow>(client.models.Invoice);

  const { mismatches, summary } = computeStateMismatches({
    customers,
    jobs,
    plans,
    invoices,
    todayIso: todayEastern(),
  });
  await openReconMismatches("STATE_MISMATCH", mismatches);
  await writeReconRun("STATE", summary, mismatches.length);
  return { stateRecon: summary };
}

/**
 * GL-11 — atomic request ownership, repaired: an OPEN portal request or a
 * REQUESTED guarantee callback whose owned queue item never landed (a crash
 * between "row saved" and "queue item opened", with no customer retry) is
 * re-entered into the shared Office queue here. openOwnedWork is
 * deduplicated by (kind, dedupeKey), and rows whose item is already OPEN
 * are skipped, so the sweep never spams working items.
 */
export async function reconcileRequestOwnership() {
  const client = await dataClient();
  let portalRepaired = 0;
  let callbacksRepaired = 0;
  let contactRepaired = 0;

  const itemMissingOrResolved = async (
    kind: "CUSTOMER_REQUEST" | "CALLBACK_PROMISE",
    dedupeKey: string
  ): Promise<boolean> => {
    if (!("WorkItem" in client.models)) return false;
    const { data } = await client.models.WorkItem.get({
      id: workItemId(kind, dedupeKey),
    });
    return !data || data.status === "RESOLVED";
  };

  if ("PortalRequest" in client.models) {
    await forEachPage(
      (nextToken) =>
        client.models.PortalRequest.list({
          limit: 200,
          nextToken,
        }),
      async (reqs) => {
      for (const req of reqs) {
        if (req.status !== "OPEN") continue;
        if (!(await itemMissingOrResolved("CUSTOMER_REQUEST", req.id))) continue;
        const opened = await openOwnedWork({
          kind: "CUSTOMER_REQUEST",
          dedupeKey: req.id,
          title: `Portal request without an owner: ${req.customerId}`,
          detail: `Portal request ${req.id} (${req.kind ?? "HELP"}) is OPEN but had no live queue item — its submission never reached the office. ${req.message ? `"${String(req.message)}"` : ""} Answer within one business day; the customer watches this request in the portal.`,
          customerId: req.customerId ?? undefined,
          relatedId: req.id,
          sourceUrl: req.customerId ? `/customers/${req.customerId}` : undefined,
          resolutionAction:
            "Handle the request with the customer, then resolve it WITH AN ANSWER from the customer screen (the portal shows your note).",
          ownerTeam: "OPS",
        });
        if (opened) portalRepaired++;
      }
      },
      { pageErrors: "ignore" }
    );
  }

  // GL-03: a website CONTACT promise (the funnel's review fallback) may
  // never exist without its owned SALES action. The deadline is anchored to
  // when the promise was MADE (the booking's creation), not to when this
  // sweep found it — the customer's one-business-day clock never restarts.
  if ("BookingRequest" in client.models) {
    await forEachPage(
      (nextToken) =>
        (
          client.models.BookingRequest.list as (a: object) => Promise<{
            data: Record<string, unknown>[];
            nextToken?: string | null;
          }>
        )({ limit: 200, nextToken }),
      async (bookings) => {
      for (const b of bookings) {
        if (b.status !== "CONTACT") continue;
        const id = String(b.id);
        if (!(await itemMissingOrResolved("CALLBACK_PROMISE", id))) continue;
        const madeAt = b.createdAt ? new Date(String(b.createdAt)) : new Date();
        const opened = await openOwnedWork({
          kind: "CALLBACK_PROMISE",
          dedupeKey: id,
          title: `Website contact promise without an owner: ${b.name ?? id}`,
          detail: `Booking request ${id} promised ${b.name ?? "a lead"} (${b.email ?? "no email"}) a follow-up, but no live owned action existed — its creation never reached the queue. The one-business-day clock started ${madeAt.toISOString()}.`,
          relatedId: id,
          sourceUrl: "/work",
          dueAt: (await oneBusinessDayDeadline(madeAt)).toISOString(),
          resolutionAction:
            "Reach the lead by their promised deadline (call if consented, otherwise email), record the outcome, and send the correct next step.",
          ownerTeam: "SALES",
        });
        if (opened) contactRepaired++;
      }
      },
      { pageErrors: "ignore" }
    );
  }

  if ("CallbackRequest" in client.models) {
    await forEachPage(
      (nextToken) =>
        client.models.CallbackRequest.list({
          limit: 200,
          nextToken,
        }),
      async (callbacks) => {
      for (const cb of callbacks) {
        if (cb.status !== "REQUESTED") continue;
        if (!(await itemMissingOrResolved("CALLBACK_PROMISE", cb.id))) continue;
        const opened = await openOwnedWork({
          kind: "CALLBACK_PROMISE",
          dedupeKey: cb.id,
          title: `Guarantee callback without an owner: ${cb.customerId}`,
          detail: `Callback ${cb.id} is REQUESTED but had no live queue item — its submission never reached the office. Promised return by ${cb.promisedBy ?? "(unset)"}; schedule it from the customer screen (the visit is $0 by construction).`,
          customerId: cb.customerId ?? undefined,
          relatedId: cb.id,
          sourceUrl: cb.customerId ? `/customers/${cb.customerId}` : undefined,
          resolutionAction:
            "Open the customer, schedule the callback visit onto a technician (no later than the promised date), and confirm the customer knows the day.",
          ownerTeam: "OPS",
        });
        if (opened) callbacksRepaired++;
      }
      },
      { pageErrors: "ignore" }
    );
  }

  return {
    task: "reconcileRequestOwnership",
    portalRepaired,
    callbacksRepaired,
    contactRepaired,
  };
}

/**
 * GL-11 — group changes cannot remain silently split. Any GroupChangeCommand
 * that is neither COMPLETE nor FAILED and holds no live lease is re-driven
 * through crm-admin's resumeGroupChange (that handler owns the Cognito
 * permissions and the verified stage machine). A command still unfinished
 * after several attempts is escalated as owned work — automatic resume is
 * recovery, not a place for failures to hide.
 */
export async function reconcileGroupChanges() {
  const client = await dataClient();
  if (!("GroupChangeCommand" in client.models)) {
    return { task: "reconcileGroupChanges", resumed: 0, escalated: 0 };
  }
  // Token-free wiring (a direct CDK function reference cycled the stacks):
  // the function stack publishes crm-admin's name to SSM; the env override
  // exists for tests.
  let fnName = process.env.CRM_ADMIN_FUNCTION_NAME;
  if (!fnName && process.env.CRM_ADMIN_FUNCTION_PARAM) {
    try {
      const { SSMClient, GetParameterCommand } = await import(
        "@aws-sdk/client-ssm"
      );
      const out = await new SSMClient({}).send(
        new GetParameterCommand({ Name: process.env.CRM_ADMIN_FUNCTION_PARAM })
      );
      fnName = out.Parameter?.Value ?? undefined;
    } catch (err) {
      console.error("reconcileGroupChanges: function-name param unreadable", err);
    }
  }
  const lambdaClient = new LambdaClient({});
  const nowIso = new Date().toISOString();
  let resumed = 0;
  let escalated = 0;
  const model = (
    client.models as unknown as {
      GroupChangeCommand: {
        list: (a: object) => Promise<{
          data: Record<string, unknown>[];
          nextToken?: string | null;
        }>;
      };
    }
  ).GroupChangeCommand;
  await forEachPage(
    (nextToken) => model.list({ limit: 200, nextToken }),
    async (cmds) => {
    for (const cmd of cmds) {
      const stage = String(cmd.stage ?? "");
      if (stage === "COMPLETE" || stage === "FAILED") continue;
      const leaseLive =
        typeof cmd.leaseUntil === "string" && cmd.leaseUntil > nowIso;
      if (leaseLive) continue;
      const attempts = Number(cmd.attemptCount) || 1;
      if (attempts >= 4) {
        const opened = await openOwnedWork({
          kind: "STATE_MISMATCH",
          dedupeKey: `group-change-stuck:${cmd.id}`,
          title: `A group change keeps failing: ${cmd.customerId}`,
          detail: `Group change ${cmd.id} (${cmd.fromGroupId ?? "none"} → ${cmd.toGroupId ?? "none"}) is still ${stage} after ${attempts} attempts (last error: ${cmd.lastError ?? "unrecorded"}). The customer's audit/row/child/Cognito surfaces may disagree until this completes.`,
          customerId: String(cmd.customerId),
          relatedId: String(cmd.id),
          sourceUrl: `/customers/${cmd.customerId}`,
          resolutionAction:
            "Escalate to engineering with the command id; after the underlying fault is fixed, the next daily run (or a manual resume) completes and verifies the change.",
          ownerTeam: "OPS",
        });
        if (opened) escalated++;
        continue;
      }
      if (!fnName) {
        console.error(
          "reconcileGroupChanges: CRM_ADMIN_FUNCTION_NAME unset — cannot resume",
          cmd.id
        );
        continue;
      }
      await lambdaClient.send(
        new InvokeCommand({
          FunctionName: fnName,
          InvocationType: "Event",
          Payload: Buffer.from(
            JSON.stringify({
              info: { fieldName: "resumeGroupChange" },
              arguments: { commandId: cmd.id },
              identity: null,
              source: "daily-reminders-resumer",
            })
          ),
        })
      );
      resumed++;
    }
    },
    { pageErrors: "ignore" }
  );
  return { task: "reconcileGroupChanges", resumed, escalated };
}

/**
 * GL-03 — every outbox row reaches a truthful terminal outcome:
 *  - QUEUED (provider throttle) rows are RE-SENT from their stored body,
 *    exactly once (guarded claim); still-throttled rows stay QUEUED for the
 *    next sweep; rows older than three days EXPIRE to FAILED with owned
 *    work — a throttle that lasts days is not a throttle.
 *  - QUEUED rows that cannot be machine-resent (attachments / no stored
 *    body) become owned work for a human resend.
 *  - SENDING rows older than an hour are UNKNOWN outcomes (the settle after
 *    the provider call never landed) — escalated, never blind-resent.
 */
export async function retryQueuedEmails() {
  const client = await dataClient();
  if (!("EmailLog" in client.models)) {
    return { task: "retryQueuedEmails", resent: 0, stillQueued: 0, escalated: 0, expired: 0 };
  }
  const now = Date.now();
  const EXPIRE_MS = 3 * 24 * 60 * 60_000;
  const STUCK_SENDING_MS = 60 * 60_000;
  let resent = 0;
  let stillQueued = 0;
  let escalated = 0;
  let expired = 0;
  const model = (
    client.models as unknown as {
      EmailLog: {
        list: (a: object) => Promise<{
          data: Record<string, unknown>[];
          nextToken?: string | null;
        }>;
        update: (a: object) => Promise<{ data: unknown }>;
      };
    }
  ).EmailLog;
  await forEachPage(
    (nextToken) => model.list({ limit: 200, nextToken }),
    async (logRows) => {
    for (const row of logRows) {
      const status = String(row.deliveryStatus ?? "");
      const at = row.sentAt ? Date.parse(String(row.sentAt)) : now;
      if (status === "SENDING" && now - at > STUCK_SENDING_MS) {
        const opened = await openOwnedWork({
          kind: "EMAIL_FAILURE",
          dedupeKey: `email-unknown-outcome:${row.id}`,
          title: `An email's outcome is UNKNOWN: ${row.subject}`,
          detail: `Outbox row ${row.id} (${row.template} to ${row.toEmail}) has read SENDING for over an hour — the provider call's outcome was never recorded. It may or may not have been sent. Do NOT blind-resend.`,
          customerId: (row.customerId as string | null) ?? undefined,
          relatedId: String(row.id),
          resolutionAction:
            "Verify with the provider/recipient whether it arrived, correct the EmailLog row, and resend only if it truly never left.",
          ownerTeam: "OPS",
        });
        if (opened) escalated++;
        continue;
      }
      // GL-03: a provider-ACCEPTED message that never reaches a terminal
      // event is not "Sent" forever — after three days without delivery
      // proof it becomes an owned, timed question (bounded to a rolling
      // two-week window so historic rows don't flood the queue).
      if (
        status === "SENT" &&
        process.env.SES_CONFIGURATION_SET &&
        now - at > 3 * 24 * 60 * 60_000 &&
        now - at < 14 * 24 * 60 * 60_000
      ) {
        const opened = await openOwnedWork({
          kind: "EMAIL_FAILURE",
          dedupeKey: `email-no-terminal:${row.id}`,
          title: `No delivery confirmation after 3 days: ${row.subject}`,
          detail: `The provider accepted the ${row.template} email to ${row.toEmail} (message ${row.messageId ?? "unknown"}) but no delivery, bounce, or complaint event ever arrived. The customer may not have received it.`,
          customerId: (row.customerId as string | null) ?? undefined,
          relatedId: String(row.id),
          resolutionAction:
            "Confirm with the customer (or another channel) whether it arrived; resend or record alternate delivery, and check the delivery-event pipeline if this recurs.",
          ownerTeam: "OPS",
        });
        if (opened) escalated++;
        continue;
      }
      if (status !== "QUEUED") continue;
      if (now - at > EXPIRE_MS) {
        await model.update({ id: row.id, deliveryStatus: "FAILED", status: "FAILED" }).catch(() => undefined);
        const opened = await openOwnedWork({
          kind: "EMAIL_FAILURE",
          dedupeKey: `email-expired:${row.id}`,
          title: `A held email EXPIRED unsent: ${row.subject}`,
          detail: `The ${row.template} email to ${row.toEmail} sat throttled for over three days and never went out. The customer never received it.`,
          customerId: (row.customerId as string | null) ?? undefined,
          relatedId: String(row.id),
          resolutionAction:
            "Deliver the message another way (fresh send or a call), record how, and check why the provider throttled for days.",
          ownerTeam: "OPS",
        });
        expired++;
        if (opened) escalated++;
        continue;
      }
      const outcome = await resendQueuedEmail(
        row as {
          id: string;
          toEmail: string;
          subject: string;
          template: string;
          customerId?: string | null;
          relatedId?: string | null;
          bodyHtml?: string | null;
          hasAttachments?: boolean | null;
        }
      );
      if (outcome === "RESENT") resent++;
      else if (outcome === "STILL_QUEUED") stillQueued++;
      else if (outcome === "UNRESENDABLE") {
        const opened = await openOwnedWork({
          kind: "EMAIL_FAILURE",
          dedupeKey: `email-manual-resend:${row.id}`,
          title: `A held email needs a HUMAN resend: ${row.subject}`,
          detail: `The ${row.template} email to ${row.toEmail} was throttled, and it cannot be machine-resent (it carried attachments or its body was too large to store). It has NOT been delivered.`,
          customerId: (row.customerId as string | null) ?? undefined,
          relatedId: String(row.id),
          resolutionAction:
            "Re-generate and resend the message from its source screen (the attachment can be rebuilt there), then record delivery.",
          ownerTeam: "OPS",
        });
        if (opened) escalated++;
      }
    }
    },
    { pageErrors: "ignore" }
  );
  return { task: "retryQueuedEmails", resent, stillQueued, escalated, expired };
}

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
      `Stripe captured ${formatMoney(m.paidCents)} but the booking committed to ${formatMoney(m.bookedCents)}`
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
      detail: `Stripe PaymentIntent ${pi} (tagged as a booking payment) succeeded for ${formatMoney(succeeded.paidCentsByPi[pi] ?? 0)}, but no BookingRequest references it. Money is captured with nothing behind it.`,
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
  const bookings = (await listAll(
    (nextToken) =>
      client.models.BookingRequest.list({ nextToken, limit: 200 }),
    { pageErrors: "ignore" }
  )) as unknown as (ReconBooking & {
    selectedDate?: string | null;
  })[];
  for (const b of bookings) {
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
  const invoices = (await listAll(
    (nextToken) => client.models.Invoice.list({ nextToken, limit: 200 }),
    { pageErrors: "ignore" }
  )) as unknown as ReconInvoiceRow[];
  for (const inv of invoices) {
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
 * Mark every overdue exception exactly once. The queue row is the authority —
 * the /work screen is where overdue items get noticed. The per-item escalation
 * email that used to fire here was removed by owner decision (2026-07-23): one
 * email per overdue row flooded the ops inbox the first morning production ran,
 * and the nudge duplicated what the queue already shows.
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
  }[] = (
    await listAll(
      (nextToken) =>
        client.models.WorkItem.listWorkItemByStatusAndDueAt(
          { status: "OPEN" },
          { nextToken, limit: 200 }
        ),
      { pageErrors: "ignore" }
    )
  ).filter((item) => !item.escalatedAt && item.dueAt < now);

  let escalated = 0;
  for (const item of overdue) {
    try {
      const escalatedAt = new Date().toISOString();
      // History lands first. If the row update fails, a later pass may append
      // a second overdue event, but it can never claim the overdue mark
      // happened while leaving no permanent record of it.
      const event = await client.models.WorkEvent.create({
        workItemId: item.id,
        eventType: "OVERDUE",
        actorEmail: "system@pestbuzzkill.com",
        note: "Deadline passed.",
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
