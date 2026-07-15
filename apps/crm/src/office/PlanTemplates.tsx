import { useCallback, useEffect, useState } from "react";
import { api, unwrap, type PlanTemplate } from "../lib/api";
import { DEFAULT_AGREEMENT_BODY } from "../lib/agreementTemplate";
import { money } from "../lib/format";
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

type Freq = "MONTHLY" | "BIMONTHLY" | "QUARTERLY";

/**
 * Global plan catalog. Plans and quotes for customers are created from these
 * templates; each template carries the default agreement sent when a lead is
 * quoted.
 */
export default function PlanTemplates() {
  const [templates, setTemplates] = useState<PlanTemplate[] | null>(null);
  const [editing, setEditing] = useState<PlanTemplate | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = unwrap(await api().models.PlanTemplate.list({ limit: 200 }));
      setTemplates(
        rows.sort(
          (a, b) =>
            (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
            a.name.localeCompare(b.name)
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load templates");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page
      title="Plan templates"
      back="/more"
      actions={
        <Button small variant="ghost" onClick={() => setEditing("new")}>
          + Template
        </Button>
      }
    >
      <ErrorNote error={error} />
      {templates === null ? (
        <Spinner />
      ) : templates.length === 0 ? (
        <EmptyState
          title="No plan templates yet"
          body="Create the plans BuzzKill sells — quoting a lead and adding a plan to a customer both start from a template."
          action={<Button onClick={() => setEditing("new")}>Create the first template</Button>}
        />
      ) : (
        <Card>
          {templates.map((t) => (
            <ListRow
              key={t.id}
              title={t.name}
              subtitle={`${money(t.priceCents)}/mo · service ${t.serviceFrequency?.toLowerCase()}`}
              meta={
                t.active ? (
                  <Badge tone="ok">active</Badge>
                ) : (
                  <Badge tone="muted">inactive</Badge>
                )
              }
              onClick={() => setEditing(t)}
            />
          ))}
        </Card>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New plan template" : "Edit plan template"}
      >
        {editing !== null ? (
          <TemplateForm
            existing={editing === "new" ? null : editing}
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

function TemplateForm({
  existing,
  onDone,
}: {
  existing: PlanTemplate | null;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [price, setPrice] = useState(
    existing ? (existing.priceCents / 100).toString() : ""
  );
  const [freq, setFreq] = useState<Freq>(
    (existing?.serviceFrequency as Freq) ?? "MONTHLY"
  );
  const [agreementTitle, setAgreementTitle] = useState(
    existing?.agreementTitle ?? "Pest Control Service Agreement"
  );
  const [agreementBody, setAgreementBody] = useState(
    existing?.agreementBody ?? DEFAULT_AGREEMENT_BODY
  );
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const cents = Math.round(parseFloat(price) * 100);
    if (!name.trim() || !Number.isFinite(cents) || cents <= 0) {
      setError("Enter a name and a valid monthly price");
      return;
    }
    if (!agreementTitle.trim() || !agreementBody.trim()) {
      setError("The template needs its agreement title and text");
      return;
    }
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      description: description.trim() || null,
      priceCents: cents,
      serviceFrequency: freq,
      agreementTitle: agreementTitle.trim(),
      agreementBody,
      active,
    };
    try {
      if (existing) {
        unwrap(
          await api().models.PlanTemplate.update({ id: existing.id, ...fields })
        );
      } else {
        unwrap(await api().models.PlanTemplate.create(fields));
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save template");
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <Field label="Plan name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Residential Protection Plan"
        />
      </Field>
      <Field label="Description" hint="Shown to staff when picking a plan">
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="form-row-2">
        <Field label="Monthly price ($)">
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Active">
          <SegControl
            options={[
              { value: "yes" as const, label: "Yes" },
              { value: "no" as const, label: "No" },
            ]}
            value={active ? "yes" : "no"}
            onChange={(v) => setActive(v === "yes")}
          />
        </Field>
      </div>
      <Field label="Service visit frequency">
        <SegControl
          options={[
            { value: "MONTHLY" as const, label: "Monthly" },
            { value: "BIMONTHLY" as const, label: "Bi-monthly" },
            { value: "QUARTERLY" as const, label: "Quarterly" },
          ]}
          value={freq}
          onChange={setFreq}
        />
      </Field>
      <Field label="Agreement title">
        <input value={agreementTitle} onChange={(e) => setAgreementTitle(e.target.value)} />
      </Field>
      <Field
        label="Agreement text"
        hint="Sent when a lead is quoted with this plan. Placeholders: {{customerName}}, {{planName}}, {{price}}, {{frequency}}, {{address}}"
      >
        <textarea
          rows={12}
          value={agreementBody}
          onChange={(e) => setAgreementBody(e.target.value)}
        />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void save()}>
        {existing ? "Save template" : "Create template"}
      </Button>
    </div>
  );
}
