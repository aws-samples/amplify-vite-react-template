import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  createLead,
  listAll,
  opResult,
  type Customer,
} from "../lib/api";
import { fmtDateTime } from "../lib/format";
import { useRoles } from "../lib/auth";
import {
  deriveLeadStage,
  isLeadOverdue,
  leadNextActionAt,
  LEAD_STAGE_LABEL,
  OPEN_LEAD_STAGES,
  type LeadStage,
} from "../lib/leadStage";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  ListRow,
  Page,
  Sheet,
  Spinner,
} from "../ui/kit";
import CustomerForm, { customerToForm } from "../components/CustomerForm";
import PriceLeadSheet from "../components/PriceLeadSheet";

type DupeCandidate = {
  id: string;
  displayName: string;
  status: string;
  email: string | null;
  phone: string | null;
  serviceCity: string | null;
  matchedOn: string;
};

export default function Leads() {
  const navigate = useNavigate();
  const roles = useRoles();
  const [leads, setLeads] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pricing, setPricing] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  // The duplicate decision: candidates + the exact form values to re-submit.
  const [dupe, setDupe] = useState<{
    candidates: DupeCandidate[];
    values: Parameters<typeof createLead>[0];
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setLeads(
        await listAll((t) =>
          api().models.Customer.listCustomerByStatusAndDisplayName(
            { status: "LEAD" },
            { limit: 500, nextToken: t }
          )
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load leads");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(
    () =>
      (leads ?? []).filter((l) =>
        mineOnly ? l.leadOwnerSub === roles.sub : true
      ),
    [leads, mineOnly, roles.sub]
  );

  // Group open leads by their derived stage; terminal ones collapse to the end.
  const byStage = useMemo(() => {
    const groups: Record<string, Customer[]> = {};
    for (const l of shown) {
      const stage = deriveLeadStage(l);
      (groups[stage] ??= []).push(l);
    }
    for (const rows of Object.values(groups)) {
      rows.sort(
        (a, b) =>
          (leadNextActionAt(a)?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (leadNextActionAt(b)?.getTime() ?? Number.MAX_SAFE_INTEGER)
      );
    }
    return groups;
  }, [shown]);

  const submitLead = async (
    values: Parameters<typeof createLead>[0]
  ): Promise<void> => {
    const res = opResult<
      | { decision: "DUPLICATE"; candidates: DupeCandidate[] }
      | { decision: "CREATED"; id: string }
    >(await createLead(values));
    if (!res) throw new Error("The lead could not be created");
    if (res.decision === "DUPLICATE") {
      setAdding(false);
      setDupe({ candidates: res.candidates, values });
      return;
    }
    setAdding(false);
    await load();
    navigate(`/customers/${res.id}`);
  };

  const stageBlock = (stage: LeadStage) => {
    const rows = byStage[stage] ?? [];
    if (rows.length === 0) return null;
    return (
      <Card key={stage} title={`${LEAD_STAGE_LABEL[stage]} (${rows.length})`}>
        {rows.map((lead) => {
          const overdue = isLeadOverdue(lead);
          const due = leadNextActionAt(lead);
          const ageHours = Math.max(
            0,
            Math.floor((Date.now() - new Date(lead.createdAt ?? Date.now()).getTime()) / 3_600_000)
          );
          return (
            <ListRow
              key={lead.id}
              title={lead.displayName}
              subtitle={[
                `Action: ${lead.nextAction || "Work now — missing durable next action"}`,
                `Due: ${due ? fmtDateTime(due.toISOString()) : "closed"}`,
                `Owner: ${lead.leadOwnerEmail || "Sales team"}`,
                `${ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d`} old`,
                lead.serviceCity,
                lead.leadSource,
              ]
                .filter(Boolean)
                .join(" · ")}
              meta={
                <span className="inline-actions">
                  {overdue ? <Badge tone="danger">overdue</Badge> : null}
                  {lead.leadOwnerSub === roles.sub ? (
                    <Badge tone="info">you</Badge>
                  ) : null}
                  <span className="muted small">due {due ? fmtDateTime(due.toISOString()) : "—"}</span>
                </span>
              }
              onClick={() => navigate(`/customers/${lead.id}`)}
            />
          );
        })}
      </Card>
    );
  };

  return (
    <Page
      title="Leads"
      actions={
        <>
          <Button small variant="subtle" onClick={() => setPricing(true)}>
            ⚡ Price a lead
          </Button>
          <Button small onClick={() => setAdding(true)}>
            + Lead
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      <label className="inline-check small" style={{ margin: "8px 0 12px" }}>
        <input
          type="checkbox"
          checked={mineOnly}
          onChange={(e) => setMineOnly(e.target.checked)}
        />{" "}
        My leads only
      </label>

      {!leads ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <EmptyState
          title="No open leads"
          body="New website inquiries and manually added leads show up here, grouped by where they are in the pipeline."
          action={<Button onClick={() => setAdding(true)}>Add a lead</Button>}
        />
      ) : (
        <>
          {OPEN_LEAD_STAGES.map((s) => stageBlock(s))}
          {stageBlock("LOST")}
          {stageBlock("DNC")}
        </>
      )}

      <Sheet open={pricing} onClose={() => setPricing(false)} title="Price a lead">
        <PriceLeadSheet />
      </Sheet>

      <Sheet open={adding} onClose={() => setAdding(false)} title="New lead">
        <CustomerForm
          initial={customerToForm()}
          submitLabel="Add lead"
          showLeadSource
          showLeadConsent
          onSubmit={(v) =>
            submitLead({
              displayName: v.displayName.trim(),
              contactName: v.contactName.trim() || undefined,
              email: v.email.trim() || undefined,
              phone: v.phone.trim() || undefined,
              serviceStreet: v.serviceStreet.trim() || undefined,
              serviceCity: v.serviceCity.trim() || undefined,
              serviceState: v.serviceState.trim() || undefined,
              serviceZip: v.serviceZip.trim() || undefined,
              leadSource: v.leadSource.trim() || undefined,
              notes: v.notes.trim() || undefined,
              idempotencyKey: crypto.randomUUID(),
              contactConsentChannels: [
                ...(v.emailPermission ? ["EMAIL"] : []),
                ...(v.callPermission ? ["CALL"] : []),
              ],
              contactConsentSource:
                v.emailPermission || v.callPermission ? "office-recorded" : undefined,
              contactConsentText:
                v.emailPermission || v.callPermission
                  ? v.consentEvidence.trim()
                  : undefined,
              contactConsentPolicyVersion: v.emailPermission || v.callPermission
                ? "office-lead-consent-2026-07-19"
                : undefined,
            })
          }
        />
      </Sheet>

      {/* GL-02 R3: a possible duplicate is never silently merged — the office
          decides Use-existing / Create-separate. */}
      <Sheet
        open={Boolean(dupe)}
        onClose={() => setDupe(null)}
        title="Possible duplicate"
      >
        {dupe ? (
          <div className="form-grid">
            <p className="muted small">
              A lead matching <strong>{dupe.values.displayName}</strong> may
              already exist. Open the existing record, or create a separate one
              if they are genuinely different people.
            </p>
            {dupe.candidates.map((c) => (
              <ListRow
                key={c.id}
                title={c.displayName}
                subtitle={[c.email, c.phone, c.serviceCity]
                  .filter(Boolean)
                  .join(" · ")}
                meta={<Badge tone="info">matched {c.matchedOn}</Badge>}
                onClick={() => {
                  setDupe(null);
                  navigate(`/customers/${c.id}`);
                }}
              />
            ))}
            <Button
              block
              variant="danger"
              onClick={async () => {
                try {
                  await submitLead({ ...dupe.values, force: true });
                  setDupe(null);
                } catch (err) {
                  setError(
                    err instanceof Error ? err.message : "Could not create the lead"
                  );
                }
              }}
            >
              These are different people — create a separate lead
            </Button>
            <Button block variant="subtle" onClick={() => setDupe(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
      </Sheet>
    </Page>
  );
}
