import { useEffect, useState } from "react";
import { api, listAll, type Customer, type MarketRate } from "../lib/api";
import {
  areaKeyFor,
  planPrefill,
  selectPlanRate,
  sqftBucket,
  type PlanCadence,
  type PlanPrefill,
} from "../lib/marketRates";
import { fmtDate, money } from "../lib/format";
import { Badge, Field, SegControl } from "../ui/kit";

/**
 * Shared service + frequency + size picker for recurring-plan pricing. The
 * price it suggests comes from the cached AI market-rate sheet for the
 * customer's area — the same rows the public funnel quotes from — read
 * client-side. When no cached rate exists it says so honestly; the caller
 * offers hand pricing with a reason as the only other path.
 */

/** The services sold as recurring plans (one-time work goes through jobs). */
export type PlanService = "GENERAL_PEST" | "HOA";

export const PLAN_NAME: Record<PlanService, string> = {
  GENERAL_PEST: "General pest protection",
  HOA: "Association / HOA common areas",
};

export type PlanPricing = {
  service: PlanService;
  setService: (s: PlanService) => void;
  frequency: PlanCadence;
  setFrequency: (f: PlanCadence) => void;
  size: string;
  setSize: (s: string) => void;
  /** null while the rates are loading. */
  rates: MarketRate[] | null;
  loadError: string | null;
  planName: string;
  areaKey: string | null;
  sizeCount: number | null;
  rate: MarketRate | null;
  prefill: PlanPrefill | null;
};

export function usePlanPricing(customer: Customer): PlanPricing {
  const [service, setServiceState] = useState<PlanService>("GENERAL_PEST");
  const [frequency, setFrequency] = useState<PlanCadence>("QUARTERLY");
  const [size, setSize] = useState("2000");
  const [rates, setRates] = useState<MarketRate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    listAll<MarketRate>((t) =>
      api().models.MarketRate.list({ limit: 500, nextToken: t })
    )
      .then(setRates)
      .catch((err) => {
        setRates([]);
        setLoadError(
          err instanceof Error ? err.message : "Could not load market rates"
        );
      });
  }, []);

  const setService = (s: PlanService) => {
    setServiceState(s);
    // sqft and unit counts are different animals — never carry one across.
    setSize(s === "GENERAL_PEST" ? "2000" : "");
  };

  const areaKey =
    customer.serviceCity && customer.serviceState
      ? areaKeyFor(customer.serviceCity, customer.serviceState)
      : null;
  const parsed = parseInt(size, 10);
  const sizeCount = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  // HOA rows carry no key band — every unit band lives inside the one sheet
  // (the unit count picks the band in planPrefill). Sqft services band the
  // key itself.
  const canLookUp = service === "HOA" || sizeCount != null;
  const rate =
    rates && areaKey && canLookUp
      ? selectPlanRate(
          rates,
          service,
          areaKey,
          service === "HOA" ? null : sqftBucket(sizeCount!)
        )
      : null;
  const prefill = rate
    ? planPrefill(rate, frequency, {
        units: service === "HOA" ? sizeCount : null,
      })
    : null;

  return {
    service,
    setService,
    frequency,
    setFrequency,
    size,
    setSize,
    rates,
    loadError,
    planName: PLAN_NAME[service],
    areaKey,
    sizeCount,
    rate,
    prefill,
  };
}

export function PlanPricingFields({ p }: { p: PlanPricing }) {
  return (
    <>
      <Field label="Service">
        <SegControl
          options={[
            { value: "GENERAL_PEST" as const, label: "General pest" },
            { value: "HOA" as const, label: "Association / HOA" },
          ]}
          value={p.service}
          onChange={p.setService}
        />
      </Field>
      <Field label="Visit frequency">
        <SegControl
          options={[
            { value: "MONTHLY" as const, label: "Monthly" },
            { value: "BIMONTHLY" as const, label: "Bi-monthly" },
            { value: "QUARTERLY" as const, label: "Quarterly" },
          ]}
          value={p.frequency}
          onChange={p.setFrequency}
        />
      </Field>
      <Field
        label={p.service === "HOA" ? "Units in the association" : "Home size (sqft)"}
        hint="Picks the AI rate band for this quote"
      >
        <input
          inputMode="numeric"
          value={p.size}
          onChange={(e) => p.setSize(e.target.value.replace(/[^\d]/g, ""))}
          placeholder={p.service === "HOA" ? "40" : "2000"}
        />
      </Field>
      <PrefillNote p={p} />
    </>
  );
}

/** The honest line about where the suggested price came from — or didn't. */
function PrefillNote({ p }: { p: PlanPricing }) {
  if (p.rates === null) return <p className="muted small">Checking cached AI rates…</p>;
  if (!p.areaKey) {
    return (
      <p className="muted small">
        No service city/state on this customer, so there is no area to look a
        rate up for — add the address, or price by hand with a reason.
      </p>
    );
  }
  if (p.sizeCount == null) {
    return (
      <p className="muted small">
        Enter the {p.service === "HOA" ? "unit count" : "home size"} to look up
        the cached AI rate.
      </p>
    );
  }
  if (p.prefill && p.rate) {
    return (
      <p className="muted small">
        AI market rate for <strong>{p.areaKey}</strong>:{" "}
        <strong>{money(p.prefill.monthlyCents)}/mo</strong>
        {p.prefill.initialFeeCents != null
          ? ` + ${money(p.prefill.initialFeeCents)} initial`
          : ""}
        {p.prefill.perUnitMonthlyCents != null
          ? ` (${money(p.prefill.perUnitMonthlyCents)}/unit/mo × ${p.sizeCount})`
          : ""}
        {p.rate.researchedAt ? ` · researched ${fmtDate(p.rate.researchedAt, true)}` : ""}{" "}
        {p.rate.pinned ? <Badge tone="info">pinned by office</Badge> : null}
      </p>
    );
  }
  return (
    <p className="muted small">
      No cached AI rate for {p.areaKey} covers this{" "}
      {p.service === "HOA" ? "unit count" : "size"} yet — the engine researches
      one when the website funnel first quotes it. Until then the only path is
      pricing by hand, with a reason recorded against your name.
      {p.loadError ? ` (${p.loadError})` : ""}
    </p>
  );
}
