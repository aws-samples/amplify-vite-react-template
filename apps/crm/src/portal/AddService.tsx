import { useEffect, useMemo, useState } from "react";
import { api, opResult, type Customer } from "../lib/api";
import { useRoles } from "../lib/auth";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Page,
  SegControl,
  Spinner,
  SuccessNote,
} from "../ui/kit";
import { loadMyCustomers } from "./portalData";

/**
 * Portal add-a-service: a logged-in customer prices and books an ADDITIONAL
 * service on their own account. It reuses the public booking engine wholesale
 * — the CRM never talks to booking-public directly. Both calls go through the
 * CUSTOMER-gated createSetupIntent mutation (an `action` discriminator, no new
 * AppSync op); crm-billing verifies ownership and invokes booking-public, which
 * prices against the customer's address on file and, for the booking, charges
 * the card on file off-session and finalizes. The quote binds to this customer
 * (leadCustomerId), so the new visit/plan lands on their account.
 */

type ServiceCode =
  | "GENERAL_PEST"
  | "WASP_NEST"
  | "RODENT"
  | "ROACH"
  | "TERMITE"
  | "WILDLIFE"
  | "MOSQUITO"
  | "MOSQUITO_TICK";

type PropertyKind = "RESIDENTIAL" | "COMMUNITY" | "COMMERCIAL";

const SERVICES: { code: ServiceCode; label: string }[] = [
  { code: "GENERAL_PEST", label: "General pest control" },
  { code: "MOSQUITO", label: "Mosquito plan (Apr–Oct)" },
  { code: "MOSQUITO_TICK", label: "Mosquito + tick plan (Apr–Oct)" },
  { code: "WASP_NEST", label: "Wasp / hornet nest removal" },
  { code: "RODENT", label: "Rodent treatment" },
  { code: "ROACH", label: "Roach treatment" },
  { code: "TERMITE", label: "Termite inspection & treatment" },
  { code: "WILDLIFE", label: "Wildlife removal" },
];

const SEASONAL = new Set<ServiceCode>(["MOSQUITO", "MOSQUITO_TICK"]);

type Needs = {
  sqft: boolean;
  units: boolean;
  lotHalfAcres: boolean;
  nestCount: boolean;
};

/** Mirrors the funnel's quoteFieldNeeds: property kind can override the
 *  service's own needs (community → units, commercial → sqft). */
function needsFor(service: ServiceCode, kind: PropertyKind): Needs {
  const none = { sqft: false, units: false, lotHalfAcres: false, nestCount: false };
  if (SEASONAL.has(service)) return { ...none, lotHalfAcres: true };
  if (service === "WASP_NEST") return { ...none, nestCount: true };
  if (service === "WILDLIFE") return none; // removal kind/count — office follow-up
  if (kind === "COMMUNITY") return { ...none, units: true };
  if (kind === "COMMERCIAL") return { ...none, sqft: true };
  if (service === "GENERAL_PEST" || service === "RODENT" || service === "ROACH" || service === "TERMITE") {
    return { ...none, sqft: true };
  }
  return none;
}

