import { useEffect, useState } from "react";
import { api, opResult, unwrap, type Customer, type PlanTemplate } from "../lib/api";
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
  onDone,
}: {
  customer: Customer;
  onDone: () => Promise<void>;
}) {
  const [templates, setTemplates] = useState<PlanTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [overriding, setOverriding] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
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
          setPrice(
            active[0].priceCents != null
              ? (active[0].priceCents / 100).toString()
              : ""
          );
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Could not load templates")
      );
  }, []);

  const template = templates?.find((t) => t.id === templateId) ?? null;
  // A template with no list price is priced by the engine from the rate card.
  // Typing a number from memory beside it is the bypass this screen used to be.
  const enginePriced = template != null && template.priceCents == null;
  const listCents = template?.priceCents ?? null;
  const cents = Math.round(parseFloat(price) * 100);
  const deviates =
    listCents != null && Number.isFinite(cents) && cents !== listCents;

  const go = async (sendNow: boolean) => {
    if (!template) {
      setError("Pick a plan template");
      return;
    }
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
      const quote = opResult<{ quoteId?: string }>(
        await api().mutations.quoteFromTemplate({
          customerId: customer.id,
          planTemplateId: template.id,
          priceCents: cents,
          priceOverrideReason: deviates ? overrideReason.trim() : undefined,
          notes: notes.trim() || undefined,
        })
      );
      if (!quote?.quoteId) throw new Error("Could not create the quote");

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
      const agreement = opResult<{ agreementId?: string }>(
        await api().mutations.authorAgreement({
          customerId: customer.id,
          quoteId: quote.quoteId,
          title: template.agreementTitle,
          bodyText,
          imageKeys: (template.imageKeys ?? []).filter(
            (k): k is string => typeof k === "string"
          ),
        })
      );
      if (!agreement?.agreementId) {
        throw new Error("Could not create the agreement");
      }
      if (sendNow) {
        const sendResult = opResult<{ sent: boolean; link?: string }>(
          await api().mutations.sendAgreement({ agreementId: agreement.agreementId })
        );
        if (!sendResult?.sent) {
          throw new Error(
            sendResult?.link
              ? `The signing email failed to send — share this link manually: ${sendResult.link}`
              : "The signing email failed to send — check the email address and resend from the Agreements card."
          );
        }
        unwrap(await api().models.Quote.update({ id: quote.quoteId, status: "SENT" }));
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
            if (t) setPrice(t.priceCents != null ? (t.priceCents / 100).toString() : "");
          }}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}{t.priceCents != null ? ` — ${money(t.priceCents)}/mo` : " — AI-priced"}
            </option>
          ))}
        </select>
      </Field>
      {template?.description ? (
        <p className="muted small">{template.description}</p>
      ) : null}
      {enginePriced ? (
        // Never render an empty price box. This template's price comes from the
        // rate card; an empty field beside it invites a number from memory,
        // which is the whole thing the pricing engine exists to prevent.
        <p className="muted small" style={{ margin: 0 }}>
          <strong>{template?.name}</strong> is priced by the rate card, not by
          hand. Close this and use <strong>⚡ Price a lead</strong> so the engine
          sets the number.
        </p>
      ) : (
        <>
          <Field label="Monthly price">
            {overriding ? (
              <input
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
              />
            ) : (
              <input value={listCents != null ? money(listCents) : ""} readOnly />
            )}
          </Field>
          {overriding ? (
            <Field
              label="Why is this not the list price?"
              hint="Recorded on the quote with your name against it"
            >
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Matched a competitor quote — agreed with Jake"
              />
            </Field>
          ) : (
            <Button
              small
              variant="ghost"
              onClick={() => setOverriding(true)}
            >
              Charge something other than {listCents != null ? money(listCents) : "the list price"}
            </Button>
          )}
        </>
      )}
      <Field label="Notes (internal)">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <div className="form-row-2">
        <Button
          variant="ghost"
          loading={busy === "draft"}
          disabled={enginePriced || (deviates && !overrideReason.trim())}
          onClick={() => void go(false)}
        >
          Save draft
        </Button>
        <Button
          loading={busy === "send"}
          disabled={enginePriced || (deviates && !overrideReason.trim())}
          onClick={() => void go(true)}
        >
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
