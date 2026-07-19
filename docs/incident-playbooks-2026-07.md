# BuzzKill incident playbooks

One page per incident class. Every incident gets the SAME owned response: a
shared-Office work item within one business day, claimed by whoever is on
duty — there are no critical/high/routine response classes and no
permanently named primary. Impact facts change the CONTAINMENT steps below,
never the response class or deadline.

**The levers (CRM → Dashboard → Emergency controls, OWNER-only, reason
required, announced to the office):**

- **Pause new online bookings** — the website funnel refuses new quotes and
  payments with an honest message; status polls, cancellations, and
  in-flight payment resolution keep working.
- **Pause new dispatch** — no new visit can be scheduled or assigned;
  cancels and unassigns still work so containment can pull work back.
- **Pause billing initiation** — no new charge, dunning retry, or
  subscription start; refunds, voids, and offline-payment records still
  work so money can be given back during containment.

**Evidence:** never delete anything. Every business table has point-in-time
recovery and the documents bucket is versioned; CloudWatch logs and the
owned work item are the incident record. **Restart authority:** the OWNER
who paused (or the CEO) authorizes resume, with the reason recorded on the
resume action.

---

## 1. Double charge

**Detect:** customer report, Stripe dashboard, daily money reconciliation
mismatch, or a PAID_NOT_FINALIZED / stray-payment case.

1. Claim the owned case. Pause **billing initiation** if charges are still
   being produced (e.g. a dunning or webhook fault).
2. In Stripe, identify both charges; refund the duplicate (refunds work
   while billing is paused). The CRM invoice stays PAID for the real one.
3. Email the customer what happened and what was refunded, from the
   customer record so it is logged.
4. Root cause before resuming: which path charged twice? If the webhook or
   dunning is implicated, leave billing paused and escalate to engineering.
5. Close the case only when Stripe, the invoice ledger, and the customer
   record agree.

## 2. Paid customer without a job

**Detect:** PAID_NOT_FINALIZED owned case, /booking-status RECOVERY state,
daily paid-booking reconciliation.

1. Claim the case. Do NOT pause anything for a single instance; pause **new
   online bookings** only if finalization is failing repeatedly.
2. Use "Retry finalization" on the case — it re-confirms the Stripe payment
   and resumes the same idempotent booking.
3. If retries keep failing: refund in Stripe, tell the customer their
   booking did not complete, and escalate to engineering.
4. Close only when the customer has either a complete booking (job,
   agreement, invoice, confirmation) or a verified refund.

## 3. Unauthorized data exposure

**Detect:** report from staff/customer, or an access review finding.

1. Claim (or open) the owned case. Immediately revoke the implicated login
   (Staff screen offboard / portal access revoke) — access removal is
   fail-safe and can be restored later.
2. Preserve evidence: note the exact records, times, and identities in the
   case; do not delete or edit anything.
3. Pause **new dispatch** only if technician access is implicated.
4. CEO decides customer/regulatory notification with counsel.
5. Close only after access review confirms least-privilege again.

## 4. Unlicensed dispatch

**Detect:** LICENSE_LAPSE case, dispatch gate refusal, or field report.

1. Claim the case. Pause **new dispatch** if an unlicensed visit may recur
   today.
2. Pull the affected visits (cancel/unassign works while paused); the
   licence gate already blocks future assignment of the lapsed technician.
3. Compliance decides on notification for any visit already performed.
4. Resume dispatch once every scheduled visit is on a currently licensed
   technician.

## 5. Outage (site, CRM, or provider down)

**Detect:** INFRA_ALERT items (Lambda errors, scheduled-run-missing,
dead-letter alarms), customer reports.

1. Claim the INFRA_ALERT. Check the named alarm in CloudWatch.
2. If customers can pay into a broken flow, pause **new online bookings**
   (money must not enter a flow that cannot finish).
3. Provider outage (Stripe/SES/Google): nothing to fix here — keep the
   pause on, let the daily reconcile and durable retries catch up when the
   provider recovers, then verify the queues drained.
4. Our outage: escalate to engineering; the alarm auto-resolves the case
   when the metric recovers, but verify the business facts (bookings,
   emails, reconciliation) before considering it closed.

## 6. Lost or corrupted report / document

**Detect:** missing PDF, corrupted record, accidental overwrite/delete.

1. Claim the case. Nothing is truly lost: the documents bucket is
   VERSIONED (restore the prior object version) and every table has
   point-in-time recovery (engineering restores to a timestamp).
2. For a single document: restore the prior S3 version, verify the record
   links to it, and confirm with the customer if it was theirs.
3. For table-level damage: engineering restores via PITR to a side table
   and reconciles rows — never a blind full-table rollback over newer
   writes.
4. Close only when the restored record is verified complete (report,
   photos, agreement, audit history usable).

## 7. Email / provider outage (messages not reaching customers)

**Detect:** INFRA_ALERT on ses-events dead-letter queue or send-failure
runs; EMAIL_FAILURE cases piling up.

1. Claim the alert. Check whether sends are failing (SES) or event
   processing is failing (our consumer).
2. Our consumer: engineering replays the dead-letter queue after the fix —
   events are never acked on a failed write, so nothing was lost.
3. SES outage/suppression problem: promised notices carry owned cases with
   resend actions; work them once sending recovers. Use recorded alternate
   delivery (phone) for anything time-critical, noted on the case.
4. Close when the DLQ is empty, delivery states are current, and every
   affected promised notice reached a terminal recorded outcome.

---

## Deletion & retention policy

Business, financial, legal, service, communication, and audit records are
retained for **seven years** — no automated expiry exists anywhere in this
system, table PITR is enabled, and the documents bucket keeps prior
versions. A customer deletion request removes marketing contact (suppression
+ do-not-contact with reason and evidence) but never deletes records the
business must retain (agreements, invoices, service/pesticide reports,
audit history); the office records the request and its scope on the
customer record. Hard deletion beyond that is a CEO + counsel decision,
executed by engineering with the action itself recorded.
