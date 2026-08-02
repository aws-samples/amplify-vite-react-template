import { api, listAll, type Agreement, type Customer, type ServiceReport } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRoles } from "../lib/auth";
import { fmtDate, fmtDateTime } from "../lib/format";
import { Card, EmptyState, ErrorNote, ListRow, Page, Spinner } from "../ui/kit";
import DocButton from "../components/DocButton";
import { loadMyCustomers } from "./portalData";

export default function PortalDocs() {
  const roles = useRoles();
  const { data, error } = useAsync<{
    customers: Customer[];
    reports: ServiceReport[];
    agreements: Agreement[];
  } | null>(
    async () => {
      // Roles are still resolving — resolving to null keeps the spinner up,
      // exactly as the old effect's early return did.
      if (roles.loading) return null;
      const mine = await loadMyCustomers(roles);
      const [reps, ags] = await Promise.all([
        Promise.all(
          mine.map((c) =>
            listAll((t) =>
              api().models.ServiceReport.list({
                filter: { customerId: { eq: c.id } },
                limit: 200,
                nextToken: t,
              })
            )
          )
        ),
        Promise.all(
          mine.map((c) =>
            listAll((t) =>
              api().models.Agreement.list({
                filter: { customerId: { eq: c.id } },
                limit: 100,
                nextToken: t,
              })
            )
          )
        ),
      ]);
      return {
        customers: mine,
        reports: reps
          .flat()
          .filter((r) => r.status === "FINALIZED" && r.pdfKey)
          .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate)),
        agreements: ags.flat().filter((a) => a.status === "SIGNED" && a.pdfKey),
      };
    },
    [roles],
    "Could not load documents"
  );
  const customers = data?.customers ?? null;
  const reports = data?.reports ?? [];
  const agreements = data?.agreements ?? [];

  if (!customers) {
    return (
      <Page title="Documents">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  return (
    <Page title="Documents">
      <ErrorNote error={error} />
      {reports.length === 0 && agreements.length === 0 ? (
        <EmptyState
          title="No documents yet"
          body="Service reports and signed agreements will appear here."
        />
      ) : (
        <>
          {reports.length > 0 ? (
            <Card title="Service reports">
              {reports.map((r) => (
                <ListRow
                  key={r.id}
                  title={`Service report — ${fmtDate(r.serviceDate, true)}`}
                  subtitle={r.servicesPerformed ?? undefined}
                  meta={<DocButton docKey={r.pdfKey!} />}
                />
              ))}
            </Card>
          ) : null}
          {agreements.length > 0 ? (
            <Card title="Agreements">
              {agreements.map((a) => (
                <ListRow
                  key={a.id}
                  title={a.title}
                  subtitle={`Signed ${fmtDateTime(a.signedAt)}`}
                  meta={<DocButton docKey={a.pdfKey!} />}
                />
              ))}
            </Card>
          ) : null}
        </>
      )}
    </Page>
  );
}
