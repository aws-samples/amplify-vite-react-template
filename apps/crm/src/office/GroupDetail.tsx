import { useCallback, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, listAll, unwrap, type Customer, type CustomerGroup } from "../lib/api";
import { useAsync, useKeyedAction } from "../lib/useAsync";
import { toMessage } from "../lib/asyncCore";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
  Spinner,
  StatusBadge,
} from "../ui/kit";

export default function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  // When set, the group's email already signs in — hold the server's message
  // and let the office choose to reuse that login or cancel.
  const [reusePrompt, setReusePrompt] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Draft edit fields (seeded when the edit sheet opens).
  const [fName, setFName] = useState("");
  const [fContact, setFContact] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fPhone, setFPhone] = useState("");
  const [fNotes, setFNotes] = useState("");

  const {
    data,
    error: loadError,
    reload,
  } = useAsync<{
    group: CustomerGroup | null;
    members: Customer[];
    others: Customer[];
  } | null>(
    async () => {
      if (!id) return null;
      const g = unwrap(await api().models.CustomerGroup.get({ id }));
      const all = await listAll((t) =>
        api().models.Customer.list({ limit: 1000, nextToken: t })
      );
      return {
        group: g,
        members: all.filter((c) => c.groupId === id),
        others: all.filter((c) => c.groupId !== id && c.status !== "INACTIVE"),
      };
    },
    [id],
    "Could not load group"
  );
  const group = data?.group ?? null;
  const members = data?.members ?? [];
  const others = data?.others ?? [];

  // Five independent writes behind one error slot. The gate is keyed by button
  // (and by member id for a move) so one write in flight cannot swallow the
  // press on another — and an invite is worth gating: a double-click used to
  // send the management contact two sign-in links, only the last of which works.
  // Declared above the early return below so the hooks stay unconditional.
  const perform = useKeyedAction();
  const { run: runKeyed, error, clearError } = perform;
  const runOn = useCallback(
    (key: string, fallbackMessage: string, fn: () => Promise<unknown>) =>
      runKeyed(key, async () => {
        try {
          await fn();
        } catch (err) {
          // Each action keeps its own wording for a failure that carries none.
          throw new Error(toMessage(err, fallbackMessage));
        }
      }),
    [runKeyed]
  );

  if (!group) {
    return (
      <Page title="Group" back="/customers">
        <ErrorNote error={error ?? loadError} />
        <Spinner />
      </Page>
    );
  }

  const invite = (confirmReuse = false) =>
    runOn("invite", "Could not invite group login", async () => {
      if (!group) return;
      if (!group.contactEmail) {
        throw new Error(
          "Add a contact email to the group before inviting a login."
        );
      }
      try {
        unwrap(
          await api().mutations.adminCreateUser({
            email: group.contactEmail,
            name: group.contactName ?? group.name,
            roles: ["CUSTOMER"],
            groupId: group.id,
            confirmReuse,
          })
        );
      } catch (err) {
        // The collision guard is recoverable — offer reuse instead of failing.
        const msg =
          err instanceof Error ? err.message : "Could not invite group login";
        if (msg.includes("already signs in as")) {
          setReusePrompt(msg);
          return;
        }
        throw err;
      }
      setReusePrompt(null);
      reload();
    });

  const move = (customerId: string, groupId: string | null) =>
    runOn(customerId, "Could not update member", async () => {
      unwrap(
        await api().mutations.setCustomerGroup({
          customerId,
          groupId: groupId ?? undefined,
        })
      );
      reload();
    });

  const openEdit = () => {
    if (!group) return;
    setFName(group.name ?? "");
    setFContact(group.contactName ?? "");
    setFEmail(group.contactEmail ?? "");
    setFPhone(group.contactPhone ?? "");
    setFNotes(group.notes ?? "");
    clearError();
    setEditing(true);
  };

  const saveEdit = () =>
    runOn("save", "Could not save the group", async () => {
      if (!group) return;
      if (!fName.trim()) {
        throw new Error("Group name is required");
      }
      // OWNER writes the group model directly (same path new groups are created
      // on) — no dedicated mutation. Empty fields clear to null.
      unwrap(
        await api().models.CustomerGroup.update({
          id: group.id,
          name: fName.trim(),
          contactName: fContact.trim() || null,
          contactEmail: fEmail.trim() || null,
          contactPhone: fPhone.trim() || null,
          notes: fNotes.trim() || null,
        })
      );
      setEditing(false);
      reload();
    });

  const inactivate = () =>
    runOn("status", "Could not inactivate the group", async () => {
      if (!group) return;
      // Block while properties still point at the group — remove/reassign first so
      // no member is left owned by a retired management company.
      if (members.length > 0) {
        throw new Error(
          `Remove or reassign all ${members.length} member${members.length === 1 ? "" : "s"} before inactivating this group.`
        );
      }
      if (
        !window.confirm(
          "Inactivate this group? Its portal login (if any) is disabled and it drops out of the group pickers. You can reactivate it later."
        )
      )
        return;
      // Access half first — disable the group login before the group reads
      // INACTIVE, so an inactive group never implies a live login. No-op when
      // there is no login.
      unwrap(await api().mutations.revokePortalAccess({ groupId: group.id }));
      unwrap(
        await api().models.CustomerGroup.update({
          id: group.id,
          status: "INACTIVE",
        })
      );
      reload();
    });

  const reactivate = () =>
    runOn("status", "Could not reactivate the group", async () => {
      if (!group) return;
      unwrap(
        await api().models.CustomerGroup.update({
          id: group.id,
          status: "ACTIVE",
        })
      );
      reload();
    });

  const isInactive = group.status === "INACTIVE";

  return (
    <Page title={group.name} back="/customers">
      <ErrorNote error={error ?? loadError} />
      <Card
        title="Group details"
        actions={
          <span className="inline-actions" style={{ gap: 8 }}>
            <StatusBadge status={isInactive ? "INACTIVE" : "ACTIVE"} />
            <Button small variant="ghost" onClick={openEdit}>
              Edit
            </Button>
          </span>
        }
      >
        <dl className="kv">
          <dt>Contact</dt>
          <dd>{group.contactName ?? "—"}</dd>
          <dt>Email</dt>
          <dd>{group.contactEmail ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{group.contactPhone ?? "—"}</dd>
          {group.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{group.notes}</dd>
            </>
          ) : null}
        </dl>
        <p className="muted small" style={{ marginTop: 10 }}>
          Portal users belonging to members of this group can view every
          member's service details.
        </p>
        {!isInactive ? (
          <div className="inline-actions" style={{ marginTop: 12 }}>
            <p className="muted small" style={{ flex: 1 }}>
              {group.portalUserSub
                ? `Group login active${group.portalInvitedAt ? ` — invited ${new Date(group.portalInvitedAt).toLocaleDateString()}` : ""}. It sees every property below.`
                : "No group login yet. Invite one to give a management contact a single login across all properties."}
            </p>
            <span
              className="permission-tooltip"
              title={!group.contactEmail ? "Add a contact email first." : undefined}
            >
              <Button
                small
                variant="subtle"
                disabled={!group.contactEmail}
                loading={perform.busyKey === "invite"}
                onClick={() => void invite(false)}
              >
                {group.portalUserSub ? "Resend group login" : "Invite group login"}
              </Button>
            </span>
          </div>
        ) : null}
        <div
          className="inline-actions"
          style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}
        >
          <p className="muted small" style={{ flex: 1 }}>
            {isInactive
              ? "This group is inactive — hidden from group pickers and its login is disabled."
              : "Inactivate a group you no longer manage. Remove its members first."}
          </p>
          {isInactive ? (
            <Button
              small
              variant="subtle"
              loading={perform.busyKey === "status"}
              onClick={() => void reactivate()}
            >
              Reactivate group
            </Button>
          ) : (
            <Button
              small
              variant="danger"
              loading={perform.busyKey === "status"}
              onClick={() => void inactivate()}
            >
              Inactivate group
            </Button>
          )}
        </div>
      </Card>

      <Card
        title={`Members (${members.length})`}
        actions={
          <Button small variant="ghost" onClick={() => setAdding(true)}>
            + Add
          </Button>
        }
      >
        {members.length === 0 ? (
          <p className="muted small">No members yet.</p>
        ) : (
          members.map((c) => (
            <ListRow
              key={c.id}
              title={c.displayName}
              subtitle={c.serviceCity ?? undefined}
              meta={
                <>
                  <StatusBadge status={c.status} />
                  <Button
                    small
                    variant="ghost"
                    loading={perform.busyKey === c.id}
                    onClick={() => void move(c.id, null)}
                  >
                    Remove
                  </Button>
                </>
              }
              onClick={() => navigate(`/customers/${c.id}`)}
            />
          ))
        )}
      </Card>

      <Sheet open={editing} onClose={() => setEditing(false)} title="Edit group">
        <Field label="Group name">
          <input value={fName} onChange={(e) => setFName(e.target.value)} />
        </Field>
        <Field label="Contact name">
          <input value={fContact} onChange={(e) => setFContact(e.target.value)} />
        </Field>
        <Field label="Contact email">
          <input
            type="email"
            value={fEmail}
            onChange={(e) => setFEmail(e.target.value)}
          />
        </Field>
        <Field label="Contact phone">
          <input
            type="tel"
            value={fPhone}
            onChange={(e) => setFPhone(e.target.value)}
          />
        </Field>
        <Field label="Notes">
          <textarea
            rows={3}
            value={fNotes}
            onChange={(e) => setFNotes(e.target.value)}
          />
        </Field>
        <div className="inline-actions" style={{ marginTop: 16 }}>
          <Button loading={perform.busyKey === "save"} onClick={() => void saveEdit()}>
            Save changes
          </Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Add member">
        <Field label="Customer">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) {
                setAdding(false);
                void move(e.target.value, group.id);
              }
            }}
          >
            <option value="" disabled>
              Choose a customer…
            </option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </Field>
      </Sheet>

      <Sheet
        open={reusePrompt !== null}
        onClose={() => setReusePrompt(null)}
        title="Email already in use"
      >
        <p className="small">{reusePrompt}</p>
        <div className="inline-actions" style={{ marginTop: 16 }}>
          <Button
            variant="subtle"
            loading={perform.busyKey === "invite"}
            onClick={() => void invite(true)}
          >
            Reuse that login for this group
          </Button>
          <Button variant="ghost" onClick={() => setReusePrompt(null)}>
            Cancel
          </Button>
        </div>
      </Sheet>
    </Page>
  );
}
