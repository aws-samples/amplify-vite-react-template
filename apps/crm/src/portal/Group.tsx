import { useState } from "react";
import { api, listAll, unwrap, type Customer, type CustomerGroup, type Job } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { myGroupIds, useRoles } from "../lib/auth";
import { fmtDate, todayEastern } from "../lib/format";
import { Card, EmptyState, ErrorNote, ListRow, Page, Sheet, Spinner, StatusBadge } from "../ui/kit";

/**
 * Group view for management-company users: every customer in their
 * CustomerGroup, with each property's upcoming and recent services.
 * Row-level access comes from the shared grp-<id> Cognito group.
 */
export default function PortalGroup() {
  const roles = useRoles();
  const [viewing, setViewing] = useState<Customer | null>(null);

  const { data, error } = useAsync<{
    groups: CustomerGroup[];
    members: Customer[];
  } | null>(
    async () => {
      // Roles are still resolving — resolving to null keeps the spinner up,
      // exactly as the old effect's early return did.
      if (roles.loading) return null;
      const ids = myGroupIds(roles);
      const loaded = await Promise.all(
        ids.map((id) => api().models.CustomerGroup.get({ id }))
      );
      const memberLists = await Promise.all(
        ids.map((id) =>
          listAll((t) =>
            api().models.Customer.list({
              filter: { groupId: { eq: id } },
              limit: 500,
              nextToken: t,
            })
          )
        )
      );
      return {
        groups: loaded
          .map((r) => unwrap(r) as unknown as CustomerGroup | null)
          .filter((g): g is CustomerGroup => Boolean(g)),
        members: memberLists.flat(),
      };
    },
    [roles],
    "Could not load group"
  );
  const groups = data?.groups ?? null;
  const members = data?.members ?? [];

  if (!groups) {
    return (
      <Page title="My group">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  return (
    <Page title={groups[0]?.name ?? "My group"}>
      <ErrorNote error={error} />
      {groups.length === 0 ? (
        <EmptyState
          title="No group membership"
          body="Your account isn't part of a customer group."
        />
      ) : (
        <Card title={`Properties (${members.length})`}>
          {members.map((m) => (
            <ListRow
              key={m.id}
              title={m.displayName}
              subtitle={[m.serviceStreet, m.serviceCity].filter(Boolean).join(", ") || undefined}
              meta={<StatusBadge status={m.status} />}
              onClick={() => setViewing(m)}
            />
          ))}
        </Card>
      )}

      <Sheet
        open={viewing !== null}
        onClose={() => setViewing(null)}
        title={viewing?.displayName ?? ""}
      >
        {viewing ? <MemberDetail customer={viewing} /> : null}
      </Sheet>
    </Page>
  );
}

function MemberDetail({ customer }: { customer: Customer }) {
  const { data, error } = useAsync<Job[]>(
    () =>
      listAll((t) =>
        api().models.Job.list({
          filter: { customerId: { eq: customer.id } },
          limit: 200,
          nextToken: t,
        })
      ),
    [customer.id],
    "Could not load visits"
  );
  // This panel has never shown a load failure — a failed load falls through to
  // the "Nothing scheduled" / "None yet" copy rather than spinning forever.
  const jobs = data ?? (error ? [] : null);

  const today = todayEastern();
  const upcoming = (jobs ?? []).filter(
    (j) => j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today
  );
  const recent = (jobs ?? [])
    .filter((j) => j.status === "COMPLETED")
    .sort((a, b) => (b.scheduledDate ?? "").localeCompare(a.scheduledDate ?? ""))
    .slice(0, 5);

  return (
    <div className="form-grid">
      <dl className="kv">
        <dt>Contact</dt>
        <dd>{customer.contactName ?? "—"}</dd>
        <dt>Address</dt>
        <dd>
          {[customer.serviceStreet, customer.serviceCity, customer.serviceZip]
            .filter(Boolean)
            .join(", ") || "—"}
        </dd>
      </dl>
      {jobs === null ? (
        <Spinner />
      ) : (
        <>
          <Card title="Upcoming">
            {upcoming.length === 0 ? (
              <p className="muted small">Nothing scheduled.</p>
            ) : (
              upcoming.map((j) => (
                <ListRow key={j.id} title={j.serviceType} meta={<span>{fmtDate(j.scheduledDate)}</span>} />
              ))
            )}
          </Card>
          <Card title="Recent services">
            {recent.length === 0 ? (
              <p className="muted small">None yet.</p>
            ) : (
              recent.map((j) => (
                <ListRow key={j.id} title={j.serviceType} meta={<span>{fmtDate(j.scheduledDate, true)}</span>} />
              ))
            )}
          </Card>
        </>
      )}
    </div>
  );
}
