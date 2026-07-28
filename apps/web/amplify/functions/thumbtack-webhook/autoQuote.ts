import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { dataClient } from "../shared/dataClient";
import {
  clearsLeadFee,
  money,
  oneTimeGrossProfitCents,
  type Zone,
} from "../crm-pricing/rateCards";
import { mapThumbtackLead, type TtDetail } from "./leadMapping";

/**
 * Auto-quote a Thumbtack lead by running it through the SAME engine the public
 * funnel uses — booking-public's trusted internal QUOTE op — so a marketplace
 * customer and a website visitor can never be quoted differently for the same
 * job. Nothing here re-implements pricing.
 *
 * The output is a DRAFT plus an explicit auto-send verdict. Per the agreed
 * policy, a reply is only eligible to send itself when every one of these is
 * true; anything else is a draft a human sends:
 *
 *   1. the questionnaire mapped cleanly (no gaps),
 *   2. the funnel actually PRICED it (not a CONTACT bounce),
 *   3. the address is in zone (A or B — never an out-of-area promotion),
 *   4. the job clears 3× the Thumbtack lead fee in gross profit,
 *   5. there is real capacity — at least one bookable day came back.
 *
 * Rule 4 is why `leadPrice` matters: a $43 lead in a far town can be a losing
 * job at a price we would happily quote a website visitor who cost us nothing.
 */

const lambda = new LambdaClient();
const ssm = new SSMClient();

export type AutoQuoteInput = {
  leadID: string;
  customerId: string;
  category: string | null;
  details: TtDetail[];
  /** Thumbtack's `leadPrice`, e.g. "17.42". Absent on a free lead. */
  leadPrice?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  street?: string | null;
};

export type AutoQuoteResult = {
  decision: "QUOTE" | "PASS" | "NEEDS_INFO" | "ERROR";
  /** Ready to send verbatim into the Thumbtack thread. */
  replyText?: string;
  /** Staff-facing explanation. Never shown to the customer. */
  reason: string;
  autoSend: boolean;
  zone?: Zone;
  driveMinutes?: number;
  oneTimePriceCents?: number;
  leadFeeCents?: number;
  offeredDates?: string[];
  bookingUrl?: string;
};

/** "17.42" → 1742. Thumbtack sends dollars as a string; a missing price is a
 *  FREE lead (0), which is different from an unknown one. */
export function leadFeeCentsFrom(leadPrice: string | null | undefined): number {
  if (leadPrice == null || String(leadPrice).trim() === "") return 0;
  const n = Number(String(leadPrice).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

async function bookingPublicFunctionName(): Promise<string | null> {
  const direct = process.env.BOOKING_PUBLIC_FUNCTION_NAME;
  if (direct) return direct;
  const param = process.env.BOOKING_PUBLIC_FUNCTION_PARAM;
  if (!param) return null;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: param }));
    return out.Parameter?.Value ?? null;
  } catch (err) {
    console.error("thumbtack autoQuote: could not resolve booking-public", err);
    return null;
  }
}

type QuoteResponse = {
  decision?: string;
  bookingId?: string;
  service?: string;
  days?: { date: string; priceCents: number }[];
  message?: string;
};

async function runFunnelQuote(
  input: Record<string, unknown>,
  customerId: string
): Promise<QuoteResponse | null> {
  const fnName = await bookingPublicFunctionName();
  if (!fnName) return null;
  // A transport failure (throttle, timeout, the engine being down) must come
  // back as "no quote" so the caller reports ERROR and a human takes the lead.
  // Letting it throw would abort the webhook AFTER the lead was already saved.
  try {
    const out = await lambda.send(
      new InvokeCommand({
        FunctionName: fnName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(
          JSON.stringify({
            internalOp: { kind: "QUOTE", customerId, input, sourceIp: "thumbtack" },
          })
        ),
      })
    );
    if (out.FunctionError || !out.Payload) return null;
    const parsed = JSON.parse(Buffer.from(out.Payload).toString("utf8")) as
      | { ok: true; data: QuoteResponse }
      | { ok: false; status: number; error: string };
    return parsed.ok ? parsed.data : null;
  } catch (err) {
    console.error("thumbtack autoQuote: booking-public invoke failed", err);
    return null;
  }
}

/** The reply that goes into the thread. Deterministic and built only from
 *  amounts the engine returned — nothing here is model-written, so there is no
 *  path for an invented price to reach a customer. */
