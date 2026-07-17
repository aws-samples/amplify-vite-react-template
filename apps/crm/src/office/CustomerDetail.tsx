import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  dueDateForTerms,
  opResult,
  recordOfflinePayment,
  sendInvoicePaymentLink,
  settleInvoice,
  unwrap,
  type Agreement,
  type Customer,
  type CustomerGroup,
  type Invoice,
  type InvoiceTerms,
  type Job,
  type ServicePlan,
  type ServiceReport,
} from "../lib/api";
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
import CollectPaymentSheet from "../components/CollectPaymentSheet";
import DocButton from "../components/DocButton";
import PriceLeadSheet from "../components/PriceLeadSheet";
import { DateField, TimeWindowField } from "../components/DateTimeFields";
import { useRoles } from "../lib/auth";

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
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [rescheduling, setRescheduling] = useState<Job | null>(null);
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
      const [pl, jb, ag, rp, inv, gr] = await Promise.all([
        api().models.ServicePlan.list({ filter, limit: 200 }),
        api().models.Job.list({ filter, limit: 500 }),
        api().models.Agreement.list({ filter, limit: 200 }),
        api().models.ServiceReport.list({ filter, limit: 500 }),
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
      setInvoices(
        unwrap(inv).sort((a, b) =>
          (b.issuedAt ?? "").localeCompare(a.issuedAt ?? "")
        )
      );
      setGroups(unwrap(gr));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load customer");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

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
            disabled={!customer.email}
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
              subtitle={planCadence(p.priceCents, p.serviceFrequency)}
              meta={
                <>
                  <StatusBadge status={p.status} />
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
                            loading={busyAction === `canceljob-${j.id}`}
                            onClick={() => {
                              if (!window.confirm("Cancel this job?")) return;
                              void run(`canceljob-${j.id}`, async () =>
                                opResult(
                                  await api().mutations.updateJobSchedule({
                                    jobId: j.id,
                                    operation: "CANCEL",
                                  })
                                )
                              );
                            }}
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
          reports.map((r) => (
            <ListRow
              key={r.id}
              title={fmtDate(r.serviceDate, true)}
              subtitle={r.servicesPerformed ?? undefined}
              meta={r.pdfKey ? <DocButton docKey={r.pdfKey} /> : undefined}
            />
          ))
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
                const activePlanCount = plans.filter(
                  (p) => p.status === "ACTIVE"
                ).length;
                const upcomingVisits = jobs.filter(
                  (j) =>
                    (j.status === "SCHEDULED" || j.status === "UNSCHEDULED") &&
                    !j.paidAt
                ).length;
                if (
                  !window.confirm(
                    deactivateConfirmText(customer.displayName, {
                      activePlanCount,
                      upcomingVisits,
                      hasPortal: !!customer.portalUserSub,
                    })
                  )
                ) {
                  return;
                }
                void run("deactivate", async () => {
                  const res = opResult<{
                    plansCanceled: number;
                    jobsCanceled: number;
                    visitsResolved: number;
                    outstandingBalanceCents: number;
                    partial: boolean;
                  }>(
                    await api().mutations.deactivateCustomer({
                      customerId: customer.id,
                    })
                  );
                  // A plan's Stripe cancel failed: the customer is still ACTIVE
                  // and still billing on purpose, and the office was paged. Do
                  // NOT go on to revoke the portal — the deactivation didn't
                  // finish. Surface it instead of claiming success.
                  if (res?.partial) {
                    throw new Error(
                      "A plan could not be canceled at Stripe, so the customer is still active and still billing. The office has been notified — try again once Stripe is reachable."
                    );
                  }
                  unwrap(
                    await api().mutations.revokePortalAccess({
                      customerId: customer.id,
                    })
                  );
                  const bal = res?.outstandingBalanceCents ?? 0;
                  setNotice(
                    `${customer.displayName} deactivated — billing stopped, ${
                      res?.jobsCanceled ?? 0
                    } upcoming visit(s) canceled, portal login ended.${
                      bal > 0
                        ? ` Outstanding balance of ${money(
                            bal
                          )} is NOT charged — settle it separately.`
                        : ""
                    }`
                  );
                  window.setTimeout(
                    () => setNotice((n) => (n && n.startsWith(customer.displayName) ? null : n)),
                    12000
                  );
                });
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
            onClick={() =>
              void run(
                "reactivate",
                async () => {
                  unwrap(
                    await api().models.Customer.update({
                      id: customer.id,
                      status: "ACTIVE",
                    })
                  );
                  // Re-enable the portal login (idempotent, no-op if none). The
                  // canceled plans stay canceled — a reactivated customer
                  // re-subscribes through a new booking.
                  unwrap(
                    await api().mutations.restorePortalAccess({
                      customerId: customer.id,
                    })
                  );
                },
                "Customer reactivated — their portal login is back on. Canceled plans stay canceled; add a new plan through a booking."
              )
            }
          >
            Reactivate customer
          </Button>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Ask finance or an owner to reactivate this customer.
          </p>
        )
      ) : null}

      {/* ---------- Sheets ---------- */}

      <Sheet open={sheet === "edit"} onClose={() => setSheet(null)} title="Edit customer">
        <CustomerForm
          initial={customerToForm(customer)}
          submitLabel="Save changes"
          showLeadSource={isLead}
          onSubmit={async (v) => {
            unwrap(
              await api().models.Customer.update({
                id: customer.id,
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

      <Sheet open={sheet === "job"} onClose={() => setSheet(null)} title="New job">
        <JobForm
          plans={plans}
          onSubmit={async (v) => {
            opResult(
              await api().mutations.createOfficeJob({
                customerId: customer.id,
                servicePlanId: v.servicePlanId || undefined,
                serviceType: v.serviceType,
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
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "group"} onClose={() => setSheet(null)} title="Customer group">
        <GroupPicker
          groups={groups}
          currentGroupId={customer.groupId}
          onPick={async (groupId) => {
            unwrap(
              await api().mutations.setCustomerGroup({
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateChanged = date !== (job.scheduledDate ?? "");

  return (
    <div className="form-grid">
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
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api()
            .mutations.updateJobSchedule({
              jobId: job.id,
              operation: "RESCHEDULE",
              scheduledDate: date || null,
              timeWindow: timeWindow.trim() || null,
            })
            .then((res) => {
              opResult(res);
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
    priceCents: number | null;
    scheduledDate: string;
    timeWindow: string;
    servicePlanId: string;
    packet: PacketValues;
  }) => Promise<void>;
}) {
  const [serviceType, setServiceType] = useState("General Pest Treatment");
  const [price, setPrice] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [timeWindow, setTimeWindow] = useState("");
  const [planId, setPlanId] = useState("");
  const [packet, setPacket] = useState<PacketValues>(emptyPacket);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activePlans = plans.filter((p) => p.status === "ACTIVE");

  return (
    <div className="form-grid">
      <Field label="Service type">
        <input value={serviceType} onChange={(e) => setServiceType(e.target.value)} />
      </Field>
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
            setError("Service type is required");
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
        Create job
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="form-grid">
      <PacketFields value={packet} onChange={setPacket} />
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
  onPick: (groupId: string | null) => Promise<void>;
}) {
  const [value, setValue] = useState(currentGroupId ?? "");
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
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          setBusy(true);
          onPick(value || null).catch((err) => {
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
