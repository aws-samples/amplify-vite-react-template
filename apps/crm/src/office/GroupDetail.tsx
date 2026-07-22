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
    </Page>
  );
}
