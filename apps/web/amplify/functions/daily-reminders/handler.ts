import { dataClient } from "../shared/dataClient";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";
import { stripeClient } from "../shared/stripeClient";
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
} from "../shared/recovery";

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
  ];
};

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
    if (!customer?.email) continue;

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

/** Small HTML escaper — email bodies here interpolate names and emails. */
function escapeHtmlLite(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
