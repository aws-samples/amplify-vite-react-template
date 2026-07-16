import { useEffect, useState } from "react";
import {
  createQuoteMutation,
  opResult,
  api,
  unwrap,
  type Customer,
} from "../lib/api";
import {
  DEFAULT_AGREEMENT_BODY,
  DEFAULT_AGREEMENT_TITLE,
  FREQUENCY_LABEL,
  fillAgreementTemplate,
} from "../lib/agreementTemplate";
import { money } from "../lib/format";
import { Button, ErrorNote, Field } from "../ui/kit";
import { PlanPricingFields, usePlanPricing } from "./PlanPricing";

/**
 * Quote a lead: pick service + frequency, and the price prefills from the
 * cached AI market-rate sheet for the customer's area — the same sheet the
 * website funnel quotes from, so the CRM and the site can never disagree.
 * The AI rate rides along as listPriceCents; charging anything else needs a
 * reason, recorded on the quote with your name (the deviation guard is
 * server-side in createQuote, which re-reads the live sheets — there is no
 * quoting without a cached rate, only "Price a lead" to research one). The
 * agreement comes from the code template. Signing converts the lead via the
 * agreement-public backend.
 */
export default function QuoteSheet({
  customer,
  onDone,
}: {
  customer: Customer;
  onDone: () => Promise<void>;
}) {
  const pricing = usePlanPricing(customer);
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [overriding, setOverriding] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [busy, setBusy] = useState<null | "draft" | "send">(null);
  const [error, setError] = useState<string | null>(null);

  const listCents = pricing.prefill?.monthlyCents ?? null;

  // The prefill is the price. Editing it is the exception path (overriding),
  // so the field tracks the AI rate until the office explicitly steps off it.
  useEffect(() => {
    if (!overriding) {
      setPrice(listCents != null ? (listCents / 100).toString() : "");
    }
  }, [listCents, overriding]);

  const cents = Math.round(parseFloat(price) * 100);
  const deviates = Number.isFinite(cents) && cents !== listCents;
  const needsReason = deviates && overrideReason.trim() === "";
  // The server's guard verifies listPriceCents against the live sheets: no
  // cached rate means no quote from this screen, full stop. Price a lead
  // researches one; Market rates lets the office write one.
  const noSheet = listCents == null;

  const go = async (sendNow: boolean) => {
    if (listCents == null) {
      setError("No cached AI rate to quote from");
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
        await createQuoteMutation({
          customerId: customer.id,
          planName: pricing.planName,
          serviceFrequency: pricing.frequency,
          priceCents: cents,
          listPriceCents: listCents,
          initialFeeCents: pricing.prefill?.initialFeeCents ?? undefined,
          priceOverrideReason: deviates ? overrideReason.trim() : undefined,
          // HOA sheet rates are per-unit — the server verifies per-unit × units.
          units:
            pricing.service === "HOA" && pricing.sizeCount != null
              ? pricing.sizeCount
              : undefined,
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
      let bodyText = fillAgreementTemplate(DEFAULT_AGREEMENT_BODY, {
        customerName: customer.displayName,
        planName: pricing.planName,
        price: money(cents),
        frequency: FREQUENCY_LABEL[pricing.frequency] ?? "as scheduled",
        address: address || "the Customer's service address",
      });
      if (pricing.prefill?.initialFeeCents != null) {
        bodyText += `\n\nINITIAL SERVICE VISIT. The first service visit is billed once at ${money(pricing.prefill.initialFeeCents)} and includes the full inspection, interior flush-out, exterior barrier treatment, and web/nest removal.`;
      }
      const agreement = opResult<{ agreementId?: string }>(
        await api().mutations.authorAgreement({
          customerId: customer.id,
          quoteId: quote.quoteId,
          title: DEFAULT_AGREEMENT_TITLE,
          bodyText,
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

  return (
    <div className="form-grid">
      <PlanPricingFields p={pricing} />
      {noSheet ? (
        <p className="muted small">
          There is nothing to quote from until a rate is cached: use{" "}
          <strong>⚡ Price a lead</strong> so the engine researches this
          market, or write the sheet yourself under More → Market rates.
        </p>
      ) : (
        <>
          <Field label="Monthly price">
            {overriding ? (
              <input
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="149.00"
              />
            ) : (
              <input value={money(listCents)} readOnly />
            )}
          </Field>
          {overriding ? (
            <Field
              label="Why is this not the AI rate?"
              hint="Recorded on the quote with your name against it"
            >
              <input
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Matched a competitor quote — agreed with Jake"
              />
            </Field>
          ) : (
            <Button small variant="ghost" onClick={() => setOverriding(true)}>
              Charge something other than {money(listCents)}
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
          disabled={noSheet || needsReason}
          onClick={() => void go(false)}
        >
          Save draft
        </Button>
        <Button
          loading={busy === "send"}
          disabled={noSheet || needsReason}
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