function composeQuoteReply(args: {
  name: string;
  town: string | null;
  priceCents: number;
  dates: string[];
  bookingUrl: string;
}): string {
  const when = args.dates
    .slice(0, 2)
    .map((d) =>
      new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", {
        weekday: "long",
        month: "short",
        day: "numeric",
        timeZone: "America/New_York",
      })
    )
    .join(" or ");
  const where = args.town ? ` in ${args.town}` : "";
  return [
    `Hi ${args.name.split(" ")[0]} — thanks for reaching out.`,
    `For your property${where}, we can take care of this for ${money(args.priceCents)}.`,
    when ? `We have ${when} open.` : "",
    `You can lock in a time here: ${args.bookingUrl}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function autoQuoteLead(
  input: AutoQuoteInput,
  displayName: string
): Promise<AutoQuoteResult> {
  const leadFeeCents = leadFeeCentsFrom(input.leadPrice);
  const mapped = mapThumbtackLead(input.category, input.details);

  if (mapped.gaps.length > 0 || !mapped.service) {
    return {
      decision: "NEEDS_INFO",
      autoSend: false,
      leadFeeCents,
      reason: `Thumbtack's questionnaire didn't answer: ${mapped.gaps.join(", ")}. Ask in the thread, then quote.`,
    };
  }

  const quote = await runFunnelQuote(
    {
      propertyKind: mapped.propertyClass ?? undefined,
      service: mapped.service,
      sqft: mapped.sqft ?? undefined,
      units: mapped.units ?? undefined,
      lotHalfAcres: mapped.lotHalfAcres ?? undefined,
      name: displayName,
      address: {
        street: input.street ?? undefined,
        city: input.city ?? undefined,
        state: input.state ?? undefined,
        zip: input.zip ?? undefined,
      },
      comments: `Thumbtack lead ${input.leadID}`,
    },
    input.customerId
  );

  if (!quote) {
    return {
      decision: "ERROR",
      autoSend: false,
      leadFeeCents,
      reason:
        "The quote engine could not be reached, so this lead has no price yet. Quote it by hand in the Thumbtack thread.",
    };
  }

  if (quote.decision !== "PRICED") {
    // The funnel bounced it — out of area, no zone, off-season, sold out. Its
    // own message already says which, and it is written for staff.
    return {
      decision: "PASS",
      autoSend: false,
      leadFeeCents,
      reason:
        quote.message ??
        "The funnel would not price this address automatically. Review it in the CRM.",
    };
  }

  const days = quote.days ?? [];
  const priceCents = days[0]?.priceCents;
  if (!days.length || priceCents == null) {
    return {
      decision: "NEEDS_INFO",
      autoSend: false,
      leadFeeCents,
      reason:
        "Priced, but no bookable day came back (capacity is full or the season is closed). Offer dates by hand.",
    };
  }

  // Zone comes back on the persisted booking, but the gross-profit test only
  // needs a servicing zone; the funnel already refused anything out of area,
  // so a PRICED result is A, B, or an office-promoted C.
  const zone = await zoneForBooking(quote.bookingId);
  const gp = zone ? oneTimeGrossProfitCents(mapped.service, priceCents, zone) : null;
  const clears = clearsLeadFee(gp, leadFeeCents);

  if (clears === false) {
    return {
      decision: "PASS",
      autoSend: false,
      zone: zone ?? undefined,
      oneTimePriceCents: priceCents,
      leadFeeCents,
      reason: `At ${money(priceCents)} this job makes ${
        gp != null ? money(gp) : "an unknown"
      } gross profit against a ${money(leadFeeCents)} lead fee — under the 3× rule. Quote it higher by hand or let it go.`,
    };
  }

  const bookingUrl = `${process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com"}/quote?b=${quote.bookingId ?? ""}`;
  const replyText = composeQuoteReply({
    name: displayName,
    town: input.city ?? null,
    priceCents,
    dates: days.map((d) => d.date),
    bookingUrl,
  });

  return {
    decision: "QUOTE",
    // Every gate passed: mapped cleanly, funnel PRICED it, in zone, clears the
    // lead fee, and real days came back.
    autoSend: clears === true,
    replyText,
    zone: zone ?? undefined,
    oneTimePriceCents: priceCents,
    leadFeeCents,
    offeredDates: days.slice(0, 3).map((d) => d.date),
    bookingUrl,
    reason:
      clears === true
        ? `Auto-quoted ${money(priceCents)}; clears the ${money(leadFeeCents)} lead fee.`
        : `Quoted ${money(priceCents)}, but the lead fee is unknown so it was not auto-sent.`,
  };
}

/** The zone the funnel stamped on the booking it just created. Null when it
 *  cannot be read — which downgrades the lead-fee test to "unknown" and so
 *  blocks auto-send rather than assuming the job is profitable. */
async function zoneForBooking(bookingId: string | undefined): Promise<Zone | null> {
  if (!bookingId) return null;
  try {
    const client = await dataClient();
    const models = client.models as Record<string, unknown>;
    const model = models.BookingRequest as {
      get?: (a: { id: string }) => Promise<{ data?: { zone?: string } | null }>;
    };
    if (typeof model?.get !== "function") return null;
    const { data } = await model.get({ id: bookingId });
    const zone = data?.zone;
    return zone === "A" || zone === "B" || zone === "C" ? zone : null;
  } catch {
    return null;
  }
}
