import { useCallback, useEffect, useState } from "react";
import {
  api,
  changeStaffRoles,
  listAll,
  listStaffAccessEvents,
  offboardStaff,
  opResult,
  staffRoster,
  unwrap,
  STAFF_OFFBOARD_REASONS,
  STAFF_ROLE_CHANGE_REASONS,
  type StaffAccessEvent,
  type StaffRosterRow,
  type Technician,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDate, fmtDateTime } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
  Spinner,
} from "../ui/kit";

/**
 * GL-14 — the owner-only staff roster. Every staff login with person, email,
 * role(s), status, pending invite, and (for technicians) the linked profile and
 * its licence, sourced from Cognito + Technician records by crm-admin. From
 * here an owner invites, changes a role, or offboards — the complete workflow
 * to review, change, and disable every staff role in one place. Unlinked or
 * unlicensed technicians and disabled logins are flagged, not hidden.
 *
 * Every rule (atomic technician linking, last-owner protection, licence checks)
 * is enforced server-side; this page surfaces the state and the actions and
 * shows the server's fixable error verbatim when it refuses.
 */

/**
 * Two staff roles, consolidated from the old office/finance/manager lattice:
 *   Owner      — everything (office work, money, invites, approvals)
 *   Technician — field only (routes, jobs, service reports)
 *   Owner + technician — a working owner who also runs routes (both groups)
 * Each choice maps to the group list it grants. Shared by the invite and
 * change-role forms so both speak the same language.
 */
const ROLE_CHOICES = {
  OWNER: {
    label: "Owner — everything, incl. billing, approvals and invites",
    groups: ["OWNER"],
  },
  TECH: { label: "Technician — field work only", groups: ["TECH"] },
  OWNER_TECH: {
    label: "Owner + technician — full access and runs routes",
    groups: ["OWNER", "TECH"],
  },
} satisfies Record<string, { label: string; groups: string[] }>;

type RoleChoice = keyof typeof ROLE_CHOICES;

/** Best-fit choice key for an existing role set, so the change-role form opens
 *  on what the person already is. Legacy OFFICE/FINANCE members read as owners. */
function choiceForRoles(roles: string[]): RoleChoice {
  const set = new Set(roles);
  const isOwner = set.has("OWNER") || set.has("OFFICE") || set.has("FINANCE");
  if (isOwner && set.has("TECH")) return "OWNER_TECH";
  if (set.has("TECH")) return "TECH";
  return "OWNER";
}

/** Human-friendly label for a controlled reason code (DEPARTURE_VOLUNTARY →
 *  "Departure voluntary"). */
