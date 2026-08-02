/**
 * The ONE shape of `BookingRequest.quoteJson`, and the only way to read it.
 *
 * `quoteJson` is an `a.json()` field, so what comes back is whatever was
 * written — possibly by an older deploy, possibly hand-edited, possibly from a
 * code path that no longer exists. Nine call sites used to each declare their
 * own inline shape and `as`-cast the parse into it. Two of those declarations
 * omitted `initialFeeCents`, and none of them validated: a stored
 * `recurringOffer: { frequency: "MONTHLY" }` satisfied every "is the offer
 * present?" guard in /book and then produced `undefined` where a cents amount
 * was required — i.e. `NaN` as the amount charged to a card.
 *
 * So parsing here is STRUCTURAL, not a cast. A piece that does not carry the
 * fields money math needs is returned as absent rather than as a
 * partially-filled object. That deliberately routes malformed data into the
 * callers' EXISTING "no such day" / "no plan was offered" refusals, which
 * already say the right thing to the customer — rather than inventing a new
 * error path, and rather than letting a half-shape reach Stripe.
 *
 * Pure leaf: no imports, so both Lambdas and the CRM can value-import it.
 */

/** A quoted day. Extra fields the pricer stamped (slot feasibility, the audit
 *  `factors` trail) are preserved verbatim — this type constrains only what
 *  readers actually consume. */
export type QuoteSnapshotDay = {
  date: string;
  priceCents: number;
  slot?: unknown;
  factors?: string[];
};

/** The recurring plan offered alongside the dated prices. All three fields are
 *  required: `initialFeeCents` is what /book charges at checkout, and an offer
 *  missing it cannot price a first month. */
export type QuoteSnapshotRecurringOffer = {
  frequency: string;
  monthlyCents: number;
  initialFeeCents: number;
};

export type QuoteSnapshot = {
  /** Null when the quote never priced any day (a contact-only quote, or an
   *  off-season enrollment). Never an empty-but-present array. */
  days: QuoteSnapshotDay[] | null;
  baseCents: number | null;
  recurringOffer: QuoteSnapshotRecurringOffer | null;
  serviceLabel?: string;
  planOnly?: boolean;
  offSeason?: boolean;
  /** Set instead of prices when the funnel could not quote automatically. */
  contactMessage?: string;
};

/** Money must be a finite whole number of cents. Rejects NaN, Infinity, null,
 *  numeric strings, and fractional cents — every one of which would otherwise
 *  reach a charge amount. */
function centsOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A day is usable only if it can be both matched by date and charged. */
function parseDay(raw: unknown): QuoteSnapshotDay | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const date = nonEmptyString(row.date);
  const priceCents = centsOrNull(row.priceCents);
  if (date === null || priceCents === null) return null;
  // Spread first so a malformed `date`/`priceCents` cannot survive, but every
  // other stamped field (slot, factors) rides along untouched.
  return { ...row, date, priceCents } as QuoteSnapshotDay;
}

/** All-or-nothing: a partial offer is worse than no offer, because callers
 *  test the offer's PRESENCE before pricing off its fields. */
function parseRecurringOffer(raw: unknown): QuoteSnapshotRecurringOffer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const frequency = nonEmptyString(row.frequency);
  const monthlyCents = centsOrNull(row.monthlyCents);
  const initialFeeCents = centsOrNull(row.initialFeeCents);
  if (frequency === null || monthlyCents === null || initialFeeCents === null) {
    return null;
  }
  return { frequency, monthlyCents, initialFeeCents };
}

/**
 * Read a stored `quoteJson`. Accepts the raw column value — a JSON string, an
 * already-parsed object (AppSync hands `a.json()` arguments over parsed), null,
 * or garbage. Never throws.
 */
export function parseQuoteSnapshot(raw: unknown): QuoteSnapshot {
  const empty: QuoteSnapshot = { days: null, baseCents: null, recurringOffer: null };
  if (raw === null || raw === undefined || raw === "") return empty;

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

  const row = parsed as Record<string, unknown>;
  const days = Array.isArray(row.days)
    ? row.days.map(parseDay).filter((d): d is QuoteSnapshotDay => d !== null)
    : [];

  const snapshot: QuoteSnapshot = {
    // An empty list and an absent list mean the same thing to every caller
    // ("no day is bookable"), so collapse them rather than making each site
    // check both.
    days: days.length > 0 ? days : null,
    baseCents: centsOrNull(row.baseCents),
    recurringOffer: parseRecurringOffer(row.recurringOffer),
  };

  const serviceLabel = nonEmptyString(row.serviceLabel);
  if (serviceLabel !== null) snapshot.serviceLabel = serviceLabel;
  const contactMessage = nonEmptyString(row.contactMessage);
  if (contactMessage !== null) snapshot.contactMessage = contactMessage;
  if (row.planOnly === true) snapshot.planOnly = true;
  if (row.offSeason === true) snapshot.offSeason = true;

  return snapshot;
}

/**
 * Write a `quoteJson` column value. `a.json()` model fields take a STRING —
 * handing AppSync the object itself is rejected with "Variable 'quoteJson' has
 * an invalid value", so every writer goes through here.
 */
export function serializeQuoteSnapshot(snapshot: {
  days?: readonly QuoteSnapshotDay[] | null;
  baseCents?: number | null;
  recurringOffer?: QuoteSnapshotRecurringOffer | null;
  serviceLabel?: string;
  planOnly?: boolean;
  offSeason?: boolean;
  contactMessage?: string;
}): string {
  return JSON.stringify({
    days: snapshot.days ?? undefined,
    baseCents: snapshot.baseCents ?? undefined,
    serviceLabel: snapshot.serviceLabel,
    recurringOffer: snapshot.recurringOffer ?? undefined,
    planOnly: snapshot.planOnly || undefined,
    offSeason: snapshot.offSeason || undefined,
    contactMessage: snapshot.contactMessage,
  });
}
