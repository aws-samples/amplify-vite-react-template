import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, listAll, unwrap, type Customer, type CustomerGroup } from "../lib/api";
import {
  Badge,
  Button,
  Card,
  EmptyState,
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

type Tab = "ACTIVE" | "INACTIVE" | "GROUPS";

export default function Customers() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [groups, setGroups] = useState<CustomerGroup[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);

  // Monotonic request id: rapid tab switches must not let a slower older
  // response overwrite the newer tab's data.
  const reqRef = useRef(0);
  const load = useCallback(async (which: Tab) => {
    const req = ++reqRef.current;
    setError(null);
    try {
      if (which === "GROUPS") {
        const rows = await listAll((t) =>
          api().models.CustomerGroup.list({ limit: 500, nextToken: t })
        );
        if (req === reqRef.current) setGroups(rows);
      } else {
        const rows = await listAll((t) =>
          api().models.Customer.listCustomerByStatusAndDisplayName(
            { status: which },
            { limit: 500, nextToken: t }
          )
        );
        if (req === reqRef.current) setCustomers(rows);
      }
    } catch (err) {
      if (req === reqRef.current) {
        setError(err instanceof Error ? err.message : "Could not load");
      }
    }
  }, []);

  useEffect(() => {
    setCustomers(null);
    setGroups(null);
    void load(tab);
  }, [tab, load]);

  const q = query.trim().toLowerCase();
  const filtered = (customers ?? []).filter(
    (c) =>
      !q ||
      c.displayName.toLowerCase().includes(q) ||
      (c.serviceCity ?? "").toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q)
  );

  return (
    <Page
      title="Customers"
      actions={
        tab === "GROUPS" ? (
          <Button small onClick={() => setAddingGroup(true)}>
            + Group
          </Button>
        ) : (
          <Button small onClick={() => setAdding(true)}>
            + Customer
          </Button>
        )
      }
    >
      <SegControl
        options={[
          { value: "ACTIVE" as Tab, label: "Active" },
          { value: "INACTIVE" as Tab, label: "Inactive" },
          { value: "GROUPS" as Tab, label: "Groups" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <ErrorNote error={error} />

      {tab !== "GROUPS" ? (
        <>
          <input
            placeholder="Search name, city, email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!customers ? (
            <Spinner />
          ) : filtered.length === 0 ? (
            <EmptyState
              title={q ? "No matches" : "No customers here yet"}
              body={
                q
                  ? "Try a different search."
                  : "Convert a lead or add a customer to get started."
              }
            />
          ) : (
            <Card>
              {filtered.map((c) => (
                <ListRow
                  key={c.id}
                  title={
                    <>
                      {c.displayName}
                      {c.groupId ? <Badge tone="info">group</Badge> : null}
                    </>
                  }
                  subtitle={[c.serviceCity, c.paymentMethodLabel ?? "no payment method"]
                    .filter(Boolean)
                    .join(" · ")}
                  meta={<StatusBadge status={c.status} />}
                  onClick={() => navigate(`/customers/${c.id}`)}
                />
              ))}
            </Card>
          )}
        </>
      ) : !groups ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <EmptyState
          title="No customer groups"
          body="Groups let a management company oversee several properties — members can see each other's service details in the portal."
          action={<Button onClick={() => setAddingGroup(true)}>Create a group</Button>}
        />
      ) : (
        <Card>
          {groups.map((g) => (
            <ListRow
              key={g.id}
              title={g.name}
              subtitle={g.contactName ?? undefined}
              onClick={() => navigate(`/groups/${g.id}`)}
            />
          ))}
        </Card>
      )}

      <Sheet open={adding} onClose={() => setAdding(false)} title="New customer">
        <CustomerForm
          initial={customerToForm()}
          submitLabel="Add customer"
          onSubmit={async (v) => {
            const created = unwrap(
              await api().models.Customer.create({
                displayName: v.displayName.trim(),
                contactName: v.contactName.trim() || undefined,
                email: v.email.trim() || undefined,
                phone: v.phone.trim() || undefined,
                serviceStreet: v.serviceStreet.trim() || undefined,
                serviceCity: v.serviceCity.trim() || undefined,
                serviceState: v.serviceState.trim() || undefined,
                serviceZip: v.serviceZip.trim() || undefined,
                notes: v.notes.trim() || undefined,
                status: "ACTIVE",
              })
            );
            setAdding(false);
            if (created) navigate(`/customers/${created.id}`);
          }}
        />
      </Sheet>

      <Sheet
        open={addingGroup}
        onClose={() => setAddingGroup(false)}
        title="New customer group"
      >
        <GroupForm
          onDone={async () => {
            setAddingGroup(false);
            await load("GROUPS");
          }}
        />
      </Sheet>
    </Page>
  );
}

function GroupForm({ onDone }: { onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="form-grid">
      <Field label="Group name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Northeast Property Management"
        />
      </Field>
      <Field label="Primary contact">
        <input value={contactName} onChange={(e) => setContactName(e.target.value)} />
      </Field>
      <Field label="Contact email">
        <input
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          if (!name.trim()) {
            setError("Group name is required");
            return;
          }
          setBusy(true);
          api()
            .models.CustomerGroup.create({
              name: name.trim(),
              contactName: contactName.trim() || undefined,
              contactEmail: contactEmail.trim() || undefined,
            })
            .then((res) => {
              unwrap(res);
              return onDone();
            })
            .catch((err) => {
              setError(err.message ?? "Could not create group");
              setBusy(false);
            });
        }}
      >
        Create group
      </Button>
    </div>
  );
}
