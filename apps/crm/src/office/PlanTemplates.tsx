import { useCallback, useEffect, useRef, useState } from "react";
import { api, opResult, unwrap, type PlanTemplate } from "../lib/api";
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
              subtitle={`${t.priceCents != null ? `${money(t.priceCents)}/mo list` : "AI-priced"} · service ${t.serviceFrequency?.toLowerCase()}`}
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
    existing?.priceCents != null ? (existing.priceCents / 100).toString() : ""
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
    const cents = price.trim() ? Math.round(parseFloat(price) * 100) : null;
    if (!name.trim() || (cents !== null && (!Number.isFinite(cents) || cents <= 0))) {
      setError("Enter a name (and a valid list price, or leave it blank for AI pricing)");
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
        <Field label="List price ($/mo)" hint="Optional — quotes are AI-priced">
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="AI-priced" />
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
      {existing ? (
        <Field
          label="Pest photos"
          hint="Shown on the e-sign page and embedded in the signed PDF"
        >
          <TemplateImages template={existing} />
        </Field>
      ) : (
        <p className="muted small">Save the template first to add pest photos.</p>
      )}
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void save()}>
        {existing ? "Save template" : "Create template"}
      </Button>
    </div>
  );
}

/** Pest photo grid for a template — presigned PUT, thumbnails, remove. */
function TemplateImages({ template }: { template: PlanTemplate }) {
  const [keys, setKeys] = useState<string[]>(
    (template.imageKeys ?? []).filter((k): k is string => typeof k === "string")
  );
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      for (const key of keys) {
        if (urls[key]) continue;
        try {
          const res = await api().queries.getDocumentUrl({ key });
          const { url } = opResult<{ url?: string }>(res) ?? {};
          if (url && !cancel) setUrls((u) => ({ ...u, [key]: url }));
        } catch {
          /* thumbnail just won't render */
        }
      }
    })();
    return () => {
      cancel = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.join("|")]);

  const saveKeys = async (next: string[]) => {
    unwrap(
      await api().models.PlanTemplate.update({ id: template.id, imageKeys: next })
    );
    setKeys(next);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api().mutations.getTemplateImageUploadUrl({
        templateId: template.id,
        contentType: file.type || "image/jpeg",
      });
      const target = opResult<{ key: string; uploadUrl: string }>(res);
      if (!target?.uploadUrl) throw new Error("Could not get an upload URL");
      const put = await fetch(target.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "image/jpeg" },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      await saveKeys([...keys, target.key]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="photo-block">
      {keys.length ? (
        <div className="photo-grid">
          {keys.map((key) => (
            <div key={key} className="photo-thumb">
              {urls[key] ? (
                <img src={urls[key]} alt="Pest" loading="lazy" />
              ) : (
                <div className="photo-loading" />
              )}
              <button
                type="button"
                className="photo-remove"
                aria-label="Remove photo"
                onClick={() => {
                  if (!window.confirm("Remove this photo from the template?")) return;
                  void saveKeys(keys.filter((k) => k !== key)).catch((err) =>
                    setError(err instanceof Error ? err.message : "Remove failed")
                  );
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
      />
      <Button small variant="subtle" loading={busy} onClick={() => fileInput.current?.click()}>
        📷 Add pest photo
      </Button>
      <ErrorNote error={error} />
    </div>
  );
}
