import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api,
  opResult,
  unwrap,
  type Agreement,
  type Customer,
  type CustomerGroup,
  type Invoice,
  type Job,
  type PlanTemplate,
  type Quote,
  type ServicePlan,
  type ServiceReport,
} from "../lib/api";
import { customerAccessGroups } from "../lib/accessGroups";
import {
  DEFAULT_AGREEMENT_BODY,
  fillAgreementTemplate,
} from "../lib/agreementTemplate";
import { fmtDate, fmtDateTime, money, todayEastern } from "../lib/format";
import { amountInWords } from "../lib/amountWords";
import { planCadence } from "../lib/planCadence";
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
import QuoteSheet from "../components/QuoteSheet";
import PriceLeadSheet from "../components/PriceLeadSheet";
import { DateField, TimeWindowField } from "../components/DateTimeFields";
import { useRoles } from "../lib/auth";

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
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [groups, setGroups] = useState<CustomerGroup[]>([]);
  const [rescheduling, setRescheduling] = useState<Job | null>(null);
  const [pm, setPm] = useState<{ hasPaymentMethod: boolean; label: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [refunding, setRefunding] = useState<Invoice | null>(null);
  const [sheet, setSheet] = useState<
    | null
    | "edit"
    | "convert"
    | "plan"
    | "job"
    | "agreement"
    | "collect"
    | "charge"
    | "record"
    | "portal"
    | "group"
    | "quote"
    | "price"
  >(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const accessGroups = useMemo(
    () => (customer ? customerAccessGroups(customer.id, customer.groupId) : []),
    [customer]
  );

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
      const [pl, jb, ag, rp, inv, gr, qt] = await Promise.all([
        api().models.ServicePlan.list({ filter, limit: 200 }),
        api().models.Job.list({ filter, limit: 500 }),
        api().models.Agreement.list({ filter, limit: 200 }),
        api().models.ServiceReport.list({ filter, limit: 500 }),
        api().models.Invoice.list({ filter, limit: 500 }),
        api().models.CustomerGroup.list({ limit: 500 }),
        api().models.Quote.list({ filter, limit: 200 }),
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
      setQuotes(
        unwrap(qt).sort((a, b) =>
          (b.quotedAt ?? "").localeCompare(a.quotedAt ?? "")
        )
      );
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
        <Card title="Convert this lead">
          <p className="muted small" style={{ marginBottom: 10 }}>
            A customer needs an active service plan or a scheduled one-time
            job. Converting will set one up and activate the account.
          </p>
          <Button block onClick={() => setSheet("convert")}>
            Convert to customer
          </Button>
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
          <div className="row-split">
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
          {!customer.email ? (
            <p className="muted small" style={{ marginTop: 8 }}>
              Add an email address first.
            </p>
          ) : null}
        </Card>
      ) : null}

      {roles.office && (quotes.length > 0 || isLead) ? (
        <Card
          title="Quotes"
          actions={
            <>
              {isLead ? (
                <Button small variant="subtle" onClick={() => setSheet("price")}>
                  ⚡ AI price
                </Button>
              ) : null}
              <Button small variant="ghost" onClick={() => setSheet("quote")}>
                + Quote
              </Button>
            </>
          }
        >
          {quotes.length === 0 ? (
            <p className="muted small">
              No quotes yet — quote a plan and the agreement goes out for
              signature. Signing converts the lead automatically.
            </p>
          ) : (
            quotes.map((q) => (
              <ListRow
                key={q.id}
                title={q.planName}
                subtitle={`${money(q.priceCents)}/mo · quoted ${fmtDate(q.quotedAt, true)}${q.notes ? ` · ${q.notes}` : ""}`}
                meta={
                  <>
                    <StatusBadge status={q.status} />
                    {q.status === "DRAFT" || q.status === "SENT" ? (
                      <Button
                        small
                        variant="ghost"
                        loading={busyAction === `voidquote-${q.id}`}
                        onClick={() => {
                          if (!window.confirm("Void this quote? The signing link in any sent agreement stays usable unless you void the agreement too.")) return;
                          void run(`voidquote-${q.id}`, async () =>
                            unwrap(
                              await api().models.Quote.update({ id: q.id, status: "VOID" })
                            )
                          );
                        }}
                      >
                        Void
                      </Button>
                    ) : null}
                  </>
                }
              />
            ))
          )}
        </Card>
      ) : null}

      <Card
        title="Service plans"
        actions={
          roles.office ? (
            <Button small variant="ghost" onClick={() => setSheet("plan")}>
              + Plan
            </Button>
          ) : undefined
        }
      >
        {plans.length === 0 ? (
          <p className="muted small">No service plans.</p>
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
                          onClick={() =>
                            void run(`start-${p.id}`, async () =>
                              unwrap(
                                await api().mutations.startSubscription({
                                  servicePlanId: p.id,
                                })
                              )
                            )
                          }
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

      <Card
        title="Jobs"
        actions={
          roles.office ? (
            <Button small variant="ghost" onClick={() => setSheet("job")}>
              + Job
            </Button>
          ) : undefined
        }
      >
        {activePlan && !upcomingJob && roles.office ? (
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
          <p className="muted small">No jobs yet.</p>
        ) : (
          (() => {
            const renderJob = (j: Job) => {
              const report = reports.find((r) => r.jobId === j.id);
              const invoice = invoices.find(
                (inv) => inv.jobId === j.id && inv.status !== "FAILED"
              );
              const reschedulable =
                roles.office &&
                (j.status === "SCHEDULED" || j.status === "UNSCHEDULED");
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
                      {roles.office &&
                      (j.status === "SCHEDULED" || j.status === "IN_PROGRESS") ? (
                        <Button
                          small
                          variant="ghost"
                          loading={busyAction === `complete-${j.id}`}
                          onClick={() => {
                            if (!window.confirm("Mark this job completed without a tech report? The customer won't get a field report for it.")) return;
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
                          onClick={() =>
                            void run(`charge-${j.id}`, async () =>
                              unwrap(
                                await api().mutations.chargeOneTimeJob({ jobId: j.id })
                              )
                            )
                          }
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
                                unwrap(
                                  await api().models.Job.update({
                                    id: j.id,
                                    status: "CANCELED",
                                    routeId: null,
                                    routeOrder: null,
                                  })
                                )
                              );
                            }}
                          >
                            ✕
                          </Button>
                        </>
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

      {roles.office ? (
        <Card
          title="Agreements"
          actions={
            <Button small variant="ghost" onClick={() => setSheet("agreement")}>
              + Agreement
            </Button>
          }
        >
          {agreements.length === 0 ? (
            <p className="muted small">No agreements yet.</p>
          ) : (
            agreements.map((a) => (
              <ListRow
                key={a.id}
                title={a.title}
                subtitle={
                  a.signedAt
                    ? `Signed by ${a.signerName} · ${fmtDateTime(a.signedAt)}`
                    : a.sentAt
                      ? `Sent ${fmtDateTime(a.sentAt)}`
                      : "Draft"
                }
                meta={
                  <>
                    <StatusBadge status={a.status} />
                    {a.signToken && a.status !== "SIGNED" && a.status !== "VOID" ? (
                      <Button
                        small
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard
                            .writeText(`${window.location.origin}/sign/${a.signToken}`)
                            .then(() => {
                              setNotice("Signing link copied — paste it anywhere");
                              window.setTimeout(() => setNotice(null), 6000);
                            })
                            .catch(() => setError("Couldn't copy — long-press the Send button link instead"));
                        }}
                      >
                        Copy link
                      </Button>
                    ) : null}
                    {a.status !== "VOID" ? (
                      <Button
                        small
                        variant="ghost"
                        loading={busyAction === `voidagr-${a.id}`}
                        onClick={() => {
                          if (!window.confirm(a.status === "SIGNED" ? "Void this SIGNED agreement? The signed PDF stays on file but the agreement is marked void." : "Void this agreement? Its signing link stops working.")) return;
                          void run(`voidagr-${a.id}`, async () =>
                            unwrap(
                              await api().models.Agreement.update({ id: a.id, status: "VOID" })
                            )
                          );
                        }}
                      >
                        Void
                      </Button>
                    ) : null}
                    {a.pdfKey ? (
                      <DocButton docKey={a.pdfKey} />
                    ) : a.status !== "SIGNED" ? (
                      <Button
                        small
                        variant="subtle"
                        disabled={!customer.email}
                        loading={busyAction === `send-${a.id}`}
                        onClick={() =>
                          void run(
                            `send-${a.id}`,
                            async () =>
                              unwrap(
                                await api().mutations.sendAgreement({
                                  agreementId: a.id,
                                })
                              ),
                            `Agreement emailed to ${customer.email} for signing`
                          )
                        }
                      >
                        {a.status === "DRAFT" ? "Send" : "Resend"}
                      </Button>
                    ) : null}
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
                      {refundedCents > 0 ? (
                        <span className="nested-line">
                          {money(refundedCents)} refunded
                          {inv.refundReason ? ` — ${inv.refundReason}` : ""}
                        </span>
                      ) : null}
                    </>
                  }
                  meta={
                    <>
                      <StatusBadge status={inv.status} />
                      {canRefund ? (
                        <Button
                          small
                          variant="ghost"
                          onClick={() => setRefunding(inv)}
                        >
                          Refund
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

      {roles.office && customer.status !== "LEAD" ? (
        <Button
          block
          variant={customer.status === "ACTIVE" ? "danger" : "subtle"}
          loading={busyAction === "toggle"}
          onClick={() =>
            void run("toggle", async () =>
              unwrap(
                await api().models.Customer.update({
                  id: customer.id,
                  status: customer.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                })
              )
            )
          }
        >
          {customer.status === "ACTIVE" ? "Mark inactive" : "Reactivate customer"}
        </Button>
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

      <Sheet open={sheet === "convert"} onClose={() => setSheet(null)} title="Convert lead">
        <ConvertLead
          customer={customer}
          accessGroups={accessGroups}
          onDone={async () => {
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "plan"} onClose={() => setSheet(null)} title="New service plan">
        {isLead ? (
          <p className="muted small" style={{ marginBottom: 10 }}>
            This is still a lead — creating a plan will convert them to an
            active customer.
          </p>
        ) : null}
        <PlanForm
          onSubmit={async (v) => {
            unwrap(
              await api().models.ServicePlan.create({
                customerId: customer.id,
                planName: v.planName,
                priceCents: v.priceCents,
                serviceFrequency: v.serviceFrequency,
                status: "ACTIVE",
                accessGroups,
              })
            );
            if (isLead) {
              unwrap(
                await api().models.Customer.update({
                  id: customer.id,
                  status: "ACTIVE",
                  convertedAt: new Date().toISOString(),
                })
              );
            }
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "quote"} onClose={() => setSheet(null)} title="Quote a plan">
        <QuoteSheet
          customer={customer}
          accessGroups={accessGroups}
          onDone={async () => {
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "price"} onClose={() => setSheet(null)} title="AI price this lead">
        <PriceLeadSheet customer={customer} onQuoteCreated={load} />
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

      <Sheet open={sheet === "job"} onClose={() => setSheet(null)} title="New job">
        <JobForm
          plans={plans}
          onSubmit={async (v) => {
            unwrap(
              await api().models.Job.create({
                customerId: customer.id,
                servicePlanId: v.servicePlanId || undefined,
                type: v.servicePlanId ? "RECURRING" : "ONE_TIME",
                serviceType: v.serviceType,
                priceCents: v.priceCents ?? undefined,
                status: v.scheduledDate ? "SCHEDULED" : "UNSCHEDULED",
                scheduledDate: v.scheduledDate || undefined,
                timeWindow: v.timeWindow || undefined,
                accessGroups,
              })
            );
            setSheet(null);
            await load();
          }}
        />
      </Sheet>

      <Sheet open={sheet === "agreement"} onClose={() => setSheet(null)} title="New agreement">
        <AgreementForm
          customer={customer}
          onSubmit={async (title, bodyText, sendNow) => {
            const created = unwrap(
              await api().models.Agreement.create({
                customerId: customer.id,
                title,
                bodyText,
                status: "DRAFT",
                accessGroups,
              })
            );
            if (sendNow && created) {
              unwrap(
                await api().mutations.sendAgreement({ agreementId: created.id })
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = Math.round(parseFloat(amount) * 100);
  const validAmount = Number.isFinite(cents) && cents > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await api().mutations.recordOfflinePayment({
          customerId: customer.id,
          amountCents: cents,
          description: description.trim(),
          status,
          method: status === "PAID" ? method : undefined,
        })
      );
      await onDone(
        status === "PAID"
          ? `Recorded ${money(cents)} received by ${method.toLowerCase()}`
          : `Raised a ${money(cents)} invoice`
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
      ) : null}
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

/* ---------- Sub-forms ---------- */

function PlanForm({
  onSubmit,
}: {
  onSubmit: (v: {
    planName: string;
    priceCents: number;
    serviceFrequency: "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
  }) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<PlanTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api()
      .models.PlanTemplate.list({ limit: 200 })
      .then((res) => {
        const active = unwrap(res)
          .filter((t) => t.active)
          .sort(
            (a, b) =>
              (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
              a.name.localeCompare(b.name)
          );
        setTemplates(active);
        if (active[0]) {
          setTemplateId(active[0].id);
          setPrice(
            active[0].priceCents != null
              ? (active[0].priceCents / 100).toString()
              : ""
          );
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load templates")
      );
  }, []);

  if (templates === null) return <p className="muted">Loading plan templates…</p>;
  if (templates.length === 0) {
    return (
      <p className="muted">
        No active plan templates — create one under More → Plan templates
        first. Plans are always created from a template.
      </p>
    );
  }
  const template = templates.find((t) => t.id === templateId) ?? null;

  return (
    <div className="form-grid">
      <Field label="Plan">
        <select
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            const t = templates.find((x) => x.id === e.target.value);
            if (t) setPrice(t.priceCents != null ? (t.priceCents / 100).toString() : "");
          }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}{t.priceCents != null ? ` — ${money(t.priceCents)}/mo` : ""} · {t.serviceFrequency?.toLowerCase()}
            </option>
          ))}
        </select>
      </Field>
      {template?.description ? (
        <p className="muted small">{template.description}</p>
      ) : null}
      <Field label="Monthly price ($)" hint="Prefilled from the template — adjust if needed">
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          const cents = Math.round(parseFloat(price) * 100);
          if (!template || !Number.isFinite(cents) || cents <= 0) {
            setError("Pick a plan and enter a valid price");
            return;
          }
          setBusy(true);
          onSubmit({
            planName: template.name,
            priceCents: cents,
            serviceFrequency: (template.serviceFrequency ??
              "MONTHLY") as "MONTHLY" | "BIMONTHLY" | "QUARTERLY",
          }).catch((err) => {
            setError(err.message ?? "Could not create plan");
            setBusy(false);
          });
        }}
      >
        Create plan
      </Button>
      <p className="muted small">
        Billing starts only when you tap “Start billing” (requires a payment
        method on file).
      </p>
    </div>
  );
}

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
            .models.Job.update({
              id: job.id,
              scheduledDate: date || null,
              timeWindow: timeWindow.trim() || null,
              status: date ? "SCHEDULED" : "UNSCHEDULED",
              ...(dateChanged ? { routeId: null, routeOrder: null } : {}),
            })
            .then((res) => {
              unwrap(res);
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
  }) => Promise<void>;
}) {
  const [serviceType, setServiceType] = useState("General Pest Treatment");
  const [price, setPrice] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [timeWindow, setTimeWindow] = useState("");
  const [planId, setPlanId] = useState("");
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

function AgreementForm({
  customer,
  onSubmit,
}: {
  customer: Customer;
  onSubmit: (title: string, bodyText: string, sendNow: boolean) => Promise<void>;
}) {
  const [title, setTitle] = useState("Pest Control Service Agreement");
  const [bodyText, setBodyText] = useState(
    fillAgreementTemplate(DEFAULT_AGREEMENT_BODY, {
      customerName: customer.displayName,
      planName: "pest control",
      price: "the quoted price",
      frequency: "as scheduled",
      address: [
        customer.serviceStreet,
        customer.serviceCity,
        customer.serviceState,
        customer.serviceZip,
      ]
        .filter(Boolean)
        .join(", ") || "the Customer's service address",
    })
  );
  const [busy, setBusy] = useState<null | "draft" | "send">(null);
  const [error, setError] = useState<string | null>(null);

  const go = (sendNow: boolean) => {
    if (!title.trim() || !bodyText.trim()) {
      setError("Title and agreement text are required");
      return;
    }
    if (sendNow && !customer.email) {
      setError("Customer needs an email address to receive the signing link");
      return;
    }
    setBusy(sendNow ? "send" : "draft");
    onSubmit(title.trim(), bodyText, sendNow).catch((err) => {
      setError(err.message ?? "Could not save agreement");
      setBusy(null);
    });
  };

  return (
    <div className="form-grid">
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Agreement text">
        <textarea rows={12} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <div className="form-row-2">
        <Button variant="ghost" loading={busy === "draft"} onClick={() => go(false)}>
          Save draft
        </Button>
        <Button loading={busy === "send"} onClick={() => go(true)}>
          Save &amp; send
        </Button>
      </div>
    </div>
  );
}

function ConvertLead({
  customer,
  accessGroups,
  onDone,
}: {
  customer: Customer;
  accessGroups: string[];
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"PLAN" | "ONE_TIME">("PLAN");

  const activate = async () => {
    unwrap(
      await api().models.Customer.update({
        id: customer.id,
        status: "ACTIVE",
        convertedAt: new Date().toISOString(),
      })
    );
    await onDone();
  };

  return (
    <div className="form-grid">
      <SegControl
        options={[
          { value: "PLAN" as const, label: "Service plan" },
          { value: "ONE_TIME" as const, label: "One-time job" },
        ]}
        value={mode}
        onChange={setMode}
      />
      {mode === "PLAN" ? (
        <PlanForm
          onSubmit={async (v) => {
            unwrap(
              await api().models.ServicePlan.create({
                customerId: customer.id,
                planName: v.planName,
                priceCents: v.priceCents,
                serviceFrequency: v.serviceFrequency,
                status: "ACTIVE",
                accessGroups,
              })
            );
            await activate();
          }}
        />
      ) : (
        <JobForm
          plans={[]}
          onSubmit={async (v) => {
            if (!v.scheduledDate) {
              throw new Error("A one-time job needs a scheduled date to convert the lead");
            }
            unwrap(
              await api().models.Job.create({
                customerId: customer.id,
                type: "ONE_TIME",
                serviceType: v.serviceType,
                priceCents: v.priceCents ?? undefined,
                status: "SCHEDULED",
                scheduledDate: v.scheduledDate,
                timeWindow: v.timeWindow || undefined,
                accessGroups,
              })
            );
            await activate();
          }}
        />
      )}
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
