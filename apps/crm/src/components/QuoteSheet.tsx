import { useEffect, useState } from "react";
import { api, unwrap, type Customer, type PlanTemplate } from "../lib/api";
import {
  FREQUENCY_LABEL,
  fillAgreementTemplate,
} from "../lib/agreementTemplate";
import { money } from "../lib/format";
import { Button, ErrorNote, Field } from "../ui/kit";

/**
 * Quote a lead: pick a plan template, optionally adjust the price, and send
 * the template's agreement for signature. The quote is stored on the lead;
 * signing converts it (lead → ACTIVE customer with a ServicePlan) via the
 * agreement-public backend.
 */
export default function QuoteSheet({
  customer,
  accessGroups,
  onDone,
}: {
  customer: Customer;
  accessGroups: string[];
  onDone: () => Promise<void>;
}) {
  const [templates, setTemplates] = useState<PlanTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<null | "draft" | "send">(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api()
      .models.PlanTemplate.list({ limit: 200 })
      .then((res) => {
        const active = unwrap(res)
          .filter((t) => t.active)
          .sort(
            (a, b) =>
              (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
              a.name.localeCompare(b.name)
          );
        setTemplates(active);
        if (active[0]) {
          setTemplateId(active[0].id);
          setPrice((active[0].priceCents / 100).toString());
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load templates")
      );
  }, []);

  const template = templates?.find((t) => t.id === templateId) ?? null;

  const go = async (sendNow: boolean) => {
    if (!template) {
      setError("Pick a plan template");
      return;
    }
    const cents = Math.round(parseFloat(price) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setError("Enter a valid monthly price");
      return;
    }
    if (sendNow && !customer.email) {
      setError("The lead needs an email address to receive the signing link");
      return;
    }
    setBusy(sendNow ? "send" : "draft");
    setError(null);
    try {
      const quote = unwrap(
        await api().models.Quote.create({
          customerId: customer.id,
          planTemplateId: template.id,
          planName: template.name,
          priceCents: cents,
          serviceFrequency: template.serviceFrequency,
          status: sendNow ? "SENT" : "DRAFT",
          notes: notes.trim() || undefined,
          quotedAt: new Date().toISOString(),
          accessGroups,
        })
      );
      if (!quote) throw new Error("Could not create the quote");

      const address = [
        customer.serviceStreet,
        customer.serviceCity,
        customer.serviceState,
        customer.serviceZip,
      ]
        .filter(Boolean)
        .join(", ");
      const bodyText = fillAgreementTemplate(template.agreementBody, {
        customerName: customer.displayName,
        planName: template.name,
        price: money(cents),
        frequency:
          FREQUENCY_LABEL[template.serviceFrequency ?? ""] ??
          String(template.serviceFrequency ?? "").toLowerCase(),
        address: address || "the Customer's service address",
      });
      const agreement = unwrap(
        await api().models.Agreement.create({
          customerId: customer.id,
          quoteId: quote.id,
          title: template.agreementTitle,
          bodyText,
          status: "DRAFT",
          accessGroups,
        })
      );
      if (!agreement) throw new Error("Could not create the agreement");
      if (sendNow) {
        unwrap(
          await api().mutations.sendAgreement({ agreementId: agreement.id })
        );
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create quote");
      setBusy(null);
    }
  };

  if (templates === null) return <p className="muted">Loading templates…</p>;
  if (templates.length === 0) {
    return (
      <p className="muted">
        No active plan templates yet — create one under More → Plan templates
        first.
      </p>
    );
  }

  return (
    <div className="form-grid">
      <Field label="Plan">
        <select
          value={templateId}
          onChange={(e) => {
            setTemplateId(e.target.value);
            const t = templates.find((x) => x.id === e.target.value);
            if (t) setPrice((t.priceCents / 100).toString());
          }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} — {money(t.priceCents)}/mo
            </option>
          ))}
        </select>
      </Field>
      {template?.description ? (
        <p className="muted small">{template.description}</p>
      ) : null}
      <Field label="Quoted monthly price ($)" hint="Prefilled from the template — adjust if needed">
        <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </Field>
      <Field label="Notes (internal)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <div className="form-row-2">
        <Button variant="ghost" loading={busy === "draft"} onClick={() => void go(false)}>
          Save draft
        </Button>
        <Button loading={busy === "send"} onClick={() => void go(true)}>
          Quote &amp; send agreement
        </Button>
      </div>
      <p className="muted small">
        When the customer signs, the quote converts automatically — the lead
        becomes an active customer with this plan set up.
      </p>
    </div>
  );
}
