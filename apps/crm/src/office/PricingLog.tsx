import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, listAll, type LeadPricingRun } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { fmtDate, money } from "../lib/format";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  ListRow,
  Page,
  SegControl,
  Sheet,
  Spinner,
  StatusBadge,
  Button,
} from "../ui/kit";

type Outcome = "PENDING" | "SENT" | "WON" | "LOST" | "PASSED";

/**
 * The weekly pricing-review log: every AI pricing run in one place — date,
 * town, service, zone, lead fee, quoted price, outcome. Tap a row to update
 * the outcome (won/lost) so the log drives the price-increase phase.
 */
export default function PricingLog() {
  const navigate = useNavigate();
  const {
    data: runs,
    error: loadError,
    reload,
  } = useAsync<LeadPricingRun[]>(
    async () => {
      const rows = await listAll((nextToken) =>
        api().models.LeadPricingRun.list({ limit: 500, nextToken })
      );
      return rows.sort((a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "")
      );
    },
    [],
    "Could not load the log"
  );
  const [editing, setEditing] = useState<LeadPricingRun | null>(null);
  const [busy, setBusy] = useState(false);
  // The save path still hand-rolls its error; the mutation pass takes it.
  const [saveError, setSaveError] = useState<string | null>(null);

  const priceLabel = (r: LeadPricingRun) =>
    r.monthlyPriceCents != null
      ? `${money(r.monthlyPriceCents)}/mo`
      : r.oneTimePriceCents != null
        ? `${money(r.oneTimePriceCents)} flat`
        : "—";

  return (
    <Page title="Pricing log" back="/more">
      <ErrorNote error={saveError ?? loadError} />
      {runs === null ? (
        <Spinner />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No pricing runs yet"
          body="Price your first lead from the Leads tab — every run lands here for the weekly review."
        />
      ) : (
        <Card>
          {runs.map((r) => (
            <ListRow
              key={r.id}
              title={`${r.town ?? "Unknown town"} — ${r.service ?? "unmapped"}`}
              subtitle={`${fmtDate(r.createdAt, true)} · zone ${r.zone ?? "?"} · fee ${
                r.leadFeeCents != null
                  ? r.leadFeeCents === 0
                    ? "none"
                    : money(r.leadFeeCents)
                  : "?"
              } · ${priceLabel(r)}`}
              meta={
                <>
                  <StatusBadge status={r.decision ?? undefined} />
                  {r.outcome && r.outcome !== "PENDING" ? (
                    <Badge tone={r.outcome === "WON" ? "ok" : "muted"}>
                      {r.outcome.toLowerCase()}
                    </Badge>
                  ) : null}
                </>
              }
              onClick={() => setEditing(r)}
            />
          ))}
        </Card>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Pricing run"
      >
        {editing ? (
          <div className="form-grid">
            <dl className="kv">
              <dt>Service</dt>
              <dd>{editing.service ?? "—"}</dd>
              <dt>Decision</dt>
              <dd>{editing.decision}</dd>
              <dt>Price</dt>
              <dd>{priceLabel(editing)}</dd>
              {editing.reason ? (
                <>
                  <dt>Reason</dt>
                  <dd>{editing.reason}</dd>
                </>
              ) : null}
            </dl>
            {editing.replyText ? (
              <p className="small" style={{ whiteSpace: "pre-wrap", background: "var(--surface-2)", borderRadius: 10, padding: 10 }}>
                {editing.replyText}
              </p>
            ) : null}
            <SegControl
              options={[
                { value: "PENDING" as Outcome, label: "Pending" },
                { value: "WON" as Outcome, label: "Won" },
                { value: "LOST" as Outcome, label: "Lost" },
                { value: "PASSED" as Outcome, label: "Passed" },
              ]}
              value={(editing.outcome ?? "PENDING") as Outcome}
              onChange={(v) => setEditing({ ...editing, outcome: v })}
            />
            <div className="form-row-2">
              {editing.customerId ? (
                <Button
                  variant="ghost"
                  onClick={() => navigate(`/customers/${editing.customerId}`)}
                >
                  Open lead
                </Button>
              ) : (
                <span />
              )}
              <Button
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  api()
                    .models.LeadPricingRun.update({
                      id: editing.id,
                      outcome: editing.outcome ?? "PENDING",
                    })
                    .then(() => {
                      setEditing(null);
                      reload();
                    })
                    .catch((err) =>
                      setSaveError(err instanceof Error ? err.message : "Save failed")
                    )
                    .finally(() => setBusy(false));
                }}
              >
                Save outcome
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </Page>
  );
}