function reasonLabel(code: string): string {
  const s = code.replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A per-action idempotency/version key so a double-submit or retry cannot apply
 *  a second change (the server dedupes on it). */
function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `k-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export default function Staff() {
  const roles = useRoles();
  const [rows, setRows] = useState<StaffRosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<StaffRosterRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = opResult<{ staff: StaffRosterRow[] }>(await staffRoster());
      setRows(res?.staff ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the staff roster");
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!roles.owner) {
    return (
      <Page title="Staff" back="/more">
        <EmptyState
          title="Owners only"
          body="The staff roster and role changes are owner-only. Ask an owner to manage staff access."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Staff"
      back="/more"
      actions={
        <span style={{ display: "inline-flex", gap: 6 }}>
          <Button small variant="ghost" onClick={() => setHistoryOpen(true)}>
            Access history
          </Button>
          <Button small variant="ghost" onClick={() => setInviting(true)}>
            + Invite
          </Button>
        </span>
      }
    >
      <ErrorNote error={error} />
      {rows === null ? (
        <Spinner label="Loading the staff roster…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No staff logins yet"
          body="Invite your first staff member — technicians are linked to a licensed technician record as they're invited."
          action={<Button onClick={() => setInviting(true)}>Invite a staff member</Button>}
        />
      ) : (
        <Card>
          {rows.map((row) => (
            <ListRow
              key={row.username}
              title={
                <span>
                  {row.name ?? row.email}{" "}
                  {!row.enabled ? <Badge tone="danger">disabled</Badge> : null}
                </span>
              }
              subtitle={
                <span>
                  {row.email}
                  {" · "}
                  {row.lastLoginAt
                    ? `last login ${fmtDate(row.lastLoginAt)}`
                    : "never signed in"}
                </span>
              }
              meta={<RosterBadges row={row} />}
              onClick={() => setSelected(row)}
            />
          ))}
        </Card>
      )}

      <Sheet open={inviting} onClose={() => setInviting(false)} title="Invite a staff member">
        {inviting ? (
          <InviteForm
            onDone={async () => {
              setInviting(false);
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.name ?? selected?.email ?? "Staff member"}
      >
        {selected ? (
          <StaffActions
            row={selected}
            onDone={async () => {
              setSelected(null);
              await load();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Staff access history"
      >
        {historyOpen ? <AccessHistory /> : null}
      </Sheet>
    </Page>
  );
}

/**
 * GL-14 (X1) — the owner-only, searchable, exportable staff-access history.
 *
 * The immutable StaffAccessEvent ledger is read straight from the model (which
 * grants OWNER read), so leadership can prove who changed access, why, and what
 * happened — and export it — without engineering. Read-only; no row here can be
 * edited or deleted.
 */
function AccessHistory() {
  const [events, setEvents] = useState<StaffAccessEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    // GL-14 R7: page the ENTIRE immutable ledger, not just the first 500 rows,
    // so search and export cover the complete access history.
    listAll((t) => listStaffAccessEvents({ limit: 1000, nextToken: t }))
      .then((all) => {
        const rows = [...all].sort((a, b) =>
          String(b.occurredAt ?? "").localeCompare(String(a.occurredAt ?? ""))
        );
        setEvents(rows);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load the history")
      );
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = (events ?? []).filter((e) =>
    !q
      ? true
      : [
          e.subjectEmail,
          e.actorEmail,
          e.action,
          e.reasonCode,
          e.reason,
          e.effects,
          e.outcome,
        ]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
  );

  const exportCsv = () => {
    const cols: (keyof StaffAccessEvent)[] = [
      "occurredAt",
      "action",
      "subjectEmail",
      "actorEmail",
      "reasonCode",
      "reason",
      "priorRoles",
      "requestedRoles",
      "newRoles",
      "outcome",
      "effects",
    ];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      cols.join(","),
      ...filtered.map((e) => cols.map((c) => esc(e[c])).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `staff-access-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="form-grid">
      <ErrorNote error={error} />
      <Field label="Search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="person, actor, reason, action…"
        />
      </Field>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="muted small">
          {events === null ? "Loading…" : `${filtered.length} record${filtered.length === 1 ? "" : "s"}`}
        </span>
        <Button
          small
          variant="ghost"
          disabled={!filtered.length}
          onClick={exportCsv}
        >
          Export CSV
        </Button>
      </div>
      {events === null ? (
        <Spinner label="Loading access history…" />
      ) : filtered.length === 0 ? (
        <EmptyState title="No matching records" body="Staff access changes appear here as they happen." />
      ) : (
        <Card>
          {filtered.map((e) => (
            <ListRow
              key={e.id}
              title={
                <span>
                  {e.action === "OFFBOARD" ? "Offboarded" : "Role change"}{" "}
                  <strong>{e.subjectEmail}</strong>{" "}
                  {e.outcome === "PARTIAL" ? <Badge tone="warn">partial</Badge> : null}
                </span>
              }
              subtitle={
                <span>
                  {e.reasonCode ? reasonLabel(e.reasonCode) : "—"}
                  {e.reason ? ` · ${e.reason}` : ""}
                  {" · by "}
                  {e.actorEmail}
                </span>
              }
              meta={
                <span className="muted small">
                  {e.occurredAt ? fmtDateTime(e.occurredAt) : ""}
                </span>
              }
            />
          ))}
        </Card>
      )}
    </div>
  );
}

