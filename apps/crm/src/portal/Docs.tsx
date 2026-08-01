import { useEffect, useState } from "react";
import { api, listAll, type Agreement, type Customer, type ServiceReport } from "../lib/api";
import { useRoles } from "../lib/auth";
import { fmtDate, fmtDateTime } from "../lib/format";
import { Card, EmptyState, ErrorNote, ListRow, Page, Spinner } from "../ui/kit";
import DocButton from "../components/DocButton";
import { loadMyCustomers } from "./portalData";

export default function PortalDocs() {
  const roles = useRoles();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [reports, setReports] = useState<ServiceReport[]>([]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (roles.loading) return;
    (async () => {
      try {
        const mine = await loadMyCustomers(roles);
        setCustomers(mine);
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
        setReports(
          reps
            .flat()
            .filter((r) => r.status === "FINALIZED" && r.pdfKey)
            .sort((a, b) => b.serviceDate.localeCompare(a.serviceDate))
        );
        setAgreements(
          ags.flat().filter((a) => a.status === "SIGNED" && a.pdfKey)
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load documents");
      }
    })();
  }, [roles]);

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