function money(cents: number): string {
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

const onlyDigits = (s: string) => s.replace(/\D+/g, "");

type PricedDay = { date: string; priceCents: number };
type RecurringOffer = {
  frequency: string;
  monthlyCents: number;
  initialFeeCents: number;
};
type QuoteResult = {
  decision: string;
  bookingId?: string;
  service?: string;
  days?: PricedDay[];
  recurringOffer?: RecurringOffer | null;
  planOnly?: boolean;
  requestedFrequency?: string | null;
  terms?: { version: string; text: string };
  message?: string;
};
type BookResult = {
  booked?: boolean;
  processing?: boolean;
  amountCents?: number;
  summary?: string;
};

/** The createSetupIntent mutation carries the portal add-service actions too.
 *  Typed via a cast because the generated client types trail a schema deploy. */
function addServiceMutation() {
  return (
    api().mutations as unknown as {
      createSetupIntent: (a: {
        customerId: string;
        action: string;
        payload: unknown;
      }) => Promise<{ data: unknown; errors?: { message: string }[] }>;
    }
  ).createSetupIntent;
}

export default function PortalAddService() {
  const roles = useRoles();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [service, setService] = useState<ServiceCode>("GENERAL_PEST");
  const [propertyKind, setPropertyKind] = useState<PropertyKind>("RESIDENTIAL");
  const [sqft, setSqft] = useState("");
  const [units, setUnits] = useState("");
  const [lotHalfAcres, setLotHalfAcres] = useState("1");
  const [nestCount, setNestCount] = useState("1");
  const [recurringPreference, setRecurringPreference] = useState("");

  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [plan, setPlan] = useState<"ONE_TIME" | "PLAN">("ONE_TIME");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<string | null>(null);

  useEffect(() => {
    if (roles.loading) return;
    (async () => {
      try {
        const mine = await loadMyCustomers(roles);
        setCustomers(mine);
        if (mine.length && !customerId) setCustomerId(mine[0].id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load your account");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);

  const customer = useMemo(
    () => customers?.find((c) => c.id === customerId) ?? null,
    [customers, customerId]
  );
  const needs = needsFor(service, propertyKind);
  const seasonal = SEASONAL.has(service);

  const resetQuote = () => {
    setQuote(null);
    setSelDate(null);
    setPlan("ONE_TIME");
    setAccepted(false);
    setBooked(null);
  };

  const getPrice = async () => {
    if (!customer) return;
    setBusy(true);
    setError(null);
    resetQuote();
    try {
      const input: Record<string, unknown> = {
        name: customer.contactName || customer.displayName,
        email: customer.email,
        service,
        propertyKind,
        address: {
          street: customer.serviceStreet,
          city: customer.serviceCity,
          state: customer.serviceState,
          zip: customer.serviceZip,
        },
        recurringPreference,
      };
      if (needs.sqft) input.sqft = parseInt(sqft, 10) || undefined;
      if (needs.units) input.units = parseInt(units, 10) || undefined;
      if (needs.lotHalfAcres) input.lotHalfAcres = parseInt(lotHalfAcres, 10) || 1;
      if (needs.nestCount) input.nestCount = parseInt(nestCount, 10) || 1;

      const res = opResult<QuoteResult>(
        await addServiceMutation()({
          customerId: customer.id,
          action: "ADD_SERVICE_QUOTE",
          payload: input,
        })
      );
      if (!res || res.decision !== "PRICED" || !res.bookingId) {
        setError(
          res?.message ||
            "We couldn't price this one instantly — the office will follow up with a quote. Nothing was charged."
        );
        return;
      }
      setQuote(res);
      // Default the choice the way the funnel does: a requested plan leads.
      const wantsPlan =
        Boolean(res.recurringOffer) &&
        (res.planOnly ||
          (res.requestedFrequency &&
            res.recurringOffer?.frequency === res.requestedFrequency));
      setPlan(wantsPlan ? "PLAN" : "ONE_TIME");
      if (res.days?.length) setSelDate(res.days[0].date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not get a price");
    } finally {
      setBusy(false);
    }
  };

  const confirmBooking = async () => {
    if (!customer || !quote?.bookingId || !selDate) return;
    setBusy(true);
    setError(null);
    try {
      const res = opResult<BookResult>(
        await addServiceMutation()({
          customerId: customer.id,
          action: "ADD_SERVICE_BOOK",
          payload: {
            bookingId: quote.bookingId,
            date: selDate,
            recurring: plan === "PLAN",
            tcAccepted: true,
            tcVersion: quote.terms?.version,
          },
        })
      );
      if (!res?.booked) {
        setError("The booking didn't complete — nothing was charged. Please try again.");
        return;
      }
      setBooked(
        res.processing
          ? "You're booked — your bank payment is clearing and we'll email your confirmation."
          : `You're booked${res.summary ? ` — ${res.summary}` : ""}. A receipt is on its way to your email.`
      );
      setQuote(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The booking didn't go through");
    } finally {
      setBusy(false);
    }
  };

  if (!customers) {
    return (
      <Page title="Add a service" back="/portal">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  if (customers.length === 0) {
    return (
      <Page title="Add a service" back="/portal">
        <Card>
          <p className="muted small">
            Your login isn&rsquo;t linked to a customer account yet — give the
            BuzzKill office a call and we&rsquo;ll get you set up.
          </p>
        </Card>
      </Page>
    );
  }

  const offer = quote?.recurringOffer ?? null;

  return (
    <Page title="Add a service" back="/portal">
      {booked ? <SuccessNote message={booked} /> : null}

      <Card title="What do you need?">
        {customers.length > 1 ? (
          <Field label="For">
            <select
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                resetQuote();
              }}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label="Service">
          <select
            value={service}
            onChange={(e) => {
              setService(e.target.value as ServiceCode);
              resetQuote();
            }}
          >
            {SERVICES.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Property type" group>
          <SegControl<PropertyKind>
            options={[
              { value: "RESIDENTIAL", label: "Home" },
              { value: "COMMUNITY", label: "Condo / HOA" },
              { value: "COMMERCIAL", label: "Commercial" },
            ]}
            value={propertyKind}
            onChange={(v) => {
              setPropertyKind(v);
              resetQuote();
            }}
          />
        </Field>

        {needs.sqft ? (
          <Field label="Square footage">
            <input
              inputMode="numeric"
              value={sqft}
              onChange={(e) => setSqft(onlyDigits(e.target.value).slice(0, 5))}
              placeholder="2400"
            />
          </Field>
        ) : null}
        {needs.units ? (
          <Field label="How many units?">
            <input
              inputMode="numeric"
              value={units}
              onChange={(e) => setUnits(onlyDigits(e.target.value).slice(0, 5))}
              placeholder="48"
            />
          </Field>
        ) : null}
        {needs.lotHalfAcres ? (
          <Field label="Yard size">
            <select value={lotHalfAcres} onChange={(e) => setLotHalfAcres(e.target.value)}>
              <option value="1">Up to ½ acre</option>
              <option value="2">Up to 1 acre</option>
              <option value="3">Up to 1½ acres</option>
              <option value="4">Up to 2 acres</option>
              <option value="6">Up to 3 acres</option>
              <option value="8">Up to 4 acres</option>
            </select>
          </Field>
        ) : null}
        {needs.nestCount ? (
          <Field label="How many nests?">
            <input
              inputMode="numeric"
              value={nestCount}
              onChange={(e) => setNestCount(onlyDigits(e.target.value).slice(0, 2))}
              placeholder="1"
            />
          </Field>
        ) : null}

        {!seasonal && service !== "WASP_NEST" && service !== "WILDLIFE" ? (
          <Field label="How often?">
            <select
              value={recurringPreference}
              onChange={(e) => {
                setRecurringPreference(e.target.value);
                resetQuote();
              }}
            >
              <option value="">One-time visit</option>
              <option value="QUARTERLY">Quarterly plan</option>
              <option value="BIMONTHLY">Every-2-months plan</option>
              <option value="MONTHLY">Monthly plan</option>
            </select>
          </Field>
        ) : null}

        <p className="muted small">
          We&rsquo;ll price this for {customer?.serviceStreet ?? "your address on file"}.
        </p>
        <Button block loading={busy && !quote} onClick={() => void getPrice()}>
          Get my price
        </Button>
      </Card>

      {quote ? (
        <Card title="Your price">
          {offer && (quote.planOnly || plan === "PLAN") ? (
            <p className="small">
              <strong>{money(offer.initialFeeCents)}</strong> today, then{" "}
              <strong>{money(offer.monthlyCents)}/mo</strong> — the plan starts
              after your first completed visit.
            </p>
          ) : selDate && quote.days ? (
            <p className="small">
              <strong>
                {money(quote.days.find((d) => d.date === selDate)?.priceCents ?? 0)}
              </strong>{" "}
              one-time, charged to your card on file.
            </p>
          ) : null}

          {offer && !quote.planOnly ? (
            <Field label="One-time or a plan?" group>
              <SegControl<"ONE_TIME" | "PLAN">
                options={[
                  { value: "ONE_TIME", label: "One-time" },
                  {
                    value: "PLAN",
                    label: `${money(offer.monthlyCents)}/mo plan`,
                  },
                ]}
                value={plan}
                onChange={setPlan}
              />
            </Field>
          ) : null}

          {quote.days?.length ? (
            <Field label={quote.planOnly || plan === "PLAN" ? "First visit day" : "Pick a day"}>
              <select value={selDate ?? ""} onChange={(e) => setSelDate(e.target.value)}>
                {quote.days.map((d) => (
                  <option key={d.date} value={d.date}>
                    {new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          {quote.terms ? (
            <label className="field" style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />
              <span className="small muted">
                I accept the terms &amp; cancellation policy and authorize
                BuzzKill to charge my card on file for this service.
              </span>
            </label>
          ) : null}

          <ErrorNote error={error} />
          <Button
            block
            loading={busy}
            disabled={!accepted || !selDate}
            onClick={() => void confirmBooking()}
          >
            Add &amp; pay with card on file
          </Button>
        </Card>
      ) : (
        <ErrorNote error={error} />
      )}
    </Page>
  );
}
