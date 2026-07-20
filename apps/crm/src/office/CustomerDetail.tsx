import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  DEACTIVATION_REASONS,
  dueDateForTerms,
  listCustomerLifecycleEvents,
  listLifecycleCommands,
  previewLifecycleTransition,
  opResult,
  REACTIVATION_REASONS,
  recordOfflinePayment,
  rescheduleVisit,
  sendInvoicePaymentLink,
  settleInvoice,
  unwrap,
  VISIT_RESCHEDULE_REASONS,
  type CustomerLifecycleEvent,
  type VisitRescheduleOutcome,
  type Agreement,
  type Customer,
  type CustomerGroup,
  type Invoice,
  type InvoiceTerms,
  type Job,
  type ServicePlan,
  type ServiceReport,
  type ServiceReportAmendment,
} from "../lib/api";
import { SERVICE_CATALOG } from "../../../web/amplify/functions/shared/serviceCatalog";
import { bookingFunnelSpoken, bookingFunnelUrl } from "../lib/bookingLink";
import { fmtDate, fmtDateTime, money, todayEastern } from "../lib/format";
import { daysPastDue } from "../lib/aging";
import { dunningStateLabel, isOverdue } from "../lib/recovery";
import { amountInWords } from "../lib/amountWords";
import { planCadence } from "../lib/planCadence";
import {
  completeJobConfirmText,
  startBillingConfirmText,
} from "../lib/billingDisclosure";
import { isOfficeCompletableServiceType } from "../lib/jobTypes";
import {
  Badge,
  Button,
  Card,
  DeliveryBadge,
  ErrorNote,
  SuccessNote,
  Field,
  ListRow,
  Page,
  SegControl,
  Sheet,
  Spinner,
  StatusBadge,
} from "../ui/kit";
import CustomerForm, { customerToForm } from "../components/CustomerForm";
import LeadPanel from "../components/LeadPanel";
import CollectPaymentSheet from "../components/CollectPaymentSheet";
import VisitCancelSheet from "../components/VisitCancelSheet";
import DocButton from "../components/DocButton";
import PriceLeadSheet from "../components/PriceLeadSheet";
import { DateField, TimeWindowField } from "../components/DateTimeFields";
import { useRoles } from "../lib/auth";

/** Human-friendly label for a controlled reason code (CUSTOMER_REQUEST →
 *  "Customer request"). Mirrors the same helper on the Staff screen. */
