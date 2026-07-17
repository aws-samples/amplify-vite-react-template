import { useCallback, useEffect, useState } from "react";
import {
  api,
  changeStaffRoles,
  offboardStaff,
  opResult,
  staffRoster,
  unwrap,
  type StaffRosterRow,
  type Technician,
} from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDate } from "../lib/format";
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
 * Roles are additive in Cognito, so each choice maps to the group list it
 * grants. OWNER is a superset and never needs pairing with OFFICE/FINANCE.
 * Shared by the invite and change-role forms so both speak the same language.
 */
const ROLE_CHOICES = {
  OFFICE: { label: "Office — leads, pricing, scheduling", groups: ["OFFICE"] },
  FINANCE: { label: "Finance — charges, refunds, invoices", groups: ["FINANCE"] },
  OFFICE_FINANCE: { label: "Office + finance", groups: ["OFFICE", "FINANCE"] },
  TECH: { label: "Technician", groups: ["TECH"] },
  OFFICE_TECH: { label: "Office + technician", groups: ["OFFICE", "TECH"] },
  OWNER: {
    label: "Owner — everything, incl. approvals and invites",
    groups: ["OWNER"],
  },
} satisfies Record<string, { label: string; groups: string[] }>;

type RoleChoice = keyof typeof ROLE_CHOICES;

/** Best-fit choice key for an existing role set, so the change-role form opens
 *  on what the person already is. */
function choiceForRoles(roles: string[]): RoleChoice {
  const set = new Set(roles);
  if (set.has("OWNER")) return "OWNER";
  if (set.has("OFFICE") && set.has("TECH")) return "OFFICE_TECH";
  if (set.has("OFFICE") && set.has("FINANCE")) return "OFFICE_FINANCE";
  if (set.has("TECH")) return "TECH";
  if (set.has("FINANCE")) return "FINANCE";
  return "OFFICE";
}

export default function Staff() {
  const roles = useRoles();
  const [rows, setRows] = useState<StaffRosterRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [selected, setSelected] = useState<StaffRosterRow | null>(null);

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
        <Button small variant="ghost" onClick={() => setInviting(true)}>
          + Invite
        </Button>
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
              subtitle={row.email}
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
    </Page>
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

function StaffActions({
  row,
  onDone,
}: {
  row: StaffRosterRow;
  onDone: () => Promise<void>;
}) {
  const me = useRoles();
  const [choice, setChoice] = useState<RoleChoice>(choiceForRoles(row.roles));
  const [busy, setBusy] = useState<null | "role" | "offboard">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOffboard, setConfirmOffboard] = useState(false);
  const isSelf = me.email?.toLowerCase() === row.email.toLowerCase();

  const saveRole = async () => {
    setBusy("role");
    setError(null);
    try {
      const res = await changeStaffRoles({
        email: row.email,
        roles: [...ROLE_CHOICES[choice].groups],
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the role");
      setBusy(null);
    }
  };

  const doOffboard = async () => {
    setBusy("offboard");
    setError(null);
    try {
      const res = await offboardStaff({ email: row.email });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      await onDone();
    } catch (err) {
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
        <select value={choice} onChange={(e) => setChoice(e.target.value as RoleChoice)}>
          {Object.entries(ROLE_CHOICES).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>
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
            <Button block loading={busy === "offboard"} onClick={() => void doOffboard()}>
              Yes, offboard now
            </Button>
            <Button block variant="ghost" onClick={() => setConfirmOffboard(false)}>
              Cancel
            </Button>
          </div>
        )}
      </div>

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
  const [role, setRole] = useState<RoleChoice>("OFFICE");
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
