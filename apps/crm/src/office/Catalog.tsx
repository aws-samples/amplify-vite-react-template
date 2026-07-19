import {
  PUBLIC_CONFLICTS,
  SERVICE_CATALOG,
  SERVICE_CATALOG_VERSION,
} from "../../../web/amplify/functions/shared/serviceCatalog";
import { Badge, Card, ListRow, Page } from "../ui/kit";

/**
 * GL-01 — the service catalog, readable by any office user: exactly what
 * BuzzKill sells, where each service applies, what it needs to quote, how
 * it recurs, and where its price comes from. This is the single source the
 * funnel dropdown, lead pricing, job creation, plan naming, and seasonal
 * behavior all derive from — version-stamped on every job and plan.
 *
 * GL-20 — below it, every KNOWN mismatch between the public site and this
 * catalog, kept visible with the exact file, promise, conflict, and
 * proposed replacement. Public pages are not edited without explicit CEO
 * approval; the CRM never conceals a mismatch.
 */
export default function Catalog() {
  const entries = Object.values(SERVICE_CATALOG);
  return (
    <Page title="Service catalog" back="/more">
      <Card>
        <div className="row-split">
          <strong>What BuzzKill sells</strong>
          <Badge tone="info">version {SERVICE_CATALOG_VERSION}</Badge>
        </div>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          Every job and plan records the catalog service + version it was
          sold under. Anything a customer asks for outside this list becomes
          an owned catalog decision — never a typed-in job.
        </p>
        {entries.map((e) => (
          <ListRow
            key={e.id}
            title={e.label}
            subtitle={[
              e.propertyClasses
                .map((c) => c.toLowerCase())
                .join(" / "),
              e.funnel
                ? "bookable on the website"
                : e.leadForm
                  ? "priced via lead forms"
                  : "office only",
              e.offersRecurring
                ? `plans: ${e.cadences.map((c) => c.toLowerCase()).join(", ")}`
                : "one-time",
              e.seasonal ? "seasonal Apr–Oct, billed year-round" : null,
              e.engineService
                ? "AI market-rate priced"
                : "deterministic price card",
            ]
              .filter(Boolean)
              .join(" · ")}
            meta={
              e.seasonal ? (
                <Badge tone="info">seasonal</Badge>
              ) : e.funnel ? (
                <Badge tone="ok">funnel</Badge>
              ) : (
                <Badge tone="muted">{e.leadForm ? "lead form" : "internal"}</Badge>
              )
            }
          />
        ))}
      </Card>

      <Card>
        <div className="row-split">
          <strong>Public-site conflicts awaiting CEO approval</strong>
          <Badge tone={PUBLIC_CONFLICTS.length ? "warn" : "ok"}>
            {PUBLIC_CONFLICTS.length || "none"}
          </Badge>
        </div>
        <p className="muted small" style={{ margin: "6px 0 0" }}>
          These public promises don&rsquo;t match the catalog or operations.
          Public pages are only changed with explicit CEO approval — until
          then the mismatch stays visible here, never papered over.
        </p>
        {PUBLIC_CONFLICTS.map((c, i) => (
          <ListRow
            key={i}
            title={c.promise}
            subtitle={`${c.files.join(", ")} · Conflict: ${c.conflict} · Proposed: ${c.proposal}`}
            meta={<Badge tone="warn">CEO approval</Badge>}
          />
        ))}
      </Card>
    </Page>
  );
}