function reasonLabel(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What deactivation actually does, said before the button runs it. The money
 * and the visits are stated because they are real consequences the office is
 * committing to; the outstanding balance is not knowable until the server
 * computes it, so it is reported in the result, not the confirm.
 */
function deactivateConfirmText(
  name: string,
  counts: {
    activePlanCount: number;
    upcomingVisits: number;
    hasPortal: boolean;
  }
): string {
  const lines: string[] = [];
  if (counts.activePlanCount > 0) {
    lines.push(
      `• cancel ${counts.activePlanCount} active plan${
        counts.activePlanCount === 1 ? "" : "s"
      } — the Stripe subscription stops charging`
    );
  }
  if (counts.upcomingVisits > 0) {
    lines.push(
      `• cancel ${counts.upcomingVisits} upcoming visit${
        counts.upcomingVisits === 1 ? "" : "s"
      } and take ${counts.upcomingVisits === 1 ? "it" : "them"} off the route`
    );
  }
  if (counts.hasPortal) lines.push("• end their portal login");
  const body =
    lines.length > 0
      ? `\n\nThis will:\n${lines.join("\n")}`
      : "\n\nThey have no live billing, visits, or portal login to stop.";
  return `Mark ${name} inactive?${body}\n\nAny unpaid balance is reported, not charged. Their history stays.`;
}

export default function CustomerDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const roles = useRoles();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [reports, setReports] = useState<ServiceReport[]>([]);
  const [amendments, setAmendments] = useState<ServiceReportAmendment[]>([]);
  const [amending, setAmending] = useState<ServiceReport | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [rescheduling, setRescheduling] = useState<Job | null>(null);
  const [cancelingJob, setCancelingJob] = useState<Job | null>(null);
  const [packeting, setPacketing] = useState<Job | null>(null);
  const [pm, setPm] = useState<{ hasPaymentMethod: boolean; label: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refunding, setRefunding] = useState<Invoice | null>(null);
  const [settling, setSettling] = useState<Invoice | null>(null);
  const [sheet, setSheet] = useState<
    | null
    | "edit"
    | "job"
    | "collect"
    | "charge"
    | "record"
    | "portal"
    | "group"
    | "price"
  >(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // GL-09 — the lifecycle transition ledger (deactivate/reactivate history) and
  // the reason-picker sheets that gate each transition on a controlled reason.
  const [lifecycle, setLifecycle] = useState<CustomerLifecycleEvent[]>([]);
  const [lifecycleReadFailed, setLifecycleReadFailed] = useState(false);
  const [openLifecycleCommand, setOpenLifecycleCommand] = useState<{
    id: string;
    action: string;
    stage: string;
    lastError?: string | null;
  } | null>(null);
  const [lifecyclePreview, setLifecyclePreview] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [lifecycleSheet, setLifecycleSheet] = useState<
    "deactivate" | "reactivate" | null
  >(null);
  const [reasonCode, setReasonCode] = useState<string>("");
  const [reasonNote, setReasonNote] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const c = unwrap(await api().models.Customer.get({ id }));
      if (!c) {
        setNotFound(true);
        return;
      }
      setCustomer(c);
      const filter = { customerId: { eq: id } };
      const [pl, jb, ag, rp, amd, inv, gr] = await Promise.all([
        api().models.ServicePlan.list({ filter, limit: 200 }),
        api().models.Job.list({ filter, limit: 500 }),
        api().models.Agreement.list({ filter, limit: 200 }),
        api().models.ServiceReport.list({ filter, limit: 500 }),
        api().models.ServiceReportAmendment.list({ filter, limit: 500 }),
        api().models.Invoice.list({ filter, limit: 500 }),
        api().models.CustomerGroup.list({ limit: 500 }),
      ]);
      setPlans(unwrap(pl));
      setJobs(
        unwrap(jb).sort((a, b) =>
          (b.scheduledDate ?? "9999").localeCompare(a.scheduledDate ?? "9999")
        )
      );
      setAgreements(unwrap(ag));
      setReports(unwrap(rp).filter((r) => r.status === "FINALIZED"));
      setAmendments(
        unwrap(amd).sort((a, b) =>
          (a.issuedAt ?? "").localeCompare(b.issuedAt ?? "")
        )
      );
      setInvoices(
        unwrap(inv).sort((a, b) =>
          (b.issuedAt ?? "").localeCompare(a.issuedAt ?? "")
        )
      );
      setGroups(unwrap(gr));
      // The lifecycle ledger is OWNER/OFFICE/FINANCE-readable; load it for those
      // roles so the transition history refreshes after every deactivate/reactivate.
      if (roles.office || roles.finance) {
        const lc = await listCustomerLifecycleEvents(id);
        // GL-09/X1: a read failure is a FAILURE, never an empty timeline.
        setLifecycleReadFailed(lc.readFailed);
        setLifecycle(
          (lc.data ?? [])
            .slice()
            .sort((a, b) =>
              String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? ""))
            )
        );
        // GL-09: a non-terminal lifecycle command = "Transition needs recovery".
        const cmds = await listLifecycleCommands(id);
        setOpenLifecycleCommand(
          cmds.find((c) => c.stage !== "COMPLETE" && c.stage !== "FAILED") ?? null
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load customer");
    }
  }, [id, roles.office, roles.finance]);

  useEffect(() => {
    void load();
  }, [load]);

  // GL-09: the employee confirmation renders the SERVER inventory, computed
  // fresh each time the deactivate sheet opens.
  useEffect(() => {
    if (lifecycleSheet !== "deactivate" || !customer) {
      setLifecyclePreview(null);
      return;
    }
    let stale = false;
    void (async () => {
      try {
        const res = await previewLifecycleTransition({
          customerId: customer.id,
          action: "DEACTIVATE",
          reasonCode,
        });
        const data = opResult<Record<string, unknown>>(res);
        if (!stale) setLifecyclePreview(data ?? null);
      } catch {
        if (!stale) setLifecyclePreview(null);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifecycleSheet, reasonCode, customer?.id]);

  // Payment summary is a live Stripe lookup — load after the record.
  useEffect(() => {
    if (!customer || !roles.office) return;
    api()
      .queries.getPaymentMethodSummary({ customerId: customer.id })
      .then((res) => {
        if (!res.errors?.length) {
          setPm(
            opResult<{ hasPaymentMethod: boolean; label: string | null }>(res)
          );
        }
      })
      .catch(() => undefined);
  }, [customer, roles.office]);

  if (notFound) {
    return (
      <Page title="Customer" back="/customers">
        <ErrorNote error="Customer not found" />
      </Page>
    );
  }
  if (!customer) {
    return (
      <Page title="Customer" back="/customers">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  const isLead = customer.status === "LEAD";
  const group = groups.find((g) => g.id === customer.groupId);
  const activePlan = plans.find((p) => p.status === "ACTIVE");
  const upcomingJob = jobs.find(
    (j) => j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= todayEastern()
  );
  const needsAttention =
    customer.status === "ACTIVE" && !activePlan && !upcomingJob;

  const run = async (
    name: string,
    fn: () => Promise<unknown>,
    successMsg?: string
  ) => {
    setBusyAction(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      if (successMsg) {
        setNotice(successMsg);
        window.setTimeout(() => setNotice((n) => (n === successMsg ? null : n)), 6000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusyAction(null);
    }
  };

  const address = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Page
      title={customer.displayName}
      back={isLead ? "/leads" : "/customers"}
      actions={
        roles.office ? (
          <Button small variant="ghost" onClick={() => setSheet("edit")}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <ErrorNote error={error} />
      <SuccessNote message={notice} />

      <Card>
        <div className="row-split" style={{ marginBottom: 8 }}>
          <StatusBadge status={customer.status} />
          {needsAttention ? <Badge tone="warn">no plan or upcoming job</Badge> : null}
        </div>
        <dl className="kv">
          {customer.contactName ? (
            <>
              <dt>Contact</dt>
              <dd>{customer.contactName}</dd>
            </>
          ) : null}
          <dt>Email</dt>
          <dd>{customer.email ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{customer.phone ?? "—"}</dd>
          <dt>Address</dt>
          <dd>{address || "—"}</dd>
          {customer.leadSource ? (
            <>
              <dt>Source</dt>
              <dd>{customer.leadSource}</dd>
            </>
          ) : null}
          <dt>Group</dt>
          <dd>
            {group ? (
              <a onClick={() => navigate(`/groups/${group.id}`)} style={{ color: "var(--brand)", cursor: "pointer" }}>
                {group.name}
              </a>
            ) : (
              "—"
            )}
            {roles.office ? (
              <Button small variant="ghost" style={{ marginLeft: 8 }} onClick={() => setSheet("group")}>
                Change
              </Button>
            ) : null}
          </dd>
          {customer.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{customer.notes}</dd>
            </>
          ) : null}
        </dl>
      </Card>

      {isLead && roles.office ? (
        <LeadPanel customer={customer} onChanged={() => void load()} />
      ) : null}

      {isLead && roles.office ? (
        <Card
          title="Convert this lead"
          actions={
            <Button small variant="subtle" onClick={() => setSheet("price")}>
              ⚡ Price a lead
            </Button>
          }
        >
          {/* One road: the lead books themselves online. They pick a day,
              accept the terms, and pay by card — the booking creates the
              plan, the agreement, and the first visit, and this page fills
              in on its own. There is deliberately no office-side convert
              button: a conversion without a payment can't exist. */}
          <p className="muted small" style={{ marginBottom: 10 }}>
            Leads convert themselves at the online booking page: price in
            seconds, pick a day, pay by card to book. If the funnel can't
            price their property, it has a specialist call them. Once they
            book, the plan, agreement, and first visit appear here.
          </p>
          <Button
            block
            loading={busyAction === "bookinglink"}
            disabled={!customer.email || Boolean(customer.doNotContact)}
            onClick={() =>
              void run(
                "bookinglink",
                async () =>
                  unwrap(
                    await api().mutations.sendCustomerEmail({
                      customerId: customer.id,
                      kind: "booking-link",
                    })
                  ),
                `Booking link emailed to ${customer.email}`
              )
            }
          >
            Email the booking link
          </Button>
          {!customer.email ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              No email on this lead, so there is nothing to send it to — add
              one, or read the address below out over the phone.
            </p>
          ) : null}
          <p className="muted small" style={{ marginTop: 8 }}>
            On the phone? Read it out:{" "}
            {/* The href carries this lead's identity token when one has been
                minted (first email send mints it), so a link copied from
                here converts THIS lead exactly. The spoken form stays bare —
                nobody dictates a token — and falls back to email matching. */}
            <a
              href={
                customer.bookingLinkToken
                  ? `${bookingFunnelUrl()}?lead=${customer.bookingLinkToken}`
                  : bookingFunnelUrl()
              }
              target="_blank"
              rel="noreferrer"
            >
              <strong>{bookingFunnelSpoken()}</strong>
            </a>
          </p>
        </Card>
      ) : null}

      {roles.office ? (
        <Card
          title="Payment method"
          actions={<Badge tone={pm?.hasPaymentMethod ? "ok" : "warn"}>{pm?.hasPaymentMethod ? "on file" : "missing"}</Badge>}
        >
          <p style={{ marginBottom: 10 }}>
            {pm === null ? "Checking…" : pm.hasPaymentMethod ? pm.label : "No payment method saved — collect before the first treatment."}
          </p>
          <div className="row-split">
            <Button small variant="subtle" onClick={() => setSheet("collect")}>
              {pm?.hasPaymentMethod ? "Update card / bank" : "Collect now"}
            </Button>
            <Button
              small
              variant="ghost"
              loading={busyAction === "payreq"}
              disabled={!customer.email}
              onClick={() =>
                void run(
                  "payreq",
                  async () =>
                    unwrap(
                      await api().mutations.sendCustomerEmail({
                        customerId: customer.id,
                        kind: "payment-request",
                      })
                    ),
                  `Payment request emailed to ${customer.email}`
                )
              }
            >
              Email request
            </Button>
          </div>
          {/* Two buttons, not one screen with a toggle. Taking money and
              writing down that money arrived are different acts, and the only
              thing that used to separate them was which half of a segmented
              control was lit. Both are finance work: office staff collect the
              card but never take payment. */}
          {roles.finance ? (
            <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button small variant="ghost" onClick={() => setSheet("charge")}>
                Charge the card
              </Button>
              <Button small variant="ghost" onClick={() => setSheet("record")}>
                Record a payment
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      {roles.office ? (
        <Card
          title="Portal access"
          actions={
            customer.portalLastLoginAt ? (
              <Badge tone="ok">active</Badge>
            ) : customer.portalUserSub ? (
              <Badge tone="info">invited</Badge>
            ) : (
              <Badge tone="muted">not invited</Badge>
            )
          }
        >
          <p className="muted small" style={{ marginBottom: 10 }}>
            {customer.portalLastLoginAt
              ? `Last signed in ${fmtDateTime(customer.portalLastLoginAt)}.`
              : customer.portalUserSub
                ? `Invited${customer.portalInvitedAt ? ` ${fmtDate(customer.portalInvitedAt, true)}` : ""} — hasn't signed in yet.`
                : "Invite the customer to view services, documents, and billing online."}
          </p>
          {/* adminCreateUser is OWNER-only server-side (deliberately). A
              button every office employee can see but only the owner can use
              is a dead button that teaches staff errors are normal — so it
              renders only for the owner, and everyone else is told who to ask. */}
          {roles.owner || customer.portalUserSub ? (
            <div className="row-split">
              {roles.owner ? (
                <Button
                  small
                  variant="subtle"
                  disabled={!customer.email}
                  loading={busyAction === "invite"}
                  onClick={() =>
                    void run(
                      "invite",
                      async () =>
                        unwrap(
                          await api().mutations.adminCreateUser({
                            email: customer.email!,
                            name: customer.contactName ?? customer.displayName,
                            roles: ["CUSTOMER"],
                            customerId: customer.id,
                            resend: Boolean(customer.portalUserSub),
                          })
                        ),
                      `Portal invite sent to ${customer.email}`
                    )
                  }
                >
                  {customer.portalUserSub ? "Resend invite" : "Invite to portal"}
                </Button>
              ) : null}
              {customer.portalUserSub ? (
                <Button
                  small
                  variant="ghost"
                  loading={busyAction === "remind"}
                  onClick={() =>
                    void run(
                      "remind",
                      async () =>
                        unwrap(
                          await api().mutations.sendCustomerEmail({
                            customerId: customer.id,
                            kind: "portal-reminder",
                          })
                        ),
                      `Portal link emailed to ${customer.email}`
                    )
                  }
                >
                  Send portal link
                </Button>
              ) : null}
            </div>
          ) : null}
          {!roles.owner ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Ask the owner to {customer.portalUserSub ? "resend the invite" : "invite them"} — portal
              invites are owner-only.
            </p>
          ) : null}
          {roles.owner && !customer.email ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Add an email address first.
            </p>
          ) : null}
        </Card>
      ) : null}

      {/* Plans are born in one place only: the online booking's payment
          webhook. No "+ Plan" here — a hand-typed price can never enter a
          subscription, because there is no path for one. */}
      <Card title="Service plans">
        {plans.length === 0 ? (
          <p className="muted small">
            {isLead
              ? "No service plans — the plan is created when the lead books and pays online."
              : "No service plans."}
          </p>
        ) : (
          plans.map((p) => (
            <ListRow
              key={p.id}
              title={p.planName}
              subtitle={planCadence(p.priceCents, p.serviceFrequency, p.seasonal)}
              meta={
                <>
                  {p.cancellationPending ? (
                    <Badge tone="warn">canceling</Badge>
                  ) : (
                    <StatusBadge status={p.status} />
                  )}
                  {roles.finance && p.status === "ACTIVE" ? (
                    <>
                      {p.stripeSubscriptionId ? (
                        <Button
                          small
                          variant="danger"
                          loading={busyAction === `cancel-${p.id}`}
                          onClick={() => {
                            if (!window.confirm("Cancel this plan's billing?")) return;
                            void run(`cancel-${p.id}`, async () =>
                              unwrap(
                                await api().mutations.cancelSubscription({
                                  servicePlanId: p.id,
                                })
                              )
                            );
                          }}
                        >
                          Cancel
                        </Button>
                      ) : (
                        <Button
                          small
                          variant="subtle"
                          loading={busyAction === `start-${p.id}`}
                          onClick={() => {
                            // Begins charging a card every month, indefinitely.
                            // Completion starts billing on its own now, so
                            // reaching for this by hand means something went
                            // wrong — worth a sentence before it starts.
                            if (
                              !window.confirm(
                                startBillingConfirmText(customer.displayName, p)
                              )
                            ) {
                              return;
                            }
                            void run(
                              `start-${p.id}`,
                              async () =>
                                unwrap(
                                  await api().mutations.startSubscription({
                                    servicePlanId: p.id,
                                  })
                                ),
                              `Billing started — ${money(p.priceCents)} every month`
                            );
                          }}
                        >
                          Start billing
                        </Button>
                      )}
                      <Button
                        small
                        variant="ghost"
                        loading={busyAction === `pause-${p.id}`}
                        onClick={() => {
                          if (!window.confirm("Deactivate this plan? Billing pauses and no new visits are scheduled.")) return;
                          void run(`pause-${p.id}`, async () =>
                            unwrap(
                              await api().mutations.pausePlan({
                                servicePlanId: p.id,
                              })
                            )
                          );
                        }}
                      >
                        Deactivate
                      </Button>
                    </>
                  ) : null}
                  {roles.finance && p.status === "PAUSED" ? (
                    <Button
                      small
                      variant="subtle"
                      loading={busyAction === `resume-${p.id}`}
                      onClick={() =>
                        void run(`resume-${p.id}`, async () =>
                          unwrap(
                            await api().mutations.resumePlan({
                              servicePlanId: p.id,
                            })
                          )
                        )
                      }
                    >
                      Reactivate
                    </Button>
                  ) : null}
                </>
              }
            />
          ))
        )}
      </Card>

      {/* Job creation is for ACTIVE customers only. A lead with an
          office-created job would be a payment-less conversion side door —
          leads get a job when they book and pay online, not before. */}
      <Card
        title="Jobs"
        actions={
          roles.office && customer.status === "ACTIVE" ? (
            <Button small variant="ghost" onClick={() => setSheet("job")}>
              + Job
            </Button>
          ) : undefined
        }
      >
        {activePlan && !upcomingJob && roles.office && customer.status === "ACTIVE" ? (
          <div className="row-split" style={{ marginBottom: 8 }}>
            <p className="muted small" style={{ margin: 0 }}>
              Plan is active but nothing is on the schedule.
            </p>
            <Button small variant="subtle" onClick={() => setSheet("job")}>
              Schedule first visit
            </Button>
          </div>
        ) : null}
        {jobs.length === 0 ? (
          <p className="muted small">
            {isLead
              ? "No jobs — the first visit is scheduled when the lead books and pays online."
              : "No jobs yet."}
          </p>
        ) : (
          (() => {
            const renderJob = (j: Job) => {
              const report = reports.find((r) => r.jobId === j.id);
              // FAILED may be retried and VOID was withdrawn — neither speaks
              // for the job, so neither hides the Charge button. Mirrors the
              // server's covering rule in chargeOneTimeJob.
              const invoice = invoices.find(
                (inv) =>
                  inv.jobId === j.id &&
                  inv.status !== "FAILED" &&
                  inv.status !== "VOID"
              );
              const reschedulable =
                roles.office &&
                (j.status === "SCHEDULED" || j.status === "UNSCHEDULED");
              // GL-12: the dispatch packet is editable while the visit is live
              // (not yet a closed record). Same statuses the server allows.
              const packetEditable =
                roles.office &&
                (j.status === "SCHEDULED" ||
                  j.status === "UNSCHEDULED" ||
                  j.status === "IN_PROGRESS");
              return (
                <ListRow
                  key={j.id}
                  title={j.serviceType}
                  subtitle={
                    <>
                      {`${j.scheduledDate ? fmtDate(j.scheduledDate, true) : "unscheduled"}${j.timeWindow ? ` · ${j.timeWindow}` : ""}${j.priceCents ? ` · ${money(j.priceCents)}` : ""}`}
                      {j.status === "COMPLETED" ? (
                        <span className="nested-line">
                          {report?.pdfKey ? (
                            <>
                              report <DocButton docKey={report.pdfKey} label="view" />
                            </>
                          ) : (
                            "report pending"
                          )}
                          {invoice
                            ? ` · invoice ${invoice.status?.toLowerCase()}`
                            : ""}
                        </span>
                      ) : null}
                      {/* GL-15: the no-access evidence (reason + door photo) is
                          retrievable here, not through engineering. */}
                      {j.status === "NO_ACCESS" ? (
                        <span className="nested-line">
                          {j.noAccessReason
                            ? `no access: ${String(j.noAccessReason).replace(/_/g, " ").toLowerCase()}`
                            : "no access"}
                          {j.noAccessPhotoKey ? (
                            <>
                              {" "}
                              <DocButton
                                docKey={j.noAccessPhotoKey}
                                label="door photo"
                              />
                            </>
                          ) : null}
                        </span>
                      ) : null}
                    </>
                  }
                  meta={
                    <>
                      <StatusBadge status={j.status} />
                      {/* Paid online at booking. Shown on every status so the
                          row never looks chargeable to someone scanning it. */}
                      {j.paidAt ? (
                        <Badge tone="ok">
                          paid {j.priceCents ? money(j.priceCents) : ""} online
                        </Badge>
                      ) : null}
                      {/* GL-06: a pending bank debit is a real, dispatchable
                          visit — every screen says "Payment pending", never
                          paid and never chargeable. */}
                      {!j.paidAt && j.paymentPendingIntentId ? (
                        <Badge tone="warn">
                          payment pending
                          {j.priceCents ? ` ${money(j.priceCents)}` : ""} (bank)
                        </Badge>
                      ) : null}
                      {/* Office completion is for defined administrative job
                          types only. Field/pesticide work is completed by the
                          technician's finalized report — the legal application
                          record — so it never gets an office "Complete" button;
                          the server refuses it too. */}
                      {roles.office &&
                      (j.status === "SCHEDULED" || j.status === "IN_PROGRESS") &&
                      isOfficeCompletableServiceType(j.serviceType) ? (
                        <Button
                          small
                          variant="ghost"
                          loading={busyAction === `complete-${j.id}`}
                          onClick={() => {
                            // Completing a recurring job may start the plan's
                            // monthly billing server-side. When it will, the
                            // confirm says so — in the Start-billing button's
                            // words, since it moves the same money.
                            if (
                              !window.confirm(
                                completeJobConfirmText(customer.displayName, j, plans)
                              )
                            ) {
                              return;
                            }
                            void run(`complete-${j.id}`, async () =>
                              unwrap(
                                await api().mutations.completeJob({ jobId: j.id })
                              )
                            );
                          }}
                        >
                          ✓ Complete
                        </Button>
                      ) : null}
                      {roles.finance &&
                      j.type === "ONE_TIME" &&
                      j.status === "COMPLETED" &&
                      j.priceCents &&
                      !j.paidAt &&
                      !invoice ? (
                        <Button
                          small
                          variant="subtle"
                          loading={busyAction === `charge-${j.id}`}
                          onClick={() => {
                            // The amount is the job's own price, so there is no
                            // typo to catch here — but it is still a live card
                            // charge from a list someone is scanning.
                            if (
                              !window.confirm(
                                `Charge ${customer.displayName} ${money(j.priceCents ?? 0)} for ${j.serviceType}?\n\n${amountInWords(j.priceCents ?? 0)}${pm?.label ? ` — on ${pm.label}` : ""}.\n\nThis takes the money now. It can be refunded, but not undone.`
                              )
                            ) {
                              return;
                            }
                            void run(
                              `charge-${j.id}`,
                              async () =>
                                unwrap(
                                  await api().mutations.chargeOneTimeJob({ jobId: j.id })
                                ),
                              `Charged ${money(j.priceCents ?? 0)} for ${j.serviceType}`
                            );
                          }}
                        >
                          Charge {money(j.priceCents)}
                        </Button>
                      ) : null}
                      {reschedulable ? (
                        <>
                          <Button
                            small
                            variant="ghost"
                            onClick={() => setRescheduling(j)}
                          >
                            {j.scheduledDate ? "Reschedule" : "Schedule"}
                          </Button>
                          <Button
                            small
                            variant="danger"
                            onClick={() => setCancelingJob(j)}
                          >
                            ✕
                          </Button>
                        </>
                      ) : null}
                      {packetEditable ? (
                        <Button
                          small
                          variant="ghost"
                          onClick={() => setPacketing(j)}
                        >
                          Packet
                        </Button>
                      ) : null}
                    </>
                  }
                />
              );
            };
            const planned = plans.filter((p) =>
              jobs.some((j) => j.servicePlanId === p.id)
            );
            const oneTime = jobs.filter((j) => !j.servicePlanId);
            return (
              <>
                {planned.map((p) => (
                  <div key={p.id} className="job-group">
                    <p className="group-label">{p.planName}</p>
                    {jobs
                      .filter((j) => j.servicePlanId === p.id)
                      .slice(0, 6)
                      .map(renderJob)}
                  </div>
                ))}
                {oneTime.length ? (
                  <div className="job-group">
                    {planned.length ? (
                      <p className="group-label">One-time jobs</p>
                    ) : null}
                    {oneTime.slice(0, 8).map(renderJob)}
                  </div>
                ) : null}
              </>
            );
          })()
        )}
      </Card>

      {/* Read-only: the agreement is written by the online booking when the
          customer accepts the terms and pays. Nothing is authored, sent, or
          voided from here — this card is the record, not a workflow. */}
      {roles.office ? (
        <Card title="Agreements">
          {agreements.length === 0 ? (
            <p className="muted small">
              No agreements yet — the terms the customer accepts at online
              booking are recorded here.
            </p>
          ) : (
            agreements.map((a) => (
              <ListRow
                key={a.id}
                title={a.title}
                subtitle={
                  a.signedAt
                    ? `Accepted by ${a.signerName} · ${fmtDateTime(a.signedAt)}`
                    : undefined
                }
                meta={
                  <>
                    <StatusBadge status={a.status} />
                    {a.pdfKey ? <DocButton docKey={a.pdfKey} /> : null}
                  </>
                }
              />
            ))
          )}
        </Card>
      ) : null}

      <Card title="Service reports">
        {reports.length === 0 ? (
          <p className="muted small">No completed service reports.</p>
        ) : (
          reports.map((r) => {
            const reportAmendments = amendments.filter(
              (a) => a.originalReportId === r.id
            );
            const undelivered =
              r.deliveryStatus === "BOUNCED" ||
              r.deliveryStatus === "COMPLAINED" ||
              r.deliveryStatus === "FAILED" ||
              r.deliveryStatus === "SUPPRESSED" ||
              r.deliveryStatus === "NO_EMAIL";
            return (
              <div key={r.id}>
                <ListRow
                  title={fmtDate(r.serviceDate, true)}
                  subtitle={r.servicesPerformed ?? undefined}
                  meta={
                    <>
                      <DeliveryBadge
                        status={r.deliveryStatus}
                        emailedAt={r.emailedAt}
                      />
                      {r.pdfKey ? <DocButton docKey={r.pdfKey} /> : null}
                      {roles.office ? (
                        <Button
                          small
                          variant="ghost"
                          onClick={() => setAmending(r)}
                        >
                          Issue amendment
                        </Button>
                      ) : null}
                    </>
                  }
                />
                {/* GL-15: the photos and evidence behind the legal record are
                    retrievable here, not through engineering. */}
                {(r.photoKeys ?? []).filter(Boolean).length > 0 ? (
                  <div style={{ marginLeft: 16, marginBottom: 4 }}>
                    <span className="muted small">
                      {(r.photoKeys ?? []).filter(Boolean).length} photo
                      {(r.photoKeys ?? []).filter(Boolean).length === 1 ? "" : "s"}
                      :
                    </span>{" "}
                    {(r.photoKeys ?? [])
                      .filter((k): k is string => Boolean(k))
                      .map((k, i) => (
                        <DocButton key={k} docKey={k} label={`photo ${i + 1}`} />
                      ))}
                  </div>
                ) : null}
                {undelivered && roles.office ? (
                  <div style={{ marginLeft: 16, marginBottom: 8 }}>
                    <ReportDeliveryRecovery
                      reportId={r.id}
                      onDone={load}
                    />
                  </div>
                ) : null}
                {reportAmendments.map((a) => (
                  <div key={a.id} style={{ marginLeft: 16 }}>
                    <ListRow
                      title={`Amendment — ${fmtDate(a.issuedAt ?? "", true)}`}
                      subtitle={a.reason ?? undefined}
                      meta={
                        <>
                          <DeliveryBadge
                            status={a.deliveryStatus}
                            emailedAt={a.emailedAt}
                          />
                          {a.pdfKey ? <DocButton docKey={a.pdfKey} /> : null}
                        </>
                      }
                    />
                  </div>
                ))}
              </div>
            );
          })
        )}
      </Card>

      {roles.office ? (
        <Card title="Invoices">
          {invoices.length === 0 ? (
            <p className="muted small">No invoices yet.</p>
          ) : (
            invoices.slice(0, 10).map((inv) => {
              const job = inv.jobId ? jobs.find((j) => j.id === inv.jobId) : null;
              const plan = inv.servicePlanId
                ? plans.find((p) => p.id === inv.servicePlanId)
                : null;
              const source = job
                ? `${job.serviceType}${job.scheduledDate ? ` (${fmtDate(job.scheduledDate, true)})` : ""}`
                : plan
                  ? plan.planName
                  : null;
              const refundedCents = inv.refundedAmountCents ?? 0;
              const refundable = Math.max(0, inv.amountCents - refundedCents);
              const canRefund =
                roles.finance &&
                (inv.status === "PAID" || inv.status === "REFUNDED") &&
                refundable > 0;
              // Money that moved gets refunded; an invoice that should never
              // have existed gets voided. There is no third option and no delete.
              const canVoid =
                roles.finance && (inv.status === "OPEN" || inv.status === "FAILED");
              // Recovery: an OPEN/FAILED invoice is a bill still owed. Finance
              // can settle it (mark an offline payment, or charge the card);
              // office can email the customer a link to pay it.
              const owed = inv.status === "OPEN" || inv.status === "FAILED";
              const today = todayEastern();
              const overdue = isOverdue(inv, today);
              const daysLate = daysPastDue(inv, today);
              const canSettle = roles.finance && owed;
              const canSendLink = roles.office && owed && Boolean(customer.email);
              return (
                <ListRow
                  key={inv.id}
                  title={money(inv.amountCents)}
                  subtitle={
                    <>
                      {`${inv.description} · ${fmtDate(inv.issuedAt, true)}`}
                      {source ? (
                        <span className="nested-line">for {source}</span>
                      ) : null}
                      {owed && inv.dueDate ? (
                        <span className="nested-line">
                          {overdue
                            ? `Due ${fmtDate(inv.dueDate, true)} · ${daysLate} day${daysLate === 1 ? "" : "s"} overdue`
                            : `Due ${fmtDate(inv.dueDate, true)}`}
                          {inv.poNumber ? ` · PO ${inv.poNumber}` : ""}
                        </span>
                      ) : null}
                      {inv.status === "FAILED" ? (
                        <span className="nested-line">
                          {dunningStateLabel(inv, today)}
                          {inv.failureReason ? ` — ${inv.failureReason}` : ""}
                        </span>
                      ) : null}
                      {refundedCents > 0 ? (
                        <span className="nested-line">
                          {money(refundedCents)} refunded
                          {inv.refundReason ? ` — ${inv.refundReason}` : ""}
                        </span>
                      ) : null}
                      {inv.status === "VOID" && inv.voidReason ? (
                        <span className="nested-line">
                          voided — {inv.voidReason}
                        </span>
                      ) : null}
                    </>
                  }
                  meta={
                    <>
                      {overdue ? <Badge tone="danger">overdue</Badge> : null}
                      <StatusBadge status={inv.status} />
                      {canSettle ? (
                        <Button
                          small
                          variant="subtle"
                          onClick={() => setSettling(inv)}
                        >
                          Mark paid
                        </Button>
                      ) : null}
                      {canSettle && pm?.hasPaymentMethod ? (
                        <Button
                          small
                          variant="ghost"
                          loading={busyAction === `settle-${inv.id}`}
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Charge ${customer.displayName} ${money(inv.amountCents)} on ${pm?.label ?? "the card on file"} to settle this invoice?\n\n${amountInWords(inv.amountCents)}.\n\nThis takes the money now. It can be refunded, but not undone.`
                              )
                            ) {
                              return;
                            }
                            void run(
                              `settle-${inv.id}`,
                              async () => {
                                const res = opResult<{
                                  status?: string;
                                  failureReason?: string;
                                }>(
                                  await settleInvoice({
                                    invoiceId: inv.id,
                                    method: "CARD",
                                  })
                                );
                                // A decline comes back as FAILED, not thrown —
                                // don't let it read as a settled invoice.
                                if (res?.status === "FAILED") {
                                  throw new Error(
                                    res?.failureReason
                                      ? `The card was declined — ${res.failureReason}. The invoice is still unpaid.`
                                      : "The card was declined. The invoice is still unpaid."
                                  );
                                }
                              },
                              `Charged ${money(inv.amountCents)} — invoice settled`
                            );
                          }}
                        >
                          Charge card
                        </Button>
                      ) : null}
                      {canSendLink ? (
                        <Button
                          small
                          variant="ghost"
                          loading={busyAction === `link-${inv.id}`}
                          onClick={() =>
                            void run(
                              `link-${inv.id}`,
                              async () =>
                                unwrap(
                                  await sendInvoicePaymentLink({
                                    customerId: customer.id,
                                    invoiceId: inv.id,
                                  })
                                ),
                              `Payment link emailed to ${customer.email}`
                            )
                          }
                        >
                          Send link
                        </Button>
                      ) : null}
                      {canRefund ? (
                        <Button
                          small
                          variant="ghost"
                          onClick={() => setRefunding(inv)}
                        >
                          Refund
                        </Button>
                      ) : null}
                      {canVoid ? (
                        <Button
                          small
                          variant="ghost"
                          loading={busyAction === `void-${inv.id}`}
                          onClick={() => {
                            const reason = window.prompt(
                              `Void this ${money(inv.amountCents)} invoice? It stays on the record as voided, with your name and this reason.\n\nWhy is it being voided?`
                            );
                            if (!reason?.trim()) return;
                            void run(
                              `void-${inv.id}`,
                              async () =>
                                unwrap(
                                  await api().mutations.voidInvoice({
                                    invoiceId: inv.id,
                                    reason: reason.trim(),
                                  })
                                ),
                              `Voided the ${money(inv.amountCents)} invoice`
                            );
                          }}
                        >
                          Void
                        </Button>
                      ) : null}
                    </>
                  }
                />
              );
            })
          )}
        </Card>
      ) : null}

      {(roles.office || roles.finance) && customer.status !== "LEAD" ? (
        customer.status === "ACTIVE" ? (
          roles.finance ? (
            <Button
              block
              variant="danger"
              loading={busyAction === "deactivate"}
              onClick={() => {
                setReasonCode(DEACTIVATION_REASONS[0]);
                setReasonNote("");
                setLifecycleSheet("deactivate");
              }}
            >
              Mark inactive
            </Button>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              Ask finance or an owner to mark this customer inactive — it cancels
              their billing and ends their portal access.
            </p>
          )
        ) : roles.finance ? (
          <Button
            block
            variant="subtle"
            loading={busyAction === "reactivate"}
            onClick={() => {
              setReasonCode(REACTIVATION_REASONS[0]);
              setReasonNote("");
              setLifecycleSheet("reactivate");
            }}
          >
            Reactivate customer
          </Button>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Ask finance or an owner to reactivate this customer.
          </p>
        )
      ) : null}

      {/* ---------- Lifecycle history (GL-09) ---------- */}
      {(roles.office || roles.finance) && lifecycle.length > 0 ? (
        <Card title="Lifecycle history">
          {lifecycleReadFailed ? (
            <p className="small" style={{ color: "var(--danger, #b00)" }}>
              Some history could not be read — this list may be incomplete. Try
              again; a sensitive change must never look like it didn't happen.
            </p>
          ) : null}
          {lifecycle.map((e) => {
            const parts = String(e.reason ?? "").split(" — ");
            const code = parts[0]?.trim();
            const note = parts.slice(1).join(" — ").trim();
            return (
              <ListRow
                key={e.id}
                title={
                  <span>
                    {e.action === "DEACTIVATE" ? "Deactivated" : "Reactivated"}
                    {e.priorStatus && e.newStatus ? (
                      <span className="muted small">
                        {" "}
                        ({e.priorStatus} → {e.newStatus})
                      </span>
                    ) : null}
                  </span>
                }
                subtitle={
                  <span>
                    {code ? reasonLabel(code) : "—"}
                    {note ? ` · ${note}` : ""}
                    {" · by "}
                    {e.actorEmail}
                    {e.effects ? (
                      <>
                        <br />
                        <span className="muted small">{e.effects}</span>
                      </>
                    ) : null}
                  </span>
                }
                meta={
                  <span className="muted small">
                    {e.occurredAt ? fmtDateTime(e.occurredAt) : ""}
                  </span>
                }
              />
            );
          })}
        </Card>
      ) : null}

      {/* GL-09: a customer mid-transition is a THIRD state, not active or
          inactive — the next employee sees one safe resume action. */}
      {openLifecycleCommand ? (
        <Card>
          <Badge tone="danger">transition needs recovery</Badge>
          <p className="muted small" style={{ marginTop: 8 }}>
            A {openLifecycleCommand.action.toLowerCase()} of this customer
            stopped at {openLifecycleCommand.stage.replace(/_/g, " ").toLowerCase()}
            {openLifecycleCommand.lastError
              ? ` (${openLifecycleCommand.lastError})`
              : ""}
            . Billing, schedule, access, status, or the customer notice may be
            part-done — treat this customer as neither fully active nor fully
            inactive until it is resumed.
          </p>
          <Button
            block
            loading={busyAction === "resume-lifecycle"}
            onClick={() => {
              const cmd = openLifecycleCommand;
              void run("resume-lifecycle", async () => {
                // Resume = re-run the same idempotent transition under the SAME
                // command key, so it continues from the last confirmed step.
                const res = opResult<{ partial?: boolean; message?: string }>(
                  cmd.action === "DEACTIVATE"
                    ? await api().mutations.deactivateCustomer({
                        customerId: customer.id,
                        reasonCode: "OTHER",
                        note: "Resuming an unfinished transition",
                        idempotencyKey: cmd.id,
                      })
                    : await api().mutations.reactivateCustomer({
                        customerId: customer.id,
                        reasonCode: "OTHER",
                        note: "Resuming an unfinished transition",
                        idempotencyKey: cmd.id,
                      })
                );
                if (res?.partial) {
                  throw new Error(
                    res.message ??
                      "The transition still could not fully finish — it stays owned and is safe to retry."
                  );
                }
                setNotice("The unfinished transition was completed.");
              });
            }}
          >
            Resume {openLifecycleCommand.action.toLowerCase()}
          </Button>
        </Card>
      ) : null}

      {/* ---------- Sheets ---------- */}

      {/* GL-09 — deactivation is one server action gated on a controlled reason.
          The button opens this sheet; confirming fires the single
          deactivateCustomer mutation (money + schedule + portal + status), and a
          partial result is surfaced truthfully instead of claimed as done. */}
      <Sheet
        open={lifecycleSheet === "deactivate"}
        onClose={() => setLifecycleSheet(null)}
        title={`Deactivate ${customer.displayName}`}
      >
        <div className="form-grid">
          {lifecyclePreview ? (
            (() => {
              const p = lifecyclePreview as {
                willStop?: { plans: number; futureVisits: number; portalLogin: boolean };
                needsDecision?: {
                  paidVisits: { id: string; scheduledDate: string | null }[];
                  inProgressVisits: { id: string }[];
                };
                outstandingBalanceCents?: number;
                balanceHandling?: string;
                notice?: { subject: string } | null;
                readFailures?: string[];
              };
              return (
                <div className="muted small" style={{ display: "grid", gap: 4 }}>
                  <div>
                    <strong>Will stop:</strong> {p.willStop?.plans ?? 0} plan(s)
                    billing, {p.willStop?.futureVisits ?? 0} upcoming visit(s)
                    {p.willStop?.portalLogin ? ", and the portal login" : ""}.
                  </div>
                  {(p.needsDecision?.paidVisits.length ?? 0) > 0 ||
                  (p.needsDecision?.inProgressVisits.length ?? 0) > 0 ? (
                    <div>
                      <strong>Needs a decision (owned, 1 business day):</strong>{" "}
                      {p.needsDecision?.paidVisits.length ?? 0} paid visit(s) and{" "}
                      {p.needsDecision?.inProgressVisits.length ?? 0} in-progress
                      visit(s) — each gets its own owned honor/refund/finish case.
                    </div>
                  ) : null}
                  <div>
                    <strong>Money:</strong>{" "}
                    {(p.outstandingBalanceCents ?? 0) > 0
                      ? `${money(p.outstandingBalanceCents ?? 0)} still owed — ${String(p.balanceHandling ?? "").toLowerCase().replace(/_/g, " ")}; nothing is auto-charged.`
                      : "no outstanding balance; nothing is charged."}
                  </div>
                  <div>
                    <strong>Customer notice:</strong>{" "}
                    {p.notice ? `"${p.notice.subject}" will be sent.` : "none for this reason."}
                  </div>
                  {(p.readFailures?.length ?? 0) > 0 ? (
                    <div style={{ color: "var(--danger, #b00)" }}>
                      Some records could not be read ({p.readFailures!.join(", ")}) —
                      this preview may be incomplete.
                    </div>
                  ) : null}
                </div>
              );
            })()
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              {deactivateConfirmText(customer.displayName, {
                activePlanCount: plans.filter((p) => p.status === "ACTIVE").length,
                upcomingVisits: jobs.filter(
                  (j) =>
                    (j.status === "SCHEDULED" || j.status === "UNSCHEDULED") &&
                    !j.paidAt
                ).length,
                hasPortal: !!customer.portalUserSub,
              })}
            </p>
          )}
          <Field
            label="Reason"
            hint="A controlled reason is recorded with your name and the time in the lifecycle history."
          >
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
            >
              {DEACTIVATION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {reasonLabel(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" hint="Required when the reason is 'Other'.">
            <input
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Optional context"
            />
          </Field>
          <Button
            block
            variant="danger"
            loading={busyAction === "deactivate"}
            disabled={reasonCode === "OTHER" && !reasonNote.trim()}
            onClick={() => {
              if (reasonCode === "OTHER" && !reasonNote.trim()) return;
              const rc = reasonCode;
              const note = reasonNote.trim() || null;
              setLifecycleSheet(null);
              void run("deactivate", async () => {
                const res = opResult<{
                  jobsCanceled: number;
                  outstandingBalanceCents: number;
                  portalRevoked: boolean;
                  partial: boolean;
                  message?: string;
                }>(
                  await api().mutations.deactivateCustomer({
                    customerId: customer.id,
                    reasonCode: rc,
                    note,
                  })
                );
                // A step didn't finish (a plan still billing, the portal login
                // still live, or the status write didn't stick): the customer is
                // still ACTIVE on purpose, the office was paged, and an owned
                // recovery is open. Surface the truth instead of claiming success.
                if (res?.partial) {
                  throw new Error(
                    res.message ??
                      "The deactivation could not be finished, so the customer is still active. The office has been notified — it's owned and safe to retry."
                  );
                }
                const bal = res?.outstandingBalanceCents ?? 0;
                setNotice(
                  `${customer.displayName} deactivated — billing stopped, ${
                    res?.jobsCanceled ?? 0
                  } upcoming visit(s) canceled${
                    res?.portalRevoked ? ", portal login ended" : ""
                  }.${
                    bal > 0
                      ? ` Outstanding balance of ${money(
                          bal
                        )} is NOT charged — settle it separately.`
                      : ""
                  }`
                );
                window.setTimeout(
                  () =>
                    setNotice((n) =>
                      n && n.startsWith(customer.displayName) ? null : n
                    ),
                  12000
                );
              });
            }}
          >
            Deactivate customer
          </Button>
        </div>
      </Sheet>

      {/* GL-09 — reactivation is one server action (restores the login first,
          then flips ACTIVE, then records the transition), also gated on a reason. */}
      <Sheet
        open={lifecycleSheet === "reactivate"}
        onClose={() => setLifecycleSheet(null)}
        title={`Reactivate ${customer.displayName}`}
      >
        <div className="form-grid">
          <p className="muted small" style={{ margin: 0 }}>
            Restores their portal login and marks them active again. Canceled
            plans stay canceled — a reactivated customer re-subscribes through a
            new booking.
          </p>
          <Field
            label="Reason"
            hint="A controlled reason is recorded with your name and the time in the lifecycle history."
          >
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
            >
              {REACTIVATION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {reasonLabel(r)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note" hint="Required when the reason is 'Other'.">
            <input
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Optional context"
            />
          </Field>
          <Button
            block
            variant="subtle"
            loading={busyAction === "reactivate"}
            disabled={reasonCode === "OTHER" && !reasonNote.trim()}
            onClick={() => {
              if (reasonCode === "OTHER" && !reasonNote.trim()) return;
              const rc = reasonCode;
              const note = reasonNote.trim() || null;
              setLifecycleSheet(null);
              void run("reactivate", async () => {
                // GL-09: the completion words come from the PERSISTED result —
                // never an unconditional success over a partial/in-progress
                // server outcome.
                const res = opResult<{
                  reactivated?: boolean;
                  alreadyActive?: boolean;
                  partial?: boolean;
                  inProgress?: boolean;
                  audited?: boolean;
                  state?: string;
                  message?: string;
                }>(
                  await api().mutations.reactivateCustomer({
                    customerId: customer.id,
                    reasonCode: rc,
                    note,
                  })
                );
                if (res?.inProgress) {
                  throw new Error(
                    res.message ??
                      "A transition is already in progress for this customer — refresh in a moment for its outcome."
                  );
                }
                if (res?.partial || res?.state === "NEEDS_RECOVERY") {
                  throw new Error(
                    res.message ??
                      "The reactivation could not fully finish — it is owned and safe to retry."
                  );
                }
                if (res?.audited === false) {
                  throw new Error(
                    "The customer is active again, but the audit record could not be written — a recovery item now owns reconstructing it."
                  );
                }
                setNotice(
                  res?.alreadyActive
                    ? "This customer was already active — portal access re-checked."
                    : "Customer reactivated — their portal login is back on. Canceled plans stay canceled; add a new plan through a booking."
                );
              });
            }}
          >
            Reactivate customer
          </Button>
        </div>
      </Sheet>

      <Sheet open={sheet === "edit"} onClose={() => setSheet(null)} title="Edit customer">
        <CustomerForm
          initial={customerToForm(customer)}
          submitLabel="Save changes"
          showLeadSource={isLead}
          onSubmit={async (v) => {
            // Safe contact/address/note edit only (GL-09) — raw Customer.update
            // is closed to the browser, so protected lifecycle fields (status,
            // Stripe ids, access groups, paid state) can't be changed from here.
            unwrap(
              await api().mutations.updateCustomerContact({
                customerId: customer.id,
                displayName: v.displayName.trim(),
                contactName: v.contactName.trim() || null,
                email: v.email.trim() || null,
                phone: v.phone.trim() || null,
                serviceStreet: v.serviceStreet.trim() || null,
                serviceCity: v.serviceCity.trim() || null,
                serviceState: v.serviceState.trim() || null,
                serviceZip: v.serviceZip.trim() || null,
                leadSource: v.leadSource.trim() || null,
                notes: v.notes.trim() || null,
              })
            );
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "price"} onClose={() => setSheet(null)} title="AI price this lead">
        <PriceLeadSheet customer={customer} />
      </Sheet>

      <Sheet
        open={amending !== null}
        onClose={() => setAmending(null)}
        title="Issue report amendment"
      >
        {amending ? (
          <AmendReportForm
            report={amending}
            onDone={async (deliveryStatus) => {
              setAmending(null);
              setNotice(
                deliveryStatus === "ACCEPTED" || deliveryStatus === "DELIVERED"
                  ? "Amendment issued and sent to the customer."
                  : deliveryStatus === "NO_EMAIL"
                    ? "Amendment issued — the customer has no email on file, so delivery is now owned office work."
                    : "Amendment issued — the email did NOT go out; delivery is now owned office work."
              );
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={rescheduling !== null}
        onClose={() => setRescheduling(null)}
        title={rescheduling?.scheduledDate ? "Reschedule job" : "Schedule job"}
      >
        {rescheduling ? (
          <RescheduleForm
            job={rescheduling}
            onDone={async () => {
              setRescheduling(null);
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <VisitCancelSheet
        jobId={cancelingJob?.id ?? null}
        open={cancelingJob !== null}
        onClose={() => setCancelingJob(null)}
        onDone={() => void load()}
      />

      <Sheet
        open={packeting !== null}
        onClose={() => setPacketing(null)}
        title="Dispatch packet"
      >
        {packeting ? (
          <JobPacketForm
            job={packeting}
            onDone={async () => {
              setPacketing(null);
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <CallbacksSection customerId={customer.id} onChanged={load} />
      <PortalRequestsSection customerId={customer.id} />

      <Sheet open={sheet === "job"} onClose={() => setSheet(null)} title="New job">
        <JobForm
          plans={plans}
          onSubmit={async (v) => {
            const result = opResult<{
              catalogDecisionOpened?: boolean;
              message?: string;
            }>(
              await api().mutations.createOfficeJob({
                customerId: customer.id,
                servicePlanId: v.servicePlanId || undefined,
                serviceType: v.serviceType,
                serviceCode: v.serviceCode,
                priceCents: v.priceCents ?? undefined,
                scheduledDate: v.scheduledDate || undefined,
                timeWindow: v.timeWindow || undefined,
                accessInstructions: v.packet.accessInstructions.trim() || undefined,
                hazardNotes: v.packet.hazardNotes.trim() || undefined,
                prepInstructions: v.packet.prepInstructions.trim() || undefined,
                prepConfirmed: v.packet.prepInstructions.trim()
                  ? v.packet.prepConfirmed
                  : undefined,
                paymentExpectation: v.packet.paymentExpectation || undefined,
              })
            );
            if (result?.catalogDecisionOpened) {
              // GL-01: no job exists — the request is an owned catalog
              // decision with the one-business-day clock.
              window.alert(
                result.message ??
                  "That service isn't in the catalog — the request is now an owned catalog decision. No job was created."
              );
            }
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "group"} onClose={() => setSheet(null)} title="Customer group">
        <GroupPicker
          groups={groups}
          currentGroupId={customer.groupId}
          onPick={async (groupId, reason) => {
            unwrap(
              await api().mutations.setCustomerGroup({
                reason,
                customerId: customer.id,
                groupId: groupId ?? undefined,
              })
            );
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <CollectPaymentSheet
        customerId={customer.id}
        open={sheet === "collect"}
        onClose={() => setSheet(null)}
        onSaved={() => {
          setSheet(null);
          setPm(null);
          // Webhook updates the label asynchronously; refresh shortly after.
          setTimeout(() => void load(), 1500);
        }}
      />

      <Sheet
        open={Boolean(refunding)}
        onClose={() => setRefunding(null)}
        title="Refund an invoice"
      >
        {refunding ? (
          <RefundSheet
            invoice={refunding}
            customer={customer}
            onDone={async (msg) => {
              setRefunding(null);
              setNotice(msg);
              window.setTimeout(() => setNotice(null), 6000);
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={Boolean(settling)}
        onClose={() => setSettling(null)}
        title="Mark invoice paid"
      >
        {settling ? (
          <SettleInvoiceSheet
            invoice={settling}
            customer={customer}
            onDone={async (msg) => {
              setSettling(null);
              setNotice(msg);
              window.setTimeout(() => setNotice(null), 6000);
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={sheet === "charge"}
        onClose={() => setSheet(null)}
        title="Charge the card on file"
      >
        <ChargeCardSheet
          customer={customer}
          hasPaymentMethod={pm?.hasPaymentMethod ?? false}
          cardLabel={pm?.label ?? customer.paymentMethodLabel ?? null}
          onDone={async (msg) => {
            setSheet(null);
            setNotice(msg);
            window.setTimeout(() => setNotice(null), 6000);
            await load();
          }}
        />
      </Sheet>

      <Sheet
        open={sheet === "record"}
        onClose={() => setSheet(null)}
        title="Record a payment"
      >
        <RecordPaymentSheet
          customer={customer}
          onDone={async (msg) => {
            setSheet(null);
            setNotice(msg);
            window.setTimeout(() => setNotice(null), 6000);
            await load();
          }}
        />
      </Sheet>
    </Page>
  );
}

/**
 * Office escape hatch for one-off billing: either charge the card on file
 * for an arbitrary amount, or record an offline payment / invoice (cash,
 * check, adjustment) with no card movement.
 */
/**
 * Refund an invoice, in full or in part.
 *
 * Two-step on purpose: money moving back to a customer is still money moving,
 * and the second step restates the amount and who it goes to. Before this
 * existed the only way to refund was the Stripe dashboard, which left the CRM's
 * invoice PAID forever.
 */
function RefundSheet({
  invoice,
  customer,
  onDone,
}: {
  invoice: Invoice;
  customer: Customer;
  onDone: (message: string) => Promise<void>;
}) {
  const alreadyRefunded = invoice.refundedAmountCents ?? 0;
  const remaining = Math.max(0, invoice.amountCents - alreadyRefunded);
  const isCardPayment = Boolean(invoice.stripePaymentIntentId);

  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = Math.round(parseFloat(amount) * 100);
  const validAmount = Number.isFinite(cents) && cents > 0 && cents <= remaining;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = opResult<{ refundedNowCents?: number; sentToStripe?: boolean }>(
        await api().mutations.refundInvoice({
          invoiceId: invoice.id,
          amountCents: cents,
          reason: reason.trim(),
        })
      );
      await onDone(
        res?.sentToStripe === false
          ? `Recorded a ${money(cents)} refund — no card was charged for this invoice, so nothing was sent to Stripe.`
          : `Refunded ${money(cents)} to ${customer.displayName}. It reaches their account in 5–10 days.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refund this invoice");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  if (confirming) {
    return (
      <div className="form-grid">
        <p>
          Refund <strong>{money(cents)}</strong> to{" "}
          <strong>{customer.displayName}</strong>
          {isCardPayment && customer.paymentMethodLabel
            ? ` on ${customer.paymentMethodLabel}`
            : ""}
          ?
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          {isCardPayment
            ? "The money goes back to the card that paid, and reaches them in 5–10 days. Refunds can't be undone."
            : "This invoice was recorded as an offline payment, so no card was charged and nothing will be sent to Stripe. This records that you returned the money."}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          Reason: {reason.trim()}
        </p>
        <ErrorNote error={error} />
        <Button block variant="danger" loading={busy} onClick={() => void submit()}>
          Yes, refund {money(cents)}
        </Button>
        <Button block variant="subtle" onClick={() => setConfirming(false)}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        {invoice.description} · {money(invoice.amountCents)} paid
        {alreadyRefunded > 0
          ? ` · ${money(alreadyRefunded)} already refunded, ${money(remaining)} left`
          : ""}
      </p>
      <Field label="Amount to refund ($)" hint={`Up to ${money(remaining)}`}>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
        />
      </Field>
      <Field
        label="Reason"
        hint="Goes on the invoice. Say what happened, not just 'refund'."
      >
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Tech couldn't access the property"
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        disabled={!validAmount || !reason.trim()}
        onClick={() => setConfirming(true)}
      >
        Review refund
      </Button>
    </div>
  );
}

/**
 * Charge a card. Two steps, because this is the control the review found on
 * backwards: giving money back had a confirmation and taking it did not, so a
 * CSR who meant $149.00 and typed 14900 charged $14,900 instantly with no
 * dialog and no undo.
 *
 * The confirmation states the amount in words as well as figures. $14,900.00
 * and $149.00 look alike at a glance; "fourteen thousand nine hundred dollars"
 * does not. Above RETYPE_ABOVE_CENTS it also has to be typed again, because at
 * that size reading past a confirmation is exactly the mistake being made.
 */
const RETYPE_ABOVE_CENTS = 50_000; // $500

function ChargeCardSheet({
  customer,
  hasPaymentMethod,
  cardLabel,
  onDone,
}: {
  customer: Customer;
  hasPaymentMethod: boolean;
  cardLabel: string | null;
  onDone: (message: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [retyped, setRetyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency token per sheet open: accidental retries/double-taps
  // collapse to a single charge; a fresh sheet open charges again.
  const [idemToken] = useState(() => crypto.randomUUID());

  const cents = Math.round(parseFloat(amount) * 100);
  const validAmount = Number.isFinite(cents) && cents > 0;
  const needsRetype = validAmount && cents > RETYPE_ABOVE_CENTS;
  const retypeOk =
    !needsRetype || Math.round(parseFloat(retyped) * 100) === cents;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = opResult<{ status?: string }>(
        await api().mutations.chargeManualAmount({
          customerId: customer.id,
          amountCents: cents,
          description: description.trim(),
          idempotencyKey: idemToken,
        })
      );
      await onDone(
        res?.status === "succeeded"
          ? `Charged ${money(cents)} to ${cardLabel ?? "the card on file"}`
          : `Charge submitted for ${money(cents)} — the status updates when it settles`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not charge the card");
      setConfirming(false);
      setBusy(false);
    }
  };

  if (!hasPaymentMethod) {
    return (
      <div className="form-grid">
        <p>
          <strong>{customer.displayName}</strong> has no payment method on file,
          so there is nothing to charge.
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          Collect a card first. If they have already paid you by cash or cheque,
          record that instead — it is a separate action on the customer record.
        </p>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="form-grid">
        <p style={{ margin: 0 }}>
          Charge <strong>{money(cents)}</strong> to{" "}
          <strong>{customer.displayName}</strong>
          {cardLabel ? ` on ${cardLabel}` : ""}?
        </p>
        <p style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
          {amountInWords(cents)}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          {description.trim()}
        </p>
        <p className="muted small" style={{ margin: 0 }}>
          This takes the money now. It can be refunded afterwards, but it cannot
          be undone.
        </p>
        {needsRetype ? (
          <Field
            label="Type the amount again to confirm"
            hint="Anything over $500 is worth checking twice"
          >
            <input
              inputMode="decimal"
              value={retyped}
              onChange={(e) => setRetyped(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={(cents / 100).toFixed(2)}
            />
          </Field>
        ) : null}
        <ErrorNote error={error} />
        <Button
          block
          variant="danger"
          loading={busy}
          disabled={!retypeOk}
          onClick={() => void submit()}
        >
          Yes, charge {money(cents)}
        </Button>
        <Button block variant="subtle" onClick={() => setConfirming(false)}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        Charges {cardLabel ?? "the card on file"} straight away.
      </p>
      <Field label="Amount ($)">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="149.00"
        />
      </Field>
      <Field
        label="What is this for?"
        hint="Goes on the invoice and on the customer's card statement"
      >
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Extra visit — wasp nest follow-up"
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        disabled={!validAmount || !description.trim()}
        onClick={() => {
          setRetyped("");
          setConfirming(true);
        }}
      >
        Review charge
      </Button>
    </div>
  );
}

/**
 * Record money taken outside Stripe, or raise an invoice to be settled later.
 * Moves no money.
 *
 * Deliberately a different screen from the charge, not a toggle beside it. As
 * one control the only thing separating "collected $500" from "took $500" was
 * which half of a segmented control was lit, and it defaulted to the recording
 * half whenever the payment-method lookup came back empty — including when it
 * failed. Goes through a mutation so the actor is stamped server-side.
 */
function RecordPaymentSheet({
  customer,
  onDone,
}: {
  customer: Customer;
  onDone: (message: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<"CASH" | "CHEQUE" | "BANK" | "OTHER">(
    "CHEQUE"
  );
  const [status, setStatus] = useState<"PAID" | "OPEN">("PAID");
  const [terms, setTerms] = useState<InvoiceTerms>("DUE_ON_RECEIPT");
  const [poNumber, setPoNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = Math.round(parseFloat(amount) * 100);
  const validAmount = Number.isFinite(cents) && cents > 0;
  // The server sets the due date from the terms; mirror it here so the office
  // sees, before saving, exactly when the customer's clock runs out.
  const dueDate = dueDateForTerms(terms, todayEastern());

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await recordOfflinePayment({
          customerId: customer.id,
          amountCents: cents,
          description: description.trim(),
          status,
          method: status === "PAID" ? method : undefined,
          terms: status === "OPEN" ? terms : undefined,
          poNumber:
            status === "OPEN" && poNumber.trim() ? poNumber.trim() : undefined,
        })
      );
      await onDone(
        status === "PAID"
          ? `Recorded ${money(cents)} received by ${method.toLowerCase()}`
          : `Raised a ${money(cents)} invoice — due ${fmtDate(dueDate, true)}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the payment");
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        Bookkeeping only — no card is charged. Your name is recorded against it.
      </p>
      <SegControl
        options={[
          { value: "PAID" as const, label: "Money received" },
          { value: "OPEN" as const, label: "Invoice to be paid" },
        ]}
        value={status}
        onChange={setStatus}
      />
      <Field label="Amount ($)">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="149.00"
        />
      </Field>
      {status === "PAID" ? (
        <Field label="How did it arrive?">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
          >
            <option value="CHEQUE">Cheque</option>
            <option value="CASH">Cash</option>
            <option value="BANK">Bank transfer</option>
            <option value="OTHER">Other</option>
          </select>
        </Field>
      ) : (
        <>
          {/* Terms set the due date the invoice ages against — the check-paying
              HOA/commercial segment works on Net 15/30, not due-on-receipt. */}
          <Field
            label="Payment terms"
            hint={`Due ${fmtDate(dueDate, true)}`}
          >
            <select
              value={terms}
              onChange={(e) => setTerms(e.target.value as InvoiceTerms)}
            >
              <option value="DUE_ON_RECEIPT">Due on receipt</option>
              <option value="NET_15">Net 15</option>
              <option value="NET_30">Net 30</option>
            </select>
          </Field>
          <Field label="PO number" hint="Optional — for customers who pay against a purchase order">
            <input
              value={poNumber}
              onChange={(e) => setPoNumber(e.target.value)}
              placeholder="e.g. 4500123987"
            />
          </Field>
        </>
      )}
      <Field label="What is this for?" hint="Shows on the invoice and their history">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Extra visit — wasp nest follow-up"
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        disabled={!validAmount || !description.trim()}
        onClick={() => void submit()}
      >
        {status === "PAID" ? `Record ${validAmount ? money(cents) : "payment"} received` : "Raise invoice"}
      </Button>
    </div>
  );
}

/**
 * Settle an existing OPEN or FAILED invoice by recording that money arrived
 * outside the card — cash, a cheque, a bank transfer. This is the R31 gap the
 * old recordOfflinePayment could not close: it only ever created a new row, so
 * a cheque against an outstanding invoice left two records and a wrong balance.
 * Goes through settleInvoice(OFFLINE), which stamps the actor and closes the
 * existing invoice to PAID.
 */
function SettleInvoiceSheet({
  invoice,
  customer,
  onDone,
}: {
  invoice: Invoice;
  customer: Customer;
  onDone: (message: string) => Promise<void>;
}) {
  const [method, setMethod] = useState<"CASH" | "CHEQUE" | "BANK" | "OTHER">(
    "CHEQUE"
  );
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const note = [
        `Received by ${method.toLowerCase()}`,
        reference.trim(),
      ]
        .filter(Boolean)
        .join(" — ");
      unwrap(
        await settleInvoice({
          invoiceId: invoice.id,
          method: "OFFLINE",
          note,
        })
      );
      await onDone(
        `Marked ${money(invoice.amountCents)} paid — received by ${method.toLowerCase()}`
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not settle this invoice"
      );
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        {invoice.description} · {money(invoice.amountCents)}. Records that{" "}
        {customer.displayName} paid this outside the card — no money is charged.
        Your name is recorded against it.
      </p>
      <Field label="How did it arrive?">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as typeof method)}
        >
          <option value="CHEQUE">Cheque</option>
          <option value="CASH">Cash</option>
          <option value="BANK">Bank transfer</option>
          <option value="OTHER">Other</option>
        </select>
      </Field>
      <Field
        label="Reference"
        hint="Optional — cheque number, transfer id, anything to reconcile against"
      >
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Cheque #1042"
        />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void submit()}>
        Mark {money(invoice.amountCents)} paid
      </Button>
    </div>
  );
}

/* ---------- Sub-forms ---------- */

function RescheduleForm({
  job,
  onDone,
}: {
  job: Job;
  onDone: () => Promise<void>;
}) {
  const [date, setDate] = useState(job.scheduledDate ?? "");
  const [timeWindow, setTimeWindow] = useState(job.timeWindow ?? "");
  const [reasonCode, setReasonCode] = useState<string>(
    VISIT_RESCHEDULE_REASONS[0]
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateChanged = date !== (job.scheduledDate ?? "");

  return (
    <div className="form-grid">
      {/* GL-07 R5: the same consequence preview as cancel — what a reschedule
          does and doesn't touch, before it's committed. */}
      <ul className="cancel-consequences">
        <li>No money moves — a reschedule never refunds or charges.</li>
        <li>
          {job.servicePlanId
            ? "This moves only this visit; a recurring plan keeps running."
            : "This is a one-time visit."}
        </li>
        <li>
          We revalidate the technician's license and the day's capacity before
          committing; a visit given a date with no technician is put in the
          Operations staffing queue, never left silently unassigned.
        </li>
        <li>The customer is emailed the old and new details when you save.</li>
      </ul>
      <Field label="Date">
        <DateField value={date} onChange={setDate} allowClear />
      </Field>
      <Field label="Time window">
        <TimeWindowField value={timeWindow} onChange={setTimeWindow} />
      </Field>
      {dateChanged && job.routeId ? (
        <p className="muted small">
          Moving the date takes this job off its current route — it'll be
          re-routed for the new day.
        </p>
      ) : null}
      <Field
        label="Reason"
        hint="A controlled reason is recorded on the visit's audit history."
      >
        <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
          {VISIT_RESCHEDULE_REASONS.map((r) => (
            <option key={r} value={r}>
              {reasonLabel(r)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Note" hint="Required when the reason is 'Other'.">
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        disabled={reasonCode === "OTHER" && !note.trim()}
        onClick={() => {
          setBusy(true);
          setError(null);
          rescheduleVisit({
            jobId: job.id,
            scheduledDate: date || undefined,
            timeWindow: timeWindow.trim() || undefined,
            reasonCode,
            note: note.trim() || undefined,
          })
            .then((res) => {
              const data = opResult<VisitRescheduleOutcome>(res);
              // A rescheduled visit whose customer notice failed is owned, not a
              // clean success — tell the office so they follow up.
              if (data && data.outcome === "PARTIAL") {
                throw new Error(
                  "Rescheduled, but we couldn't email the customer — an operations task was opened to reach them."
                );
              }
              return onDone();
            })
            .catch((err) => {
              setError(err.message ?? "Could not reschedule");
              setBusy(false);
            });
        }}
      >
        {date ? "Save schedule" : "Mark unscheduled"}
      </Button>
    </div>
  );
}

/**
 * Issue an append-only correction to a finalized report (GL-15). The office
 * states why, and each fact being corrected as was → now. Nothing here edits the
 * original record — the mutation appends a new, linked amendment and delivers it.
 */
function AmendReportForm({
  report,
  onDone,
}: {
  report: ServiceReport;
  onDone: (deliveryStatus: string | null) => Promise<void>;
}) {
  type Row = { label: string; from: string; to: string };
  const [reason, setReason] = useState("");
  const [rows, setRows] = useState<Row[]>([{ label: "", from: "", to: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setRow = (i: number, k: keyof Row, v: string) =>
    setRows((list) => list.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));

  const ready =
    reason.trim().length > 0 &&
    rows.some((r) => r.label.trim() && r.to.trim());

  return (
    <div className="form-grid">
      <p className="muted small" style={{ margin: 0 }}>
        The original report is preserved unchanged. This issues a correction
        linked to it and sends the customer the amended copy.
      </p>
      <Field label="Reason for the correction">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this record being corrected?"
        />
      </Field>
      {rows.map((r, i) => (
        <Field group label={`Correction ${i + 1}`} key={i}>
          <input
            placeholder="What changed (e.g. Areas treated)"
            value={r.label}
            onChange={(e) => setRow(i, "label", e.target.value)}
          />
          <div className="form-row-2">
            <input
              placeholder="Was (optional)"
              value={r.from}
              onChange={(e) => setRow(i, "from", e.target.value)}
            />
            <input
              placeholder="Now (corrected value)"
              value={r.to}
              onChange={(e) => setRow(i, "to", e.target.value)}
            />
          </div>
          {rows.length > 1 ? (
            <Button
              small
              variant="ghost"
              onClick={() => setRows((l) => l.filter((_, idx) => idx !== i))}
            >
              ✕ Remove
            </Button>
          ) : null}
        </Field>
      ))}
      <Button
        small
        variant="ghost"
        onClick={() =>
          setRows((l) => [...l, { label: "", from: "", to: "" }])
        }
      >
        + Add another correction
      </Button>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        disabled={!ready}
        onClick={() => {
          setBusy(true);
          setError(null);
          const changes = rows
            .filter((r) => r.label.trim() && r.to.trim())
            .map((r) => ({
              label: r.label.trim(),
              from: r.from.trim(),
              to: r.to.trim(),
            }));
          api()
            .mutations.amendServiceReport({
              reportId: report.id,
              reason: reason.trim(),
              changes: JSON.stringify(changes),
            })
            .then((res) => {
              const data = opResult<{ deliveryStatus?: string | null }>(res);
              // The notice words come from the PERSISTED delivery state — an
              // issued-but-undelivered amendment is never called "sent".
              return onDone(data?.deliveryStatus ?? null);
            })
            .catch((err) => {
              setError(err.message ?? "Could not issue the amendment");
              setBusy(false);
            });
        }}
      >
        Issue amendment &amp; send
      </Button>
    </div>
  );
}

/**
 * GL-15 — the office's bounded recovery for an undelivered report: re-send the
 * exact document (the resume adopts any proven prior send) or record an
 * approved alternate delivery with how it was delivered. Shows the VERIFIED
 * resulting state via the reload.
 */
function ReportDeliveryRecovery({
  reportId,
  onDone,
}: {
  reportId: string;
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<null | "alternate">(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "resend" | "alternate">(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: "RESEND" | "ALTERNATE") => {
    setBusy(action === "RESEND" ? "resend" : "alternate");
    setError(null);
    try {
      const res = await (
        api().mutations as unknown as {
          recordReportDelivery: (i: {
            reportId: string;
            action: string;
            note?: string;
          }) => Promise<{ errors?: { message: string }[] }>;
        }
      ).recordReportDelivery({
        reportId,
        action,
        note: note.trim() || undefined,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record delivery");
      setBusy(null);
    }
  };

  return (
    <div className="form-grid" style={{ gap: 6 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          small
          loading={busy === "resend"}
          onClick={() => void run("RESEND")}
        >
          Re-send report
        </Button>
        <Button small variant="ghost" onClick={() => setMode("alternate")}>
          Delivered another way…
        </Button>
      </div>
      {mode === "alternate" ? (
        <>
          <Field label="How was it delivered?" hint="Mailed, handed to the customer…">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button
            small
            loading={busy === "alternate"}
            disabled={!note.trim()}
            onClick={() => void run("ALTERNATE")}
          >
            Record alternate delivery
          </Button>
        </>
      ) : null}
      <ErrorNote error={error} />
    </div>
  );
}

/** The dispatch-packet fields an office user captures per job (GL-12). */
type PacketValues = {
  accessInstructions: string;
  hazardNotes: string;
  prepInstructions: string;
  prepConfirmed: boolean;
  paymentExpectation: "" | "COLLECT_NOTHING" | "DUE_THROUGH_OFFICE";
};

/** The packet inputs, shared by the New-job form and the Edit-packet sheet. */
function PacketFields({
  value,
  onChange,
}: {
  value: PacketValues;
  onChange: (v: PacketValues) => void;
}) {
  const set = (patch: Partial<PacketValues>) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label="Getting in" hint="Gate code, lockbox, parking, which door — for this visit">
        <input
          value={value.accessInstructions}
          onChange={(e) => set({ accessInstructions: e.target.value })}
        />
      </Field>
      <Field
        label="Safety"
        hint="Dogs, small children, allergies, hazards — shown to the tech in red"
      >
        <input
          value={value.hazardNotes}
          onChange={(e) => set({ hazardNotes: e.target.value })}
        />
      </Field>
      <Field label="Prep the customer must do">
        <input
          value={value.prepInstructions}
          onChange={(e) => set({ prepInstructions: e.target.value })}
        />
      </Field>
      {value.prepInstructions.trim() ? (
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={value.prepConfirmed}
            onChange={(e) => set({ prepConfirmed: e.target.checked })}
          />
          Prep confirmed with the customer
        </label>
      ) : null}
      <Field label="Payment at the door" hint="BuzzKill never collects in the field">
        <select
          value={value.paymentExpectation}
          onChange={(e) =>
            set({ paymentExpectation: e.target.value as PacketValues["paymentExpectation"] })
          }
        >
          <option value="">Office bills afterward (default)</option>
          <option value="COLLECT_NOTHING">Already paid — collect nothing</option>
          <option value="DUE_THROUGH_OFFICE">Payment due through the office</option>
        </select>
      </Field>
    </>
  );
}

const emptyPacket: PacketValues = {
  accessInstructions: "",
  hazardNotes: "",
  prepInstructions: "",
  prepConfirmed: false,
  paymentExpectation: "",
};

function JobForm({
  plans,
  onSubmit,
}: {
  plans: ServicePlan[];
  onSubmit: (v: {
    serviceType: string;
    serviceCode: string;
    priceCents: number | null;
    scheduledDate: string;
    timeWindow: string;
    servicePlanId: string;
    packet: PacketValues;
  }) => Promise<void>;
}) {
  // GL-01: the service is a CONTROLLED catalog selection — no free text can
  // invent work the business cannot price, staff, or document. "Something
  // else…" routes to an owned catalog decision instead of creating a job.
  const [serviceCode, setServiceCode] = useState("GENERAL_PEST");
  const [otherText, setOtherText] = useState("");
  const [price, setPrice] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [timeWindow, setTimeWindow] = useState("");
  const [planId, setPlanId] = useState("");
  const [packet, setPacket] = useState<PacketValues>(emptyPacket);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activePlans = plans.filter((p) => p.status === "ACTIVE");
  const notInCatalog = serviceCode === "NOT_IN_CATALOG";
  const serviceType = notInCatalog
    ? otherText
    : (Object.values(SERVICE_CATALOG).find((e) => e.id === serviceCode)?.label ??
      serviceCode);

  return (
    <div className="form-grid">
      <Field label="Service">
        <select
          value={serviceCode}
          onChange={(e) => setServiceCode(e.target.value)}
        >
          {Object.values(SERVICE_CATALOG).map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
              {e.seasonal ? " — seasonal Apr–Oct" : ""}
            </option>
          ))}
          <option value="NOT_IN_CATALOG">Something else…</option>
        </select>
      </Field>
      {notInCatalog ? (
        <Field
          label="What did the customer ask for?"
          hint="This opens a catalog decision (answered within one business day) — it does not create a job"
        >
          <input
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            placeholder="e.g. attic insulation restoration"
          />
        </Field>
      ) : null}
      {activePlans.length ? (
        <Field label="Part of plan" hint="Visits under a plan are covered by the monthly price">
          <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">One-time job (billed separately)</option>
            {activePlans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.planName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {!planId ? (
        <Field label="One-time price ($)">
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Date" hint="Leave empty to schedule later">
        <DateField value={scheduledDate} onChange={setScheduledDate} allowClear />
      </Field>
      <Field label="Time window">
        <TimeWindowField value={timeWindow} onChange={setTimeWindow} />
      </Field>
      <PacketFields value={packet} onChange={setPacket} />
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          if (!serviceType.trim()) {
            setError(
              notInCatalog
                ? "Describe what the customer asked for"
                : "Pick a service"
            );
            return;
          }
          const cents = price ? Math.round(parseFloat(price) * 100) : null;
          if (!planId && price && (!Number.isFinite(cents!) || cents! <= 0)) {
            setError("Price doesn't look valid");
            return;
          }
          setBusy(true);
          onSubmit({
            serviceType: serviceType.trim(),
            serviceCode,
            priceCents: planId ? null : cents,
            scheduledDate,
            timeWindow: timeWindow.trim(),
            servicePlanId: planId,
            packet,
          }).catch((err) => {
            setError(err.message ?? "Could not create job");
            setBusy(false);
          });
        }}
      >
        {notInCatalog ? "Send to catalog decision" : "Create job"}
      </Button>
    </div>
  );
}

/** GL-12: edit the dispatch packet on an existing job via updateJobPacket. */
function JobPacketForm({
  job,
  onDone,
}: {
  job: Job;
  onDone: () => Promise<void>;
}) {
  const [packet, setPacket] = useState<PacketValues>({
    accessInstructions: job.accessInstructions ?? "",
    hazardNotes: job.hazardNotes ?? "",
    prepInstructions: job.prepInstructions ?? "",
    prepConfirmed: job.prepConfirmed ?? false,
    paymentExpectation:
      job.paymentExpectation === "COLLECT_NOTHING" ||
      job.paymentExpectation === "DUE_THROUGH_OFFICE"
        ? job.paymentExpectation
        : "",
  });
  // GL-12: explicit property classification — duration and pricing hang off it.
  const [propertyClass, setPropertyClass] = useState<string>(
    (job as { propertyClass?: string | null }).propertyClass ?? ""
  );
  // GL-12: a material change after the technician started needs a recorded
  // manager reason — the server refuses without it.
  const [managerReason, setManagerReason] = useState("");
  const started = Boolean(job.startedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="form-grid">
      <Field
        label="Property classification"
        hint="Residential visits take 30 minutes on site; commercial and community/common-area take 60. Required before dispatch."
      >
        <select
          value={propertyClass}
          onChange={(e) => setPropertyClass(e.target.value)}
        >
          <option value="">Pick one…</option>
          <option value="RESIDENTIAL">Residential (30 min)</option>
          <option value="COMMERCIAL">Commercial (60 min)</option>
          <option value="COMMUNITY">Community / common area (60 min)</option>
        </select>
      </Field>
      <PacketFields value={packet} onChange={setPacket} />
      {started ? (
        <Field
          label="Manager reason (service already started)"
          hint="Changing safety/access/scope/prep mid-visit is recorded with your name and shown to the technician."
        >
          <input
            value={managerReason}
            onChange={(e) => setManagerReason(e.target.value)}
            placeholder="Why this is changing now"
          />
        </Field>
      ) : null}
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void (async () => {
            try {
              opResult(
                await api().mutations.updateJobPacket({
                  jobId: job.id,
                  accessInstructions: packet.accessInstructions.trim() || undefined,
                  hazardNotes: packet.hazardNotes.trim() || undefined,
                  prepInstructions: packet.prepInstructions.trim() || undefined,
                  prepConfirmed: packet.prepInstructions.trim()
                    ? packet.prepConfirmed
                    : undefined,
                  paymentExpectation: packet.paymentExpectation || undefined,
                  propertyClass: propertyClass || undefined,
                  managerReason: managerReason.trim() || undefined,
                })
              );
              await onDone();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not save the packet");
              setBusy(false);
            }
          })();
        }}
      >
        Save packet
      </Button>
    </div>
  );
}

function GroupPicker({
  groups,
  currentGroupId,
  onPick,
}: {
  groups: CustomerGroup[];
  currentGroupId?: string | null;
  onPick: (groupId: string | null, reason: string) => Promise<void>;
}) {
  const [value, setValue] = useState(currentGroupId ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="form-grid">
      <Field
        label="Group"
        hint="Portal users in a group can view the other customers in it (for management companies)."
      >
        <select value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">No group</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </Field>
      {/* GL-11: membership changes grant/remove real portal access across the
          group, so every change records who, when, and why. */}
      <Field label="Why is this changing?">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. new property manager for Maple Ridge"
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        disabled={!reason.trim()}
        onClick={() => {
          setBusy(true);
          onPick(value || null, reason.trim()).catch((err) => {
            setError(err.message ?? "Could not update group");
            setBusy(false);
          });
        }}
      >
        Save group
      </Button>
    </div>
  );
}

/**
 * GL-11 — the customer's portal requests (reschedule / help), with the one
 * office action: resolve WITH AN ANSWER the customer sees in their portal
 * (and by email). Resolving here also closes the shared-queue item.
 */
type PortalRequestRow = {
  id: string;
  kind: string;
  jobId?: string | null;
  preferredDate?: string | null;
  message?: string | null;
  status: string;
  resolutionNote?: string | null;
  createdAt?: string | null;
};

function PortalRequestsSection({ customerId }: { customerId: string }) {
  const [rows, setRows] = useState<PortalRequestRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRows = useCallback(async () => {
    try {
      const models = api().models as unknown as {
        PortalRequest?: {
          listPortalRequestByCustomerId: (a: {
            customerId: string;
            limit?: number;
          }) => Promise<{ data: PortalRequestRow[] }>;
        };
      };
      if (!models.PortalRequest) {
        setRows([]);
        return;
      }
      const { data } = await models.PortalRequest.listPortalRequestByCustomerId(
        { customerId, limit: 100 }
      );
      setRows(data ?? []);
    } catch {
      setRows([]);
    }
  }, [customerId]);
  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  if (!rows || rows.length === 0) return null;

  const resolve = async (r: PortalRequestRow) => {
    const note = window.prompt(
      "The answer the customer will see in their portal and by email:"
    );
    if (!note?.trim()) return;
    setBusyId(r.id);
    setError(null);
    try {
      opResult(
        await (
          api().mutations as unknown as {
            resolvePortalRequest: (a: {
              portalRequestId: string;
              note: string;
            }) => Promise<{ data: unknown; errors?: { message: string }[] }>;
          }
        ).resolvePortalRequest({ portalRequestId: r.id, note: note.trim() })
      );
      await loadRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resolve");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card title="Portal requests">
      <ErrorNote error={error} />
      {rows
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
        .map((r) => (
          <ListRow
            key={r.id}
            title={r.kind === "RESCHEDULE" ? "Reschedule request" : "Help request"}
            subtitle={
              <>
                {[
                  r.jobId ? `visit ${r.jobId}` : null,
                  r.preferredDate ? `prefers ${fmtDate(r.preferredDate, true)}` : null,
                  r.message ?? null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                {r.resolutionNote ? (
                  <span className="nested-line">Answered: {r.resolutionNote}</span>
                ) : null}
              </>
            }
            meta={
              r.status === "RESOLVED" ? (
                <Badge tone="ok">answered</Badge>
              ) : (
                <>
                  <Badge tone="warn">open</Badge>
                  <Button
                    small
                    loading={busyId === r.id}
                    onClick={() => void resolve(r)}
                  >
                    Resolve with an answer
                  </Button>
                </>
              )
            }
          />
        ))}
    </Card>
  );
}

/**
 * GL-10 — the customer's guarantee callbacks: reference, promise clock,
 * photo evidence, the one scheduling action (never beyond the promised
 * return unless the customer chose later), and the technician's finding
 * once recorded. Money never appears — a callback visit is $0 by
 * construction.
 */
type CallbackRow = {
  id: string;
  originalJobId: string;
  status: string;
  photoKey?: string | null;
  note?: string | null;
  promisedBy?: string | null;
  scheduledDate?: string | null;
  callbackJobId?: string | null;
  finding?: string | null;
  findingNote?: string | null;
};

const CALLBACK_STATUS_LABEL: Record<string, string> = {
  REQUESTED: "needs scheduling",
  SCHEDULED: "scheduled",
  COMPLETED: "completed — guarantee continues",
  GUARANTEE_ENDED: "guarantee ended by finding",
};

function CallbacksSection({
  customerId,
  onChanged,
}: {
  customerId: string;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<CallbackRow[] | null>(null);
  const [scheduling, setScheduling] = useState<CallbackRow | null>(null);
  const [date, setDate] = useState("");
  const [window, setWindow] = useState("8-12");
  const [technicianId, setTechnicianId] = useState("");
  const [techs, setTechs] = useState<{ id: string; displayName?: string | null }[]>([]);
  const [laterOk, setLaterOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRows = useCallback(async () => {
    try {
      const models = api().models as unknown as {
        CallbackRequest?: {
          listCallbackRequestByCustomerId: (a: {
            customerId: string;
            limit?: number;
          }) => Promise<{ data: CallbackRow[] }>;
        };
      };
      if (!models.CallbackRequest) {
        setRows([]);
        return;
      }
      const { data } =
        await models.CallbackRequest.listCallbackRequestByCustomerId({
          customerId,
          limit: 100,
        });
      setRows(data ?? []);
    } catch {
      setRows([]);
    }
  }, [customerId]);
  useEffect(() => {
    void loadRows();
  }, [loadRows]);
  // The callback visit takes real technician minutes — scheduling it picks
  // a real technician whose capacity the backend reserves atomically.
  useEffect(() => {
    if (!scheduling) return;
    void (async () => {
      try {
        const { data } = await api().models.Technician.list({ limit: 200 });
        setTechs(
          (data ?? [])
            .filter((t) => t.active !== false)
            .map((t) => ({ id: t.id, displayName: t.name }))
        );
      } catch {
        setTechs([]);
      }
    })();
  }, [scheduling]);

  if (!rows || rows.length === 0) return null;

  const schedule = async () => {
    if (!scheduling || !date || !technicianId) return;
    setBusy(true);
    setError(null);
    try {
      opResult(
        await (
          api().mutations as unknown as {
            scheduleCallback: (a: {
              callbackRequestId: string;
              scheduledDate: string;
              timeWindow?: string;
              technicianId: string;
              customerRequestedLater?: boolean;
            }) => Promise<{ data: unknown; errors?: { message: string }[] }>;
          }
        ).scheduleCallback({
          callbackRequestId: scheduling.id,
          scheduledDate: date,
          timeWindow: window,
          technicianId,
          customerRequestedLater: laterOk || undefined,
        })
      );
      setScheduling(null);
      setDate("");
      setTechnicianId("");
      setLaterOk(false);
      await loadRows();
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Guarantee callbacks">
      {rows.map((cb) => (
        <ListRow
          key={cb.id}
          title={`${cb.id} — visit ${cb.originalJobId}`}
          subtitle={
            <>
              {`Promised return by ${cb.promisedBy ?? "—"}${cb.scheduledDate ? ` · scheduled ${fmtDate(cb.scheduledDate, true)}` : ""}`}
              {cb.note ? <span className="nested-line">{cb.note}</span> : null}
              {cb.photoKey ? (
                <span className="nested-line">
                  customer photo <DocButton docKey={cb.photoKey} label="view" />
                </span>
              ) : null}
              {cb.finding ? (
                <span className="nested-line">
                  Finding: {cb.finding.replace(/_/g, " ").toLowerCase()}
                  {cb.findingNote ? ` — ${cb.findingNote}` : ""}
                </span>
              ) : null}
            </>
          }
          meta={
            <>
              <Badge
                tone={
                  cb.status === "GUARANTEE_ENDED" || cb.status === "REQUESTED"
                    ? "warn"
                    : "ok"
                }
              >
                {CALLBACK_STATUS_LABEL[cb.status] ?? cb.status.toLowerCase()}
              </Badge>
              {cb.status === "REQUESTED" ? (
                <Button small onClick={() => setScheduling(cb)}>
                  Schedule
                </Button>
              ) : null}
            </>
          }
        />
      ))}
      <Sheet
        open={scheduling !== null}
        onClose={() => setScheduling(null)}
        title="Schedule the callback"
      >
        {scheduling ? (
          <div className="form-grid">
            <p className="muted small" style={{ margin: 0 }}>
              Promised return by <strong>{scheduling.promisedBy ?? "—"}</strong>.
              The visit is at no charge — nothing to price, nothing to collect.
            </p>
            <Field label="Date">
              <DateField value={date} onChange={setDate} />
            </Field>
            <Field label="Arrival window">
              <SegControl
                value={window}
                onChange={setWindow}
                options={[
                  { value: "8-12", label: "Morning (8–12)" },
                  { value: "12-5", label: "Afternoon (12–5)" },
                ]}
              />
            </Field>
            <Field
              label="Technician"
              hint="The visit reserves real minutes on their day — same capacity rules as any visit"
            >
              <select
                value={technicianId}
                onChange={(e) => setTechnicianId(e.target.value)}
              >
                <option value="">Pick a technician…</option>
                {techs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName ?? t.id}
                  </option>
                ))}
              </select>
            </Field>
            {scheduling.promisedBy && date > scheduling.promisedBy ? (
              <label className="inline-check small">
                <input
                  type="checkbox"
                  checked={laterOk}
                  onChange={(e) => setLaterOk(e.target.checked)}
                />{" "}
                The customer asked for this later date
              </label>
            ) : null}
            <ErrorNote error={error} />
            <Button
              block
              loading={busy}
              disabled={!date || !technicianId}
              onClick={() => void schedule()}
            >
              Schedule the callback visit
            </Button>
          </div>
        ) : null}
      </Sheet>
    </Card>
  );
}
