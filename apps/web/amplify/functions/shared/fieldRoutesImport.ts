import type { AgreementGroupInput, AgreementInput } from "./agreementImport";

/**
 * Client groups, approved by the owner during onboarding. A row joins a group
 * either because its contact is an office inbox (GIM) or because its
 * Subscription ID is explicitly listed. Membership ties separate FieldRoutes
 * customer records under one CustomerGroup + one portal login.
 */
const GROUP_RULES: Array<
  AgreementGroupInput & { matchEmails?: string[]; matchSubscriptionIds?: string[] }
> = [
  {
    externalId: "gim-property-management",
    name: "GIM Property Management",
    contactName: "GIM Property Management",
    contactEmail: "contact@getgim.com",
    matchEmails: ["contact@getgim.com"],
    // Spruce Hill, 130 High, 39 Johnston, Eagles View, Hadwen Park II —
    // GIM-managed HOAs whose row carries a staff or blank contact, not the
    // shared inbox.
    matchSubscriptionIds: ["115", "57", "58", "51", "52"],
  },
  {
    externalId: "greasley-family",
    name: "Greasley Family",
    contactEmail: "jake@getgim.com",
    matchSubscriptionIds: ["38", "36", "37"], // Jake, Mike, Melvin
  },
  {
    externalId: "lifeward",
    name: "Lifeward",
    contactEmail: "jessenia.sanchez@golifeward.com",
    matchSubscriptionIds: ["85", "91"], // Lifeward office + Jessenia's home
  },
];

/** The group a row belongs to, if any — email-inbox match or explicit id. */
function resolveGroup(r: FieldRoutesRow): AgreementGroupInput | undefined {
  const email = r["Email Address"].trim().toLowerCase();
  const subId = (r["Subscription ID"] ?? "").trim();
  for (const g of GROUP_RULES) {
    if (
      (g.matchEmails ?? []).includes(email) ||
      (g.matchSubscriptionIds ?? []).includes(subId)
    ) {
      return {
        externalId: g.externalId,
        name: g.name,
        contactName: g.contactName,
        contactEmail: g.contactEmail,
        contactPhone: g.contactPhone,
      };
    }
  }
  return undefined;
}

/**
 * Adapter: a FieldRoutes "Customer Report" CSV row → the CRM's normalized
 * AgreementInput. Pure and row-oriented so it unit-tests without any I/O; the
 * driver (crm-migrate) parses the CSV and calls this, then importAgreement.
 *
 * Confirmed migration decisions this encodes:
 *  - PRICE is pre-tax: plan.priceCents = Subscription Contract Value / 12 (the
 *    monthly service rate). Verified against Recurring Total on 88/92 recurring
 *    rows (× 1.0625). Tax is charged SEPARATELY at billing from salesTaxPercent
 *    (BuzzKill bills 0% today — the tax stage adds a Stripe tax rate so the
 *    customer's total still equals their old FieldRoutes total).
 *  - Only ACTIVE subscriptions become plans. Frozen = paused; importing one as
 *    ACTIVE would start billing and dispatch a technician.
 *  - Only monthly-billed recurring cadences map to a plan. One Time / As Needed
 *    are one-time jobs, not subscriptions; Every 180 Days has no CRM frequency.
 *  - Identity: the export's real "Subscription ID" keys the plan; "Email
 *    Address" / "Phone 1" carry contacts. Many HOA rows share one office inbox
 *    (contact@getgim.com), so email is NOT a safe login key for them — HOAs
 *    belong in a group with a single management login, not per-condo logins.
 */

/** The columns this adapter reads (a parsed CSV row). Extra columns are ignored. */
export type FieldRoutesRow = {
  "Customer ID": string;
  "Last Name": string;
  "First Name": string;
  "Sales Tax %": string;
  "Sold Date": string;
  "Recurring Total": string;
  "Company Name": string;
  "Subscription": string;
  "Subscription Status": string;
  "Address": string;
  "City": string;
  "Email Address": string;
  "Phone 1": string;
  "State": string;
  "Zip Code": string;
  "Subscription Contract Value": string;
  "Recurring Frequency": string;
  "Subscription ID": string;
};

export type SkippedRow = {
  externalCustomerId: string;
  label: string;
  reason:
    | "NOT_ACTIVE"
    | "ONE_TIME" // a single/as-needed visit, not a recurring plan
    | "UNSUPPORTED_CADENCE" // e.g. Every 180 Days — no CRM ServiceFrequency
    | "NO_PRICE" // contract value missing/zero — nothing to lock in
    | "DUPLICATE"; // a same-key row already produced a plan
};

