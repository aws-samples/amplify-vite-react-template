/**
 * Revenue arithmetic for the office Dashboard.
 *
 * A pure module because these are the numbers the business reads to decide
 * whether it is being paid — they need to be testable without a browser.
 *
 * The rule that matters: money that came back is not revenue. A fully refunded
 * invoice is REFUNDED; a partly refunded one stays PAID with a non-zero
 * refundedAmountCents. Filtering on status alone counts the partial refund as
 * revenue forever, so every figure nets refundedAmountCents out.
 */

export type RevenueInvoice = {
  amountCents: number;
  status?: string | null;
  refundedAmountCents?: number | null;
};

export type RevenueTotals = {
  /** Invoiced, less anything refunded. */
  billedCents: number;
  /** Actually collected and kept. */
  paidCents: number;
  /** Outstanding. */
  openCents: number;
  /** Declined. */
  failedCents: number;
  /** Given back. Netted out of billed and paid, shown separately. */
  refundedCents: number;
};

export const isSettled = (i: RevenueInvoice) =>
  i.status === "PAID" || i.status === "REFUNDED";

export function refundedOf(i: RevenueInvoice): number {
  return i.refundedAmountCents ?? 0;
}

/** What a customer actually kept us paid for on one invoice. */
export function netCollectedCents(i: RevenueInvoice): number {
  if (!isSettled(i)) return 0;
  return Math.max(0, i.amountCents - refundedOf(i));
}

/**
 * Which side of the business an invoice's money came from.
 *
 * There is no client-type field on Customer — the distinction lives on jobs
 * (Job.propertyClass: RESIDENTIAL | COMMUNITY | COMMERCIAL, set at dispatch).
 * An invoice is classified by its own job when it has one, otherwise by the
 * customer's most recent classified job. Invoices for customers with no
 * classified job at all land in UNCLASSIFIED rather than silently defaulting —
 * a dashboard total should never invent a category.
 */
export type ClientType =
  | "RESIDENTIAL"
  | "COMMUNITY"
  | "COMMERCIAL"
  | "UNCLASSIFIED";

export const CLIENT_TYPES: ClientType[] = [
  "RESIDENTIAL",
  "COMMUNITY",
  "COMMERCIAL",
  "UNCLASSIFIED",
];

export type ClientTypeInvoice = RevenueInvoice & {
  customerId: string;
  jobId?: string | null;
};

export type ClientTypeJob = {
  id: string;
  customerId: string;
  propertyClass?: string | null;
  completedAt?: string | null;
  scheduledDate?: string | null;
  createdAt?: string | null;
};

function normalizeClientType(v: string | null | undefined): ClientType | null {
  const t = (v ?? "").trim().toUpperCase();
  return t === "RESIDENTIAL" || t === "COMMUNITY" || t === "COMMERCIAL"
    ? (t as ClientType)
    : null;
}

/** When a job happened, for "most recent classified job" tie-breaking. */
const jobWhen = (j: ClientTypeJob) =>
  j.completedAt ?? j.scheduledDate ?? j.createdAt ?? "";

export function classifyInvoice(
  invoice: ClientTypeInvoice,
  jobById: Map<string, ClientTypeJob>,
  latestClassByCustomer: Map<string, ClientType>,
  // The customer's own default property type — the fallback when neither the
  // invoice's job nor any prior classified job pins one. This is what keeps the
  // migrated book (customers with plans but no completed jobs yet) out of
  // UNCLASSIFIED once the office sets property type on the customer.
  customerClassById?: Map<string, ClientType>
): ClientType {
  if (invoice.jobId) {
    const own = normalizeClientType(jobById.get(invoice.jobId)?.propertyClass);
    if (own) return own;
  }
  return (
    latestClassByCustomer.get(invoice.customerId) ??
    customerClassById?.get(invoice.customerId) ??
    "UNCLASSIFIED"
  );
}

/** The customer-default property type, for the classify fallback. */
export function clientTypeByCustomerField(
  customers: { id: string; propertyClass?: string | null }[]
): Map<string, ClientType> {
  const m = new Map<string, ClientType>();
  for (const c of customers) {
    const type = normalizeClientType(c.propertyClass);
    if (type) m.set(c.id, type);
  }
  return m;
}

/** The customer's most recent job that carries a property class. */
export function latestClientTypeByCustomer(
  jobs: ClientTypeJob[]
): Map<string, ClientType> {
  const best = new Map<string, { when: string; type: ClientType }>();
  for (const j of jobs) {
    const type = normalizeClientType(j.propertyClass);
    if (!type) continue;
    const cur = best.get(j.customerId);
    const when = jobWhen(j);
    if (!cur || when >= cur.when) best.set(j.customerId, { when, type });
  }
  return new Map([...best].map(([id, v]) => [id, v.type]));
}

export type ClientTypeSlice = RevenueTotals & { invoiceCount: number };

/** The dashboard's revenue split: one refund-aware total set per client type. */
export function revenueByClientType(
  invoices: ClientTypeInvoice[],
  jobs: ClientTypeJob[],
  customers?: { id: string; propertyClass?: string | null }[]
): Record<ClientType, ClientTypeSlice> {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const latest = latestClientTypeByCustomer(jobs);
  const customerClass = customers
    ? clientTypeByCustomerField(customers)
    : undefined;
  const buckets: Record<ClientType, ClientTypeInvoice[]> = {
    RESIDENTIAL: [],
    COMMUNITY: [],
    COMMERCIAL: [],
    UNCLASSIFIED: [],
  };
  for (const inv of invoices) {
    buckets[classifyInvoice(inv, jobById, latest, customerClass)].push(inv);
  }
  return Object.fromEntries(
    CLIENT_TYPES.map((t) => [
      t,
      { ...revenueTotals(buckets[t]), invoiceCount: buckets[t].length },
    ])
  ) as Record<ClientType, ClientTypeSlice>;
}

export const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  RESIDENTIAL: "Residential",
  COMMUNITY: "Community",
  COMMERCIAL: "Commercial",
  UNCLASSIFIED: "Unclassified",
};

export function revenueTotals(invoices: RevenueInvoice[]): RevenueTotals {
  const sum = (list: RevenueInvoice[], f: (i: RevenueInvoice) => number) =>
    list.reduce((s, i) => s + f(i), 0);

  const refundedCents = sum(invoices.filter(isSettled), refundedOf);

  return {
    billedCents: sum(invoices, (i) => i.amountCents) - refundedCents,
    paidCents: sum(invoices, netCollectedCents),
    openCents: sum(
      invoices.filter((i) => i.status === "OPEN"),
      (i) => i.amountCents
    ),
    failedCents: sum(
      invoices.filter((i) => i.status === "FAILED"),
      (i) => i.amountCents
    ),
    refundedCents,
  };
}
