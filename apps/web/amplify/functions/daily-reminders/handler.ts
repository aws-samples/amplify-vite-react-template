import { dataClient } from "../shared/dataClient";
import { emailShell, notifyOffice, sendEmail } from "../shared/email";

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
  for (const [daysOut, phrasing] of [
    [1, "tomorrow"],
    [7, "in one week"],
  ] as const) {
    totals.push(await remind(easternPlusDays(daysOut), phrasing));
  }
  const notBilling = await reportPlansNotBilling();
  console.log("Reminder totals:", JSON.stringify(totals));
  return [...totals, notBilling];
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

async function remind(date: string, phrasing: string) {
  const client = await dataClient();
  const jobs: {
    customerId: string;
    serviceType: string;
    timeWindow?: string | null;
    status: string | null;
    id: string;
  }[] = [];
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

  // One email per customer even if they have multiple visits tomorrow.
  const byCustomer = new Map<string, typeof scheduled>();
  for (const job of scheduled) {
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
    `Reminders for ${date}: ${scheduled.length} scheduled jobs, ${byCustomer.size} customers, ${sent} emails sent`
  );
  return { date, jobs: scheduled.length, customers: byCustomer.size, sent };
}
