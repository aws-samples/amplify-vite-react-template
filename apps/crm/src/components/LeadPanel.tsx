import { useCallback, useEffect, useState } from "react";
import {
  assignLeadOwner,
  clientActionId,
  listLeadActivity,
  logLeadTouch,
  opResult,
  setLeadDisposition,
  LEAD_LOST_REASONS,
  LEAD_OUTCOME_CODES_BY_CHANNEL,
  LEAD_TOUCH_CHANNELS,
  LEAD_TOUCH_OUTCOMES,
  type Customer,
  type LeadActivity,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDateTime } from "../lib/format";
import {
  deriveLeadStage,
  LEAD_STAGE_LABEL,
  LEAD_STAGE_TONE,
  leadNextActionAt,
} from "../lib/leadStage";
import { Badge, Button, Card, ErrorNote, Field } from "../ui/kit";

/**
 * GL-02 — the office's lead workspace. The stage is derived (never set by hand);
 * the only deliberate actions are logging a real touch, marking the lead lost
 * (with a reason), and do-not-contact. Any real touch clears the follow-up task.
 */
export default function LeadPanel({
  customer,
  onChanged,
}: {
  customer: Customer;
  onChanged: () => void | Promise<void>;
}) {
  const roles = useRoles();
  const retainedChannels = customer.contactConsentChannels ?? [];
  const initialChannel = retainedChannels.includes("CALL")
    ? "CALL"
    : retainedChannels.includes("EMAIL")
      ? "EMAIL"
      : "NOTE";
  const [activity, setActivity] = useState<LeadActivity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState(initialChannel);
  const [outcome, setOutcome] = useState(
    LEAD_OUTCOME_CODES_BY_CHANNEL[initialChannel]?.[0] ?? "NOTE"
  );
  const [touchNote, setTouchNote] = useState("");
  const [lostReason, setLostReason] = useState("");
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [activityQuery, setActivityQuery] = useState("");
  const [activityPage, setActivityPage] = useState(0);
  const [clearReason, setClearReason] = useState("CUSTOMER_RECONSENTED");
  const [clearEvidence, setClearEvidence] = useState("");

  const availableOutcomes = LEAD_TOUCH_OUTCOMES.filter((item) =>
    LEAD_OUTCOME_CODES_BY_CHANNEL[channel]?.includes(item.code)
  );

  const stage = deriveLeadStage(customer);
  const mine = customer.leadOwnerSub === roles.sub;

  const loadActivity = useCallback(async () => {
    try {
      setTimelineError(null);
      const res = await listLeadActivity(customer.id);
      setActivity(
        (res.data ?? []).sort((a, b) =>
          (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "")
        )
      );
    } catch (err) {
      setActivity(null);
      setTimelineError(err instanceof Error ? err.message : "Lead timeline could not be read");
    }
  }, [customer.id]);

  useEffect(() => {
    void loadActivity();
  }, [loadActivity]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await onChanged();
      await loadActivity();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action did not complete");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Lead pipeline"
      actions={<Badge tone={LEAD_STAGE_TONE[stage]}>{LEAD_STAGE_LABEL[stage]}</Badge>}
    >
      <ErrorNote error={error} />
      <p className="small" style={{ marginTop: 0 }}>
        Owner:{" "}
        <strong>{mine ? "you" : customer.leadOwnerEmail || "unassigned"}</strong>
        {!mine ? (
          <Button
            small
            variant="ghost"
            loading={busy === "assign"}
            onClick={() =>
              void act("assign", async () => {
                const r = opResult(
                  await assignLeadOwner({
                    customerId: customer.id,
                    idempotencyKey: clientActionId("assign"),
                  })
                );
                if (!r) throw new Error("Could not assign");
              })
            }
          >
            Assign to me
          </Button>
        ) : null}
      </p>
      <p className="small muted">
        Current action: <strong>{customer.nextAction || "Work now — missing durable next action"}</strong>
        {" · "}Due: <strong>{leadNextActionAt(customer) ? fmtDateTime(leadNextActionAt(customer)!.toISOString()) : "closed"}</strong>
        {" · "}Age: <strong>{Math.max(0, Math.floor((Date.now() - new Date(customer.createdAt ?? Date.now()).getTime()) / 3_600_000))}h</strong>
      </p>

      {customer.doNotContact ? (
        <p className="warn-note" style={{ marginTop: 8 }}>
          ⚑ Do not contact — set by {customer.doNotContactBy || "staff"}. Non-essential
          outreach is suppressed.
          {roles.owner ? <div className="form-grid" style={{ marginTop: 8 }}>
            <Field label="Controlled release reason">
              <select value={clearReason} onChange={(e) => setClearReason(e.target.value)}>
                <option value="CUSTOMER_RECONSENTED">Customer re-consented</option>
                <option value="ENTERED_IN_ERROR">Entered in error</option>
              </select>
            </Field>
            <Field label="Evidence (required)">
              <textarea value={clearEvidence} onChange={(e) => setClearEvidence(e.target.value)} />
            </Field>
          <Button
            small
            variant="ghost"
            disabled={!clearEvidence.trim()}
            loading={busy === "clear"}
            onClick={() =>
              void act("clear", async () => {
                const r = opResult(
                  await setLeadDisposition({
                    customerId: customer.id,
                    disposition: "CLEAR",
                    reasonCode: clearReason,
                    note: clearEvidence.trim(),
                    idempotencyKey: clientActionId("clear-dnc"),
                  })
                );
                if (!r) throw new Error("Could not reopen");
              })
            }
          >
            Reopen
          </Button>
          </div> : <span className="nested-line">Only an owner can clear suppression with a controlled reason and evidence.</span>}
        </p>
      ) : customer.lostReason ? (
        <p className="muted small" style={{ marginTop: 8 }}>
          Marked lost ({customer.lostReason}).{" "}
          <Button
            small
            variant="ghost"
            loading={busy === "clear"}
            onClick={() =>
              void act("clear", async () => {
                const r = opResult(
                  await setLeadDisposition({
                    customerId: customer.id,
                    disposition: "CLEAR",
                    idempotencyKey: clientActionId("reopen-lost"),
                  })
                );
                if (!r) throw new Error("Could not reopen");
              })
            }
          >
            Reopen
          </Button>
        </p>
      ) : (
        <>
          <div className="form-grid" style={{ marginTop: 12 }}>
            <p className="small" style={{ margin: 0, fontWeight: 600 }}>Log a touch</p>
            <Field label="Channel">
              <select
                value={channel}
                onChange={(e) => {
                  const nextChannel = e.target.value;
                  setChannel(nextChannel);
                  setOutcome(LEAD_OUTCOME_CODES_BY_CHANNEL[nextChannel]?.[0] ?? "NOTE");
                }}
              >
                {LEAD_TOUCH_CHANNELS.map((c) => (
                  <option
                    key={c.code}
                    value={c.code}
                    disabled={
                      c.code !== "NOTE" &&
                      !retainedChannels.includes(c.code)
                    }
                  >
                    {c.label}
                    {c.code !== "NOTE" &&
                    !retainedChannels.includes(c.code)
                      ? " — no retained permission"
                      : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What happened?">
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                {availableOutcomes.map((o) => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Note (optional)">
              <textarea
                rows={2}
                value={touchNote}
                onChange={(e) => setTouchNote(e.target.value)}
                placeholder="Left a voicemail about quarterly plan…"
              />
            </Field>
            <Button
              block
              loading={busy === "touch"}
              onClick={() =>
                void act("touch", async () => {
                  const r = opResult(
                    await logLeadTouch({
                      customerId: customer.id,
                      channel,
                      outcome,
                      note: touchNote.trim() || undefined,
                      idempotencyKey: clientActionId("touch"),
                    })
                  );
                  if (!r) throw new Error("Could not log the touch");
                  setTouchNote("");
                })
              }
            >
              Log touch
            </Button>
          </div>

          <div className="form-grid" style={{ marginTop: 16 }}>
            <Field label="Mark lost (with a reason)">
              <select value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                <option value="">Choose a reason…</option>
                {LEAD_LOST_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>{r.label}</option>
                ))}
              </select>
            </Field>
            <div className="inline-actions">
              <Button
                small
                variant="subtle"
                disabled={!lostReason}
                loading={busy === "lost"}
                onClick={() =>
                  void act("lost", async () => {
                    const r = opResult(
                      await setLeadDisposition({
                        customerId: customer.id,
                        disposition: "LOST",
                        reasonCode: lostReason,
                        idempotencyKey: clientActionId("lost"),
                      })
                    );
                    if (!r) throw new Error("Could not mark lost");
                  })
                }
              >
                Mark lost
              </Button>
              <Button
                small
                variant="danger"
                loading={busy === "dnc"}
                onClick={() =>
                  void act("dnc", async () => {
                    const r = opResult(
                      await setLeadDisposition({
                        customerId: customer.id,
                        disposition: "DNC",
                        idempotencyKey: clientActionId("dnc"),
                      })
                    );
                    if (!r) throw new Error("Could not set do-not-contact");
                  })
                }
              >
                Do not contact
              </Button>
            </div>
          </div>
        </>
      )}

      <details style={{ marginTop: 14 }}>
        <summary className="small">
          Activity ({activity?.length ?? 0})
        </summary>
        <ErrorNote error={timelineError} />
        {activity ? <div className="inline-actions" style={{ marginTop: 8 }}>
          <input
            placeholder="Search complete timeline…"
            value={activityQuery}
            onChange={(e) => { setActivityQuery(e.target.value); setActivityPage(0); }}
          />
          <Button small variant="subtle" onClick={() => {
            const rows = activity.map((a) => [a.occurredAt, a.channel, a.outcome, a.actorEmail, a.note]);
            const csv = [["occurredAt", "channel", "outcome", "actor", "note"], ...rows]
              .map((row) => row.map((cell) => `"${String(cell ?? "").replace(/"/g, '""')}"`).join(","))
              .join("\n");
            const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `lead-${customer.id}-timeline.csv`;
            link.click();
            URL.revokeObjectURL(url);
          }}>Export complete CSV</Button>
        </div> : null}
        {(activity ?? [])
          .filter((a) => !activityQuery.trim() || JSON.stringify(a).toLowerCase().includes(activityQuery.trim().toLowerCase()))
          .slice(activityPage * 50, activityPage * 50 + 50)
          .map((a) => (
          <p className="muted small" key={a.id} style={{ marginTop: 6 }}>
            {fmtDateTime(a.occurredAt)} · {a.channel?.toLowerCase()} ·{" "}
            {a.outcome?.toLowerCase()} · {a.actorEmail}
            {a.note ? <span className="nested-line">{a.note}</span> : null}
          </p>
        ))}
        {activity && activity.length > 50 ? <div className="inline-actions">
          <Button small variant="ghost" disabled={activityPage === 0} onClick={() => setActivityPage((p) => p - 1)}>Previous</Button>
          <span className="small muted">Page {activityPage + 1}</span>
          <Button small variant="ghost" disabled={(activityPage + 1) * 50 >= activity.length} onClick={() => setActivityPage((p) => p + 1)}>Next</Button>
        </div> : null}
      </details>
    </Card>
  );
}
