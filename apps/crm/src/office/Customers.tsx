import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, listAll, unwrap } from "../lib/api";
import { useAction, useAsync } from "../lib/useAsync";
import {
  rowsForTab,
  type CustomersLoaded,
  type CustomersTab,
} from "../lib/customerTabs";
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

type Tab = CustomersTab;

export default function Customers() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("ACTIVE");
  const [query, setQuery] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);

  // The stale-response guard this screen used to hand-roll now lives in
  // useAsync, so every list in the app has it.
  const {
    data: loaded,
    error,
    reload,
  } = useAsync<CustomersLoaded>(async () => {
    // Captured per run, so the tag records the tab this data was actually
    // fetched for rather than whatever the tab happens to be when it lands.
    const forTab = tab;
    if (forTab === "GROUPS") {
      return {
        tab: forTab,
        groups: await listAll((t) =>
          api().models.CustomerGroup.list({ limit: 500, nextToken: t })
        ),
      };
    }
    return {
      tab: forTab,
      customers: await listAll((t) =>
        api().models.Customer.listCustomerByStatusAndDisplayName(
          { status: forTab },
          { limit: 500, nextToken: t }
        )
      ),
    };
  }, [tab]);

  // Held rows belonging to a different tab are "not loaded yet" for this one,
  // which the existing `!customers` / `!groups` branches already render as a
  // Spinner. No cast anywhere: the tag does the narrowing.
  const { customers, groups } = rowsForTab(loaded, tab);

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
          <Button small onClick={() => navigate("/leads")}>
            + Lead
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
                  : "New customers arrive here when a lead books and pays online. Use + Lead to add a prospect to work."
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
          {[...groups]
            .sort((a, b) => {
              // Active groups first; then alphabetical. `name` is required by
              // the schema, so the guards are belt-and-braces — but a list
              // screen sorting itself into a blank page is exactly the failure
              // worth being paranoid about, and every other sort here already
              // coalesces.
              const ai = a.status === "INACTIVE" ? 1 : 0;
              const bi = b.status === "INACTIVE" ? 1 : 0;
              return ai - bi || (a.name ?? "").localeCompare(b.name ?? "");
            })
            .map((g) => (
              <ListRow
                key={g.id}
                title={g.name}
                subtitle={g.contactName ?? undefined}
                meta={<StatusBadge status={g.status ?? "ACTIVE"} />}
                onClick={() => navigate(`/groups/${g.id}`)}
              />
            ))}
        </Card>
      )}

      <Sheet
        open={addingGroup}
        onClose={() => setAddingGroup(false)}
        title="New customer group"
      >
        <GroupForm
          onDone={async () => {
            setAddingGroup(false);
            reload();
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

  // Nothing here is idempotent — a double-click used to create two groups with
  // the same name, and members can only belong to one of them.
  const create = useAction(async () => {
    if (!name.trim()) {
      throw new Error("Group name is required");
    }
    unwrap(
      await api().models.CustomerGroup.create({
        name: name.trim(),
        contactName: contactName.trim() || undefined,
        contactEmail: contactEmail.trim() || undefined,
        status: "ACTIVE",
      })
    );
    await onDone();
  }, "Could not create group");

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
      <ErrorNote error={create.error} />
      <Button block loading={create.busy} onClick={() => void create.run()}>
        Create group
      </Button>
    </div>
  );
}