export type AdaptResult = {
  /** Ready to hand to importAgreement, one per active recurring agreement. */
  agreements: AgreementInput[];
  /** Active One-Time / As-Needed rows — real work, but one-time jobs (a
   *  separate importer), not subscriptions. Surfaced, never silently dropped. */
  oneTimeVisits: SkippedRow[];
  /** Everything intentionally not imported, each with a reason. */
  skipped: SkippedRow[];
};

const FREQUENCY_MAP: Record<string, AgreementInput["serviceFrequency"]> = {
  "Every 30 Days": "MONTHLY",
  "Every 60 Days": "BIMONTHLY",
  "Every 90 Days": "QUARTERLY",
};

function money(s: string): number {
  const n = Number((s ?? "").replace(/[$,]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function percent(s: string): number {
  const n = Number((s ?? "").replace(/[%]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** MM/DD/YY(YY) → YYYY-MM-DD. Returns undefined for anything unparseable. */
function toIsoDate(s: string): string | undefined {
  const m = (s ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return undefined;
  const [, mm, dd, yy] = m;
  const year = yy.length === 2 ? `20${yy}` : yy;
  return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** The subscription's stable id. Prefer the export's real Subscription ID;
 *  fall back to a synthesized tuple only if a row somehow lacks one, so the
 *  import stays idempotent either way. */
function subscriptionKey(r: FieldRoutesRow): string {
  const real = (r["Subscription ID"] ?? "").trim();
  if (real) return real;
  return [
    r["Customer ID"].trim(),
    r["Subscription"].trim(),
    r["Sold Date"].trim(),
    r["Subscription Contract Value"].trim(),
  ]
    .join("|")
    .replace(/[^A-Za-z0-9|.-]/g, "_");
}

export function adaptFieldRoutesRows(rows: FieldRoutesRow[]): AdaptResult {
  const agreements: AgreementInput[] = [];
  const oneTimeVisits: SkippedRow[] = [];
  const skipped: SkippedRow[] = [];
  const seenKeys = new Set<string>();

  for (const r of rows) {
    const externalCustomerId = r["Customer ID"].trim();
    const company = r["Company Name"].trim();
    const person = `${r["First Name"].trim()} ${r["Last Name"].trim()}`.trim();
    const label = company || person || externalCustomerId;
    const cadence = r["Recurring Frequency"].trim();

    if (r["Subscription Status"].trim() !== "Active") {
      skipped.push({ externalCustomerId, label, reason: "NOT_ACTIVE" });
      continue;
    }
    if (cadence === "One Time" || cadence === "As Needed") {
      oneTimeVisits.push({ externalCustomerId, label, reason: "ONE_TIME" });
      continue;
    }
    const serviceFrequency = FREQUENCY_MAP[cadence];
    if (!serviceFrequency) {
      skipped.push({ externalCustomerId, label, reason: "UNSUPPORTED_CADENCE" });
      continue;
    }

    // Pre-tax monthly rate — the locked price. Contract value is the ANNUAL
    // pre-tax figure for recurring plans, so /12 is the monthly BuzzKill bills.
    const annual = money(r["Subscription Contract Value"]);
    const priceCents = Math.round((annual / 12) * 100);
    if (priceCents <= 0) {
      skipped.push({ externalCustomerId, label, reason: "NO_PRICE" });
      continue;
    }

    const key = subscriptionKey(r);
    if (seenKeys.has(key)) {
      skipped.push({ externalCustomerId, label, reason: "DUPLICATE" });
      continue;
    }
    seenKeys.add(key);

    const isHoa = Boolean(company);
    agreements.push({
      externalCustomerId,
      externalSubscriptionId: key,
      group: resolveGroup(r),
      displayName: label,
      // A residential row's own contact. HOA rows usually carry the shared
      // office inbox — kept for the record, but the login/group strategy must
      // not key on it (see file header).
      email: r["Email Address"].trim() || undefined,
      phone: r["Phone 1"].trim() || undefined,
      serviceStreet: r["Address"].trim() || undefined,
      serviceCity: r["City"].trim() || undefined,
      serviceState: r["State"].trim() || undefined,
      serviceZip: r["Zip Code"].trim() || undefined,
      planName: r["Subscription"].trim(),
      priceCents,
      serviceFrequency,
      startDate: toIsoDate(r["Sold Date"]),
      serviceType: r["Subscription"].trim(),
      propertyClass: isHoa ? "COMMUNITY" : "RESIDENTIAL",
      // Carried for the tax stage: BuzzKill bills 0% today, so the migration
      // adds a Stripe tax rate at this percent so the customer's total charge
      // (price + tax) equals what FieldRoutes charged. Persisted on the plan
      // notes until a first-class tax field + Stripe tax-rate wiring lands.
      salesTaxPercent: percent(r["Sales Tax %"]),
    });
  }

  return { agreements, oneTimeVisits, skipped };
}
