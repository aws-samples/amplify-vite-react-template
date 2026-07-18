import { useCallback, useEffect, useState } from "react";
import {
  assignLeadOwner,
  listLeadActivity,
  logLeadTouch,
  opResult,
  setLeadDisposition,
  LEAD_LOST_REASONS,
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
  const [activity, setActivity] = useState<LeadActivity[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState("CALL");
  const [outcome, setOutcome] = useState("REACHED");
  const [touchNote, setTouchNote] = useState("");
  const [lostReason, setLostReason] = useState("");

  const stage = deriveLeadStage(customer);
  const mine = customer.leadOwnerSub === roles.sub;

  const loadActivity = useCallback(async () => {
    try {
      const res = await listLeadActivity(customer.id);
      setActivity(
        (res.data ?? []).sort((a, b) =>
          (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "")
        )
      );
    } catch {
      setActivity([]);
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
                const r = opResult(await assignLeadOwner({ customerId: customer.id }));
                if (!r) throw new Error("Could not assign");
              })
            }
          >
            Assign to me
          </Button>
        ) : null}
      </p>

      {customer.doNotContact ? (
        <p className="warn-note" style={{ marginTop: 8 }}>
          ⚑ Do not contact — set by {customer.doNotContactBy || "staff"}. Non-essential
          outreach is suppressed.
          <Button
            small
            variant="ghost"
            loading={busy === "clear"}
            onClick={() =>
              void act("clear", async () => {
                const r = opResult(
                  await setLeadDisposition({ customerId: customer.id, disposition: "CLEAR" })
                );
                if (!r) throw new Error("Could not reopen");
              })
            }
          >
            Reopen
          </Button>
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
                  await setLeadDisposition({ customerId: customer.id, disposition: "CLEAR" })
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
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {LEAD_TOUCH_CHANNELS.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </Field>
            <Field label="What happened?">
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                {LEAD_TOUCH_OUTCOMES.map((o) => (
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
        {(activity ?? []).map((a) => (
          <p className="muted small" key={a.id} style={{ marginTop: 6 }}>
            {fmtDateTime(a.occurredAt)} · {a.channel?.toLowerCase()} ·{" "}
            {a.outcome?.toLowerCase()} · {a.actorEmail}
            {a.note ? <span className="nested-line">{a.note}</span> : null}
          </p>
        ))}
      </details>
    </Card>
  );
}
