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
  type ServicePlan,
  type ServiceReport,
} from "../lib/api";
import { customerAccessGroups } from "../lib/accessGroups";
import { fmtDate, fmtDateTime, money, todayEastern } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
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
import { useRoles } from "../lib/auth";

const AGREEMENT_TEMPLATE = (name: string) => `SERVICE AGREEMENT

This agreement is between BuzzKill Pest Control ("BuzzKill") and ${name} ("Customer").

1. SERVICES. BuzzKill will provide pest control services at the Customer's service address as described in the selected service plan or scheduled one-time service.

2. TERM & BILLING. Recurring plans are billed monthly to the payment method on file until canceled with 30 days' notice. One-time services are billed upon completion.

3. ACCESS. Customer will provide reasonable access to the service areas on scheduled service dates.

4. RE-TREATMENT GUARANTEE. If covered pests return between scheduled visits, BuzzKill will re-treat at no additional charge.

5. CANCELLATION. Either party may cancel with written notice. Charges for services already performed remain due.

By signing below, the Customer agrees to these terms and consents to transact electronically.`;

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
  const [pm, setPm] = useState<{ hasPaymentMethod: boolean; label: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [sheet, setSheet] = useState<
    | null
    | "edit"
    | "convert"
    | "plan"
    | "job"
    | "agreement"
    | "collect"
    | "portal"
    | "group"
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

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusyAction(name);
    setError(null);
    try {
      await fn();
      await load();
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
                void run("payreq", async () =>
                  unwrap(
                    await api().mutations.sendCustomerEmail({
                      customerId: customer.id,
                      kind: "payment-request",
                    })
                  )
                )
              }
            >
              Email request
            </Button>
          </div>
        </Card>
      ) : null}

      {roles.office ? (
        <Card
          title="Portal access"
          actions={
            customer.portalUserSub ? <Badge tone="ok">invited</Badge> : <Badge tone="muted">not invited</Badge>
          }
        >
          <p className="muted small" style={{ marginBottom: 10 }}>
            {customer.portalUserSub
              ? `Portal login active${customer.portalInvitedAt ? ` since ${fmtDate(customer.portalInvitedAt, true)}` : ""}.`
              : "Invite the customer to view services, documents, and billing online."}
          </p>
          <div className="row-split">
            <Button
              small
              variant="subtle"
              disabled={!customer.email}
              loading={busyAction === "invite"}
              onClick={() =>
                void run("invite", async () =>
                  unwrap(
                    await api().mutations.adminCreateUser({
                      email: customer.email!,
                      name: customer.contactName ?? customer.displayName,
                      roles: ["CUSTOMER"],
                      customerId: customer.id,
                      resend: Boolean(customer.portalUserSub),
                    })
                  )
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
                  void run("remind", async () =>
                    unwrap(
                      await api().mutations.sendCustomerEmail({
                        customerId: customer.id,
                        kind: "portal-reminder",
                      })
                    )
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
              subtitle={`${money(p.priceCents)}/mo · service ${p.serviceFrequency?.toLowerCase()}`}
              meta={
                <>
                  <StatusBadge status={p.status} />
                  {roles.office && p.status === "ACTIVE" ? (
                    p.stripeSubscriptionId ? (
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
                    )
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
        {jobs.length === 0 ? (
          <p className="muted small">No jobs yet.</p>
        ) : (
          jobs.slice(0, 8).map((j) => (
            <ListRow
              key={j.id}
              title={j.serviceType}
              subtitle={`${j.scheduledDate ? fmtDate(j.scheduledDate, true) : "unscheduled"}${j.timeWindow ? ` · ${j.timeWindow}` : ""}${j.priceCents ? ` · ${money(j.priceCents)}` : ""}`}
              meta={
                <>
                  <StatusBadge status={j.status} />
                  {roles.office &&
                  j.type === "ONE_TIME" &&
                  j.status === "COMPLETED" &&
                  j.priceCents &&
                  !invoices.some((inv) => inv.jobId === j.id && inv.status !== "FAILED") ? (
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
                </>
              }
            />
          ))
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
                    {a.pdfKey ? (
                      <DocButton docKey={a.pdfKey} />
                    ) : a.status !== "SIGNED" ? (
                      <Button
                        small
                        variant="subtle"
                        disabled={!customer.email}
                        loading={busyAction === `send-${a.id}`}
                        onClick={() =>
                          void run(`send-${a.id}`, async () =>
                            unwrap(
                              await api().mutations.sendAgreement({
                                agreementId: a.id,
                              })
                            )
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
            invoices.slice(0, 10).map((inv) => (
              <ListRow
                key={inv.id}
                title={money(inv.amountCents)}
                subtitle={`${inv.description} · ${fmtDate(inv.issuedAt, true)}`}
                meta={<StatusBadge status={inv.status} />}
              />
            ))
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
            setSheet(null);
            await load();
          }}
        />
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
    </Page>
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
  const [planName, setPlanName] = useState("Residential Protection Plan");
  const [price, setPrice] = useState("99");
  const [freq, setFreq] = useState<"MONTHLY" | "BIMONTHLY" | "QUARTERLY">("MONTHLY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="form-grid">
      <Field label="Plan name">
        <input value={planName} onChange={(e) => setPlanName(e.target.value)} />
      </Field>
      <Field label="Monthly price ($)">
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <Field label="Service visit frequency">
        <SegControl
          options={[
            { value: "MONTHLY" as const, label: "Monthly" },
            { value: "BIMONTHLY" as const, label: "Bi-monthly" },
            { value: "QUARTERLY" as const, label: "Quarterly" },
          ]}
          value={freq}
          onChange={setFreq}
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          const cents = Math.round(parseFloat(price) * 100);
          if (!planName.trim() || !Number.isFinite(cents) || cents <= 0) {
            setError("Enter a plan name and a valid price");
            return;
          }
          setBusy(true);
          onSubmit({ planName: planName.trim(), priceCents: cents, serviceFrequency: freq }).catch(
            (err) => {
              setError(err.message ?? "Could not create plan");
              setBusy(false);
            }
          );
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
      <div className="form-row-2">
        <Field label="Date" hint="Leave empty to schedule later">
          <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} />
        </Field>
        <Field label="Time window">
          <input placeholder="8–10 AM" value={timeWindow} onChange={(e) => setTimeWindow(e.target.value)} />
        </Field>
      </div>
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
  const [bodyText, setBodyText] = useState(AGREEMENT_TEMPLATE(customer.displayName));
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
