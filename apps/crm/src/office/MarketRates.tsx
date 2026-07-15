import { useCallback, useEffect, useState } from "react";
import { api, listAll, unwrap, type MarketRate } from "../lib/api";
import { fmtDate, money } from "../lib/format";
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
} from "../ui/kit";

const SERVICE_LABEL: Record<string, string> = {
  RODENT: "Rodent treatment",
  ROACH: "Specialized roach",
  WASP_EXTRA_NEST: "Extra wasp nest",
};

/**
 * AI-researched market rates for services without a fixed rate card. Each
 * row was researched once for a service + area (+ size) and cached so quotes
 * stay consistent. The office reviews, overrides, or retires any rate here.
 */
export default function MarketRates() {
  const [rates, setRates] = useState<MarketRate[] | null>(null);
  const [editing, setEditing] = useState<MarketRate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await listAll<MarketRate>((t) =>
        api().models.MarketRate.list({ limit: 500, nextToken: t })
      );
      setRates(
        rows.sort((a, b) =>
          (b.researchedAt ?? "").localeCompare(a.researchedAt ?? "")
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load market rates");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const expired = (r: MarketRate) =>
    r.expiresAt != null && new Date(r.expiresAt).getTime() < Date.now();

  return (
    <Page title="Market rates" back="/more">
      <ErrorNote error={error} />
      {rates === null ? (
        <Spinner />
      ) : rates.length === 0 ? (
        <EmptyState
          title="No market rates yet"
          body="When a website lead needs pricing for a service without a rate card (rodent, roach, extra wasp nests), the AI researches the local market once and the result lands here for review."
        />
      ) : (
        <Card>
          {rates.map((r) => (
            <ListRow
              key={r.id}
              title={`${SERVICE_LABEL[r.service] ?? r.service} · ${r.areaKey}`}
              subtitle={`${money(r.priceCents)}${r.researchedAt ? ` · researched ${fmtDate(r.researchedAt, true)}` : ""}${r.basis ? ` · ${r.basis.slice(0, 70)}` : ""}`}
              meta={
                <>
                  {!r.active ? (
                    <Badge tone="muted">retired</Badge>
                  ) : expired(r) ? (
                    <Badge tone="warn">expired</Badge>
                  ) : (
                    <Badge tone="ok">active</Badge>
                  )}
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
        title="Market rate"
      >
        {editing ? (
          <RateForm
            rate={editing}
            onDone={async () => {
              setEditing(null);
              await load();
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

function RateForm({
  rate,
  onDone,
}: {
  rate: MarketRate;
  onDone: () => Promise<void>;
}) {
  const [price, setPrice] = useState((rate.priceCents / 100).toString());
  const [active, setActive] = useState(rate.active);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const cents = Math.round(parseFloat(price) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Enter a valid price");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await api().models.MarketRate.update({
          id: rate.id,
          priceCents: cents,
          active,
        })
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <dl className="kv">
        <dt>Service</dt>
        <dd>{SERVICE_LABEL[rate.service] ?? rate.service}</dd>
        <dt>Area</dt>
        <dd>{rate.areaKey}</dd>
        {rate.researchedAt ? (
          <>
            <dt>Researched</dt>
            <dd>{fmtDate(rate.researchedAt, true)}</dd>
          </>
        ) : null}
        {rate.expiresAt ? (
          <>
            <dt>Re-researches</dt>
            <dd>{fmtDate(rate.expiresAt, true)}</dd>
          </>
        ) : null}
      </dl>
      {rate.basis ? (
        <p className="small" style={{ background: "var(--surface-2)", borderRadius: 10, padding: 10 }}>
          {rate.basis}
        </p>
      ) : null}
      <Field label="Price ($)" hint="Your override becomes the quoted price for this service + area">
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <Field label="Active" hint="Retire to force fresh research on the next quote">
        <SegControl
          options={[
            { value: "yes" as const, label: "Active" },
            { value: "no" as const, label: "Retired" },
          ]}
          value={active ? "yes" : "no"}
          onChange={(v) => setActive(v === "yes")}
        />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void save()}>
        Save rate
      </Button>
    </div>
  );
}
