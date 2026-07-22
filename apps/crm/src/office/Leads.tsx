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
  isLeadOpen,
  isLeadOverdue,
  leadNextActionAt,
  LEAD_STAGE_LABEL,
  LEAD_STAGE_TONE,
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
  const [mineOnly, setMineOnly] = useState(false);
  // Narrow the inbox to one derived stage. The stage is computed from facts
  // (deriveLeadStage), never stored — so this filter can't go stale.
  const [stageFilter, setStageFilter] = useState<LeadStage | "ALL">("ALL");
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

  // The inbox is not a sales pipeline. It contains only inquiries that still
  // need a human outcome, ordered by business risk: overdue first, then due.
  const openRows = useMemo(() => {
    const rows = (leads ?? []).filter(
      (lead) =>
        isLeadOpen(lead) &&
        (!mineOnly || lead.leadOwnerSub === roles.sub)
    );
    return rows.sort((a, b) => {
      const overdueDelta = Number(isLeadOverdue(b)) - Number(isLeadOverdue(a));
      if (overdueDelta) return overdueDelta;
      return (
        (leadNextActionAt(a)?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (leadNextActionAt(b)?.getTime() ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }, [leads, mineOnly, roles.sub]);

  // How many open leads sit at each derived stage — the counts stay on the
  // full inbox so a filter never hides how much work exists.
  const stageCounts = useMemo(() => {
    const counts = new Map<LeadStage, number>();
    for (const lead of openRows) {
      const stage = deriveLeadStage(lead);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return counts;
  }, [openRows]);

  const shown = useMemo(
    () =>
      stageFilter === "ALL"
        ? openRows
        : openRows.filter((lead) => deriveLeadStage(lead) === stageFilter),
    [openRows, stageFilter]
  );

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

  // One chip per stage that actually has leads, plus All. Stage names match
  // the badge on each row, so the pipeline is countable at a glance without
  // anyone maintaining a status field.
  const stageChips = (
    <div
      className="inline-actions"
      style={{ flexWrap: "wrap", margin: "0 0 12px" }}
    >
      <Button
        small
        variant={stageFilter === "ALL" ? undefined : "subtle"}
        onClick={() => setStageFilter("ALL")}
      >
        All ({openRows.length})
      </Button>
      {OPEN_LEAD_STAGES.filter((s) => stageCounts.get(s)).map((s) => (
        <Button
          key={s}
          small
          variant={stageFilter === s ? undefined : "subtle"}
          onClick={() => setStageFilter((cur) => (cur === s ? "ALL" : s))}
        >
          {LEAD_STAGE_LABEL[s]} ({stageCounts.get(s)})
        </Button>
      ))}
    </div>
  );

  const inbox = (
    <Card title={`Needs action (${shown.length})`}>
      {shown.map((lead) => {
          const stage = deriveLeadStage(lead);
          const overdue = isLeadOverdue(lead);
          const due = leadNextActionAt(lead);
          const missingContact = !lead.email || !lead.phone;
          const missingAddress =
            !lead.serviceStreet ||
            !lead.serviceCity ||
            !lead.serviceState ||
            !lead.serviceZip;
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
                `Due: ${due ? fmtDateTime(due.toISOString()) : "now"}`,
                `Queue: ${lead.leadOwnerEmail || "Shared Sales"}`,
                `${ageHours < 24 ? `${ageHours}h` : `${Math.floor(ageHours / 24)}d`} old`,
                lead.serviceCity,
                lead.leadSource,
              ]
                .filter(Boolean)
                .join(" · ")}
              meta={
                <span className="inline-actions">
                  <Badge tone={LEAD_STAGE_TONE[stage]}>
                    {LEAD_STAGE_LABEL[stage]}
                  </Badge>
                  {overdue ? <Badge tone="danger">overdue</Badge> : null}
                  {missingContact || missingAddress ? (
                    <Badge tone="warn">details needed</Badge>
                  ) : null}
                  {lead.leadOwnerSub === roles.sub ? (
                    <Badge tone="info">you</Badge>
                  ) : null}
                </span>
              }
              onClick={() => navigate(`/customers/${lead.id}`)}
            />
          );
        })}
    </Card>
  );

  return (
    <Page
      title="Lead inbox"
      actions={
        <Button small onClick={() => setAdding(true)}>
          + Lead
        </Button>
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
      ) : openRows.length === 0 ? (
        <EmptyState
          title="No open leads"
          body="Every inquiry is handled. New website and staff-added inquiries will appear here automatically."
          action={<Button onClick={() => setAdding(true)}>Add a lead</Button>}
        />
      ) : (
        <>
          {stageChips}
          {inbox}
        </>
      )}

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