function RosterBadges({ row }: { row: StaffRosterRow }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
      {row.roles.map((r) => (
        <Badge key={r} tone={r === "OWNER" ? "ok" : r === "TECH" ? "info" : "muted"}>
          {r.toLowerCase()}
        </Badge>
      ))}
      {row.pendingInvite ? <Badge tone="warn">invite pending</Badge> : null}
      {row.unlinkedTech ? <Badge tone="danger">unlinked tech</Badge> : null}
      {row.licenseValid === false ? <Badge tone="danger">licence lapsed</Badge> : null}
    </span>
  );
}

/** The persisted outcome the server hands back for a staff-access command —
 *  the screen shows THIS, never an assumed success (GL-14). */
type StaffOpOutcome = {
  outcome?: string;
  effects?: string | null;
  nextStep?: string | null;
  securityCaseOpened?: boolean;
  caseWriteFailed?: boolean;
  inProgress?: boolean;
  deduped?: boolean;
  error?: string | null;
  converged?: boolean;
  effectiveRoles?: string[];
};

function StaffActions({
  row,
  onDone,
}: {
  row: StaffRosterRow;
  onDone: () => Promise<void>;
}) {
  const me = useRoles();
  const [choice, setChoice] = useState<RoleChoice>(choiceForRoles(row.roles));
  const [roleReason, setRoleReason] = useState<string>(STAFF_ROLE_CHANGE_REASONS[0]);
  const [offboardReason, setOffboardReason] = useState<string>(
    STAFF_OFFBOARD_REASONS[0]
  );
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "role" | "offboard">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOffboard, setConfirmOffboard] = useState(false);
  // One idempotency key per LOGICAL request, held stable across retries so the
  // server can dedupe/resume the same durable command — a retry after a
  // timeout must not mint a new key and apply a second change (GL-14). A new
  // key is minted only when the requested change itself changes or after a
  // terminal outcome is acknowledged.
  const [roleKey, setRoleKey] = useState<string>(newIdempotencyKey);
  const [offboardKey, setOffboardKey] = useState<string>(newIdempotencyKey);
  const [opOutcome, setOpOutcome] = useState<
    (StaffOpOutcome & { kind: "role" | "offboard" }) | null
  >(null);
  const isSelf = me.email?.toLowerCase() === row.email.toLowerCase();

  const editRole = (next: RoleChoice) => {
    setChoice(next);
    // A different requested role set is a NEW logical request.
    setRoleKey(newIdempotencyKey());
    setOpOutcome(null);
  };

  const saveRole = async () => {
    if (roleReason === "OTHER" && !note.trim()) {
      setError("Choosing 'Other' needs a short note saying why.");
      return;
    }
    setBusy("role");
    setError(null);
    try {
      const res = await changeStaffRoles({
        email: row.email,
        roles: [...ROLE_CHOICES[choice].groups],
        reasonCode: roleReason,
        reason: note.trim() || undefined,
        idempotencyKey: roleKey,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      const data = opResult<StaffOpOutcome>(res);
      if (data?.inProgress) {
        setOpOutcome({ ...data, kind: "role" });
        setBusy(null);
        return;
      }
      if (data && data.outcome !== "COMPLETE") {
        // The persisted PARTIAL outcome — shown as recorded, with its one next
        // step. The same key resumes it; nothing is invented client-side.
        setOpOutcome({ ...data, kind: "role" });
        setBusy(null);
        return;
      }
      setRoleKey(newIdempotencyKey());
      setOpOutcome(null);
      await onDone();
    } catch (err) {
      // A refusal (validation, last-owner, in-flight owner change): nothing
      // changed. A fresh key lets the corrected request start clean.
      setRoleKey(newIdempotencyKey());
      setError(err instanceof Error ? err.message : "Could not change the role");
      setBusy(null);
    }
  };

  const doOffboard = async () => {
    if (offboardReason === "OTHER" && !note.trim()) {
      setError("Choosing 'Other' needs a short note saying why.");
      return;
    }
    setBusy("offboard");
    setError(null);
    try {
      const res = await offboardStaff({
        email: row.email,
        reasonCode: offboardReason,
        reason: note.trim() || undefined,
        idempotencyKey: offboardKey,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      const data = opResult<StaffOpOutcome>(res);
      if (data?.inProgress) {
        setOpOutcome({ ...data, kind: "offboard" });
        setBusy(null);
        return;
      }
      if (data && data.outcome !== "COMPLETE") {
        setOpOutcome({ ...data, kind: "offboard" });
        setBusy(null);
        return;
      }
      setOffboardKey(newIdempotencyKey());
      setOpOutcome(null);
      await onDone();
    } catch (err) {
      setOffboardKey(newIdempotencyKey());
      setError(err instanceof Error ? err.message : "Could not offboard this person");
      setBusy(null);
    }
  };

  return (
    <div className="form-grid">
      <Card>
        <ListRow title="Email" meta={row.email} />
        <ListRow
          title="Status"
          meta={
            row.enabled ? (
              <Badge tone="ok">active login</Badge>
            ) : (
              <Badge tone="danger">disabled</Badge>
            )
          }
        />
        <ListRow
          title="Last login"
          meta={
            row.lastLoginAt ? (
              fmtDateTime(row.lastLoginAt)
            ) : (
              <Badge tone="muted">never signed in</Badge>
            )
          }
        />
        {row.pendingInvite ? (
          <ListRow title="Invite" meta={<Badge tone="warn">not yet accepted</Badge>} />
        ) : null}
        {row.roles.includes("TECH") ? (
          <ListRow
            title="Technician record"
            meta={
              row.unlinkedTech ? (
                <Badge tone="danger">not linked</Badge>
              ) : row.licenseValid === false ? (
                <Badge tone="danger">
                  licence {row.licenseExpiresOn ? `exp ${fmtDate(row.licenseExpiresOn)}` : "invalid"}
                </Badge>
              ) : (
                <Badge tone="ok">
                  licensed{row.licenseExpiresOn ? ` · ${fmtDate(row.licenseExpiresOn)}` : ""}
                </Badge>
              )
            }
          />
        ) : null}
      </Card>

      <Field
        label="Change role"
        hint="Granting the technician role needs a linked, licensed technician record."
      >
        <select value={choice} onChange={(e) => editRole(e.target.value as RoleChoice)}>
          {Object.entries(ROLE_CHOICES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Reason for the role change"
        hint="A controlled reason is recorded in the staff-access ledger with your name and the time."
      >
        <select value={roleReason} onChange={(e) => setRoleReason(e.target.value)}>
          {STAFF_ROLE_CHANGE_REASONS.map((r) => (
            <option key={r} value={r}>
              {reasonLabel(r)}
            </option>
          ))}
        </select>
      </Field>
      {roleReason === "OTHER" || offboardReason === "OTHER" ? (
        <Field label="Note" hint="Required when the reason is 'Other'.">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Say why in a few words"
          />
        </Field>
      ) : null}
      <Button
        block
        loading={busy === "role"}
        disabled={busy !== null || choiceForRoles(row.roles) === choice}
        onClick={() => void saveRole()}
      >
        Save role
      </Button>

      <div style={{ borderTop: "1px solid var(--line, #eee)", marginTop: 8, paddingTop: 12 }}>
        {isSelf ? (
          <p className="muted small">
            You can't offboard your own login. Ask another owner if you're leaving.
          </p>
        ) : !confirmOffboard ? (
          <Button block variant="ghost" onClick={() => setConfirmOffboard(true)}>
            Offboard {row.name ?? row.email}
          </Button>
        ) : (
          <div className="form-grid">
            <p className="muted small">
              This disables their login and signs out every active session now,
              removes all roles, and returns any technician's future jobs to the
              scheduling pool. Their history and records are kept.
            </p>
            <Field label="Reason for offboarding">
              <select
                value={offboardReason}
                onChange={(e) => setOffboardReason(e.target.value)}
              >
                {STAFF_OFFBOARD_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ))}
              </select>
            </Field>
            {offboardReason === "OTHER" ? (
              <Field label="Note" hint="Required when the reason is 'Other'.">
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Say why in a few words"
                />
              </Field>
            ) : null}
            <Button block loading={busy === "offboard"} onClick={() => void doOffboard()}>
              Yes, offboard now
            </Button>
            <Button block variant="ghost" onClick={() => setConfirmOffboard(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

      {opOutcome ? (
        <Card>
          <p style={{ margin: 0 }}>
            {opOutcome.inProgress ? (
              <Badge tone="warn">already in progress</Badge>
            ) : (
              <Badge tone="warn">
                {opOutcome.deduped ? "recorded outcome" : "partial"}
              </Badge>
            )}
          </p>
          <p className="small" style={{ marginTop: 8 }}>
            {opOutcome.effects ??
              opOutcome.error ??
              "The change did not fully finish."}
          </p>
          {!opOutcome.inProgress && opOutcome.securityCaseOpened === false && (opOutcome.error || opOutcome.caseWriteFailed) ? (
            <p className="small" style={{ marginTop: 4 }}>
              A recovery case could <strong>not</strong> be written for this —
              resume it now; do not assume anyone else has been notified.
            </p>
          ) : null}
          {opOutcome.nextStep ? (
            <p className="small" style={{ marginTop: 4 }}>{opOutcome.nextStep}</p>
          ) : null}
          {!opOutcome.inProgress && opOutcome.outcome !== "COMPLETE" ? (
            <Button
              block
              loading={busy !== null}
              onClick={() =>
                void (opOutcome.kind === "role" ? saveRole() : doOffboard())
              }
            >
              Resume {opOutcome.kind === "role" ? "role change" : "offboarding"}
            </Button>
          ) : null}
        </Card>
      ) : null}
      <ErrorNote error={error} />
    </div>
  );
}

/**
 * Invite a new staff login. A technician invite must be linked to a technician
 * record with a current applicator licence — the server refuses otherwise, so
 * the form only offers technicians that are free to link, and requires a pick.
 */
function InviteForm({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<RoleChoice>("OWNER");
  const [techs, setTechs] = useState<Technician[]>([]);
  const [technicianId, setTechnicianId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const linksTechnician = ROLE_CHOICES[role].groups.includes("TECH");

  useEffect(() => {
    if (!linksTechnician) return;
    api()
      .models.Technician.list({ limit: 200 })
      .then((res) =>
        setTechs(unwrap(res).filter((t) => t.active && !t.userSub))
      )
      .catch(() => undefined);
  }, [linksTechnician]);

  if (done) {
    return (
      <div className="form-grid">
        <p>
          Invite sent — they'll get an email with a sign-in link that logs them
          straight in. No passwords to juggle.
        </p>
        <Button block onClick={() => void onDone()}>
          Done
        </Button>
      </div>
    );
  }

  const validEmail = /^\S+@\S+\.\S+$/.test(email.trim());
  const needsTech = linksTechnician && !technicianId;

  return (
    <div className="form-grid">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Role">
        <select value={role} onChange={(e) => setRole(e.target.value as RoleChoice)}>
          {Object.entries(ROLE_CHOICES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
      {linksTechnician ? (
        <Field
          label="Link to technician record"
          hint="Required — a technician login is bound to one licensed technician."
        >
          {techs.length > 0 ? (
            <select value={technicianId} onChange={(e) => setTechnicianId(e.target.value)}>
              <option value="">Pick a technician…</option>
              {techs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="muted small">
              No active, licensed, unlinked technician records are available. Add
              the technician (with a current applicator licence) in the technician
              list first, then invite their login here.
            </p>
          )}
        </Field>
      ) : null}
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        disabled={!name.trim() || !validEmail || needsTech}
        onClick={() => {
          setBusy(true);
          setError(null);
          api()
            .mutations.adminCreateUser({
              email: email.trim(),
              name: name.trim(),
              roles: [...ROLE_CHOICES[role].groups],
              technicianId: technicianId || undefined,
            })
            .then((res) => {
              if (res.errors?.length) throw new Error(res.errors[0].message);
              setDone(true);
            })
            .catch((err) => {
              setError(err.message ?? "Could not send the invite");
              setBusy(false);
            });
        }}
      >
        Send invite
      </Button>
    </div>
  );
}
