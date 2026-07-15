import { dataClient } from "../shared/dataClient";
import { emailShell, sendEmail } from "../shared/email";

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
  console.log("Reminder totals:", JSON.stringify(totals));
  return totals;
};

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
