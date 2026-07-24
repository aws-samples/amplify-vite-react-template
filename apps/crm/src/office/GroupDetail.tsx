import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, unwrap, type Customer, type CustomerGroup } from "../lib/api";
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
  const [group, setGroup] = useState<CustomerGroup | null>(null);
  const [members, setMembers] = useState<Customer[]>([]);
  const [others, setOthers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  // When set, the group's email already signs in — hold the server's message
  // and let the office choose to reuse that login or cancel.
  const [reusePrompt, setReusePrompt] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const g = unwrap(await api().models.CustomerGroup.get({ id }));
      setGroup(g);
      const all = unwrap(await api().models.Customer.list({ limit: 1000 }));
      setMembers(all.filter((c) => c.groupId === id));
      setOthers(all.filter((c) => c.groupId !== id && c.status !== "INACTIVE"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load group");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!group) {
    return (
      <Page title="Group" back="/customers">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  const invite = async (confirmReuse = false) => {
    if (!group) return;
    if (!group.contactEmail) {
      setError("Add a contact email to the group before inviting a login.");
      return;
    }
    setInviting(true);
    setError(null);
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
      setReusePrompt(null);
      await load();
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not invite group login";
      // The collision guard is recoverable — offer reuse instead of failing.
      if (msg.includes("already signs in as")) setReusePrompt(msg);
      else setError(msg);
    } finally {
      setInviting(false);
    }
  };

  const move = async (customerId: string, groupId: string | null) => {
    setBusyId(customerId);
    setError(null);
    try {
      unwrap(
        await api().mutations.setCustomerGroup({
          customerId,
          groupId: groupId ?? undefined,
        })
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update member");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Page title={group.name} back="/customers">
      <ErrorNote error={error} />
      <Card>
        <dl className="kv">
          <dt>Contact</dt>
          <dd>{group.contactName ?? "—"}</dd>
          <dt>Email</dt>
          <dd>{group.contactEmail ?? "—"}</dd>
          <dt>Phone</dt>
          <dd>{group.contactPhone ?? "—"}</dd>
        </dl>
        <p className="muted small" style={{ marginTop: 10 }}>
          Portal users belonging to members of this group can view every
          member's service details.
        </p>
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
              loading={inviting}
              onClick={() => void invite(false)}
            >
              {group.portalUserSub ? "Resend group login" : "Invite group login"}
            </Button>
          </span>
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
                    loading={busyId === c.id}
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
            loading={inviting}
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
