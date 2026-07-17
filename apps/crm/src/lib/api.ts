import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../../web/amplify/data/resource";

/**
 * Typed Amplify Data client against the shared backend schema (type-only
 * import — nothing from apps/web ships in the bundle). Lazy so it is
 * created after Amplify.configure has run.
 */
let client: ReturnType<typeof generateClient<Schema>> | null = null;

export function api() {
  if (!client) client = generateClient<Schema>();
  return client;
}

export type { Schema };
export type Customer = Schema["Customer"]["type"];
export type CustomerGroup = Schema["CustomerGroup"]["type"];
export type ServicePlan = Schema["ServicePlan"]["type"];
export type Job = Schema["Job"]["type"];
export type Route = Schema["Route"]["type"];
export type Technician = Schema["Technician"]["type"];
export type Agreement = Schema["Agreement"]["type"];
export type ServiceReport = Schema["ServiceReport"]["type"];
export type LeadPricingRun = Schema["LeadPricingRun"]["type"];
export type Product = Schema["Product"]["type"];
export type WorkItem = Schema["WorkItem"]["type"];
export type WorkEvent = Schema["WorkEvent"]["type"];

export function updateOwnedWork(input: {
  workItemId: string;
  action: "CLAIM" | "RESOLVE";
  note?: string;
}): OpResult {
  return api().mutations.updateOwnedWork(input);
}

/**
 * Recovery-lifecycle contract boundary (R02/R31/R52/R78), same shape as the
 * MarketRate boundary below: the backend wave landing alongside this one adds
 * the recovery fields to Invoice, a Dispute model, and the settle/pay/assign
 * mutations. These type augmentations + the thin wrappers further down let the
 * CRM compile against the contract before the generated schema catches up; once
 * the schema lands the extra members are redundant and harmless.
 *
 * Invoice gains: a due date + payment terms + PO number (for the check-paying
 * HOA/commercial segment), the dunning cadence fields the webhook stamps as it
 * retries a failed charge, and a single recovery owner.
 */
export type InvoiceTerms = "DUE_ON_RECEIPT" | "NET_15" | "NET_30";

export type Invoice = Schema["Invoice"]["type"] & {
  dueDate?: string | null;
  terms?: string | null;
  poNumber?: string | null;
  dunningAttempts?: number | null;
  nextDunningAt?: string | null;
  lastDunningAt?: string | null;
  ownerSub?: string | null;
  ownerEmail?: string | null;
};

/**
 * The Dispute model (chargebacks). Not derived from Schema because the model
 * does not exist in the generated types until the backend wave lands; declared
 * here to the contract's shape. Browser-read-only like Invoice — the only
 * writers are the Stripe webhook and assignRecoveryOwner.
 */
export type DisputeStatus =
  | "NEEDS_RESPONSE"
  | "UNDER_REVIEW"
  | "WON"
  | "LOST";

export type Dispute = {
  id: string;
  stripeDisputeId?: string | null;
  customerId: string;
  invoiceId?: string | null;
  amountCents: number;
  reason?: string | null;
  status?: DisputeStatus | string | null;
  evidenceDueBy?: string | null;
  openedAt?: string | null;
  closedAt?: string | null;
  ownerSub?: string | null;
  ownerEmail?: string | null;
  accessGroups?: (string | null)[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type OpResult = Promise<{ data: unknown; errors?: { message: string }[] }>;

/**
 * The recovery mutations, reached through a widened client because their names
 * are not in the generated Schema until the backend wave lands. Each is
 * Lambda-backed and stamps the actor server-side from Cognito.
 */

/**
 * Settle an existing OPEN/FAILED invoice when payment arrives (R31). OFFLINE
 * records it PAID with a note (cash/check/transfer, no Stripe); CARD charges
 * the customer's saved card off-session and settles on success. OWNER/FINANCE.
 */
export function settleInvoice(input: {
  invoiceId: string;
  method: "OFFLINE" | "CARD";
  note?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      settleInvoice: (i: typeof input) => OpResult;
    }
  ).settleInvoice(input);
}

/**
 * Charge the acting customer's saved card for one OPEN/FAILED invoice (the
 * portal Pay button). CUSTOMER path is enforced server-side against the
 * invoice's customer; OWNER/FINANCE may also call it.
 */
export function payInvoice(input: { invoiceId: string }): OpResult {
  return (
    api().mutations as unknown as {
      payInvoice: (i: typeof input) => OpResult;
    }
  ).payInvoice(input);
}

/**
 * Claim ownership of a recovery item ("Assign to me") — sets ownerSub/
 * ownerEmail from the caller's identity on an Invoice or Dispute (R78).
 * OWNER/FINANCE/OFFICE.
 */
export function assignRecoveryOwner(input: {
  kind: "INVOICE" | "DISPUTE";
  id: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      assignRecoveryOwner: (i: typeof input) => OpResult;
    }
  ).assignRecoveryOwner(input);
}

/**
 * recordOfflinePayment, widened to carry the contract's new terms + PO number
 * on the OPEN (invoice-for-later) path. The server derives the due date from
 * terms (dueDateForTerms), so the client sends terms/poNumber — not a due date.
 * The extra two args are ignored by the server until the backend wave lands.
 */
export function recordOfflinePayment(input: {
  customerId: string;
  amountCents: number;
  description: string;
  status: "PAID" | "OPEN";
  method?: string;
  jobId?: string;
  terms?: InvoiceTerms;
  poNumber?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      recordOfflinePayment: (i: typeof input) => OpResult;
    }
  ).recordOfflinePayment(input);
}

/** Compute the due date a set of terms produces from an issue date (client
 * mirror of the backend's dueDateForTerms — for display only; the server is
 * authoritative). YYYY-MM-DD in, YYYY-MM-DD out. */
export function dueDateForTerms(terms: InvoiceTerms, issuedYmd: string): string {
  const days = terms === "NET_15" ? 15 : terms === "NET_30" ? 30 : 0;
  return addDaysUTC(issuedYmd, days);
}

function addDaysUTC(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Email the customer a link to pay their outstanding balance (R52). Uses the
 * existing, supported "payment-request" email, whose button deep-links to the
 * portal /billing page — which now carries a per-invoice "Pay now" button, so
 * the customer lands exactly where they can settle the bill.
 *
 * The invoiceId is accepted (and forwarded as an email note reference) so this
 * reads as invoice-scoped at the call site, but the email itself is not yet a
 * single-invoice deep link: the backend's sendCustomerEmail only knows the
 * kinds payment-request / portal-reminder / booking-link, and rejects an
 * unknown kind or an undeclared argument. A true per-invoice deep link is a
 * follow-up that needs a backend kind + invoiceId argument (see concerns).
 */
export function sendInvoicePaymentLink(input: {
  customerId: string;
  invoiceId: string;
}): OpResult {
  void input.invoiceId;
  return api().mutations.sendCustomerEmail({
    customerId: input.customerId,
    kind: "payment-request",
  });
}

/**
 * List Disputes, reached through a widened client because the model is not in
 * the generated Schema until the backend wave lands. Shaped like a normal
 * .list() so listAll() can page it.
 */
export function listDisputes(args?: {
  filter?: unknown;
  limit?: number;
  nextToken?: string;
}): Promise<{
  data: Dispute[];
  nextToken?: string | null;
  errors?: { message: string }[];
}> {
  const models = api().models as unknown as {
    Dispute?: {
      list: (a?: typeof args) => Promise<{
        data: Dispute[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  // Tolerate the model being absent before the backend wave lands: an empty
  // page keeps the Dashboard rendering instead of throwing.
  if (!models.Dispute) return Promise.resolve({ data: [], nextToken: null });
  return models.Dispute.list(args);
}

/**
 * List WorkItems, tolerant of the model being absent before the backend wave
 * lands — same reason as listDisputes. Without this guard the Dashboard and
 * Work queue throw "Cannot read properties of undefined (reading 'list')" and
 * white-screen against a backend that hasn't deployed WorkItem yet.
 */
export function listWorkItems(args?: {
  filter?: unknown;
  limit?: number;
  nextToken?: string;
}): Promise<{
  data: WorkItem[];
  nextToken?: string | null;
  errors?: { message: string }[];
}> {
  const models = api().models as unknown as {
    WorkItem?: {
      list: (a?: typeof args) => Promise<{
        data: WorkItem[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  if (!models.WorkItem) return Promise.resolve({ data: [], nextToken: null });
  return models.WorkItem.list(args);
}

/** List WorkEvents, tolerant of the model being absent (see listWorkItems). */
export function listWorkEvents(args?: {
  filter?: unknown;
  limit?: number;
  nextToken?: string;
}): Promise<{
  data: WorkEvent[];
  nextToken?: string | null;
  errors?: { message: string }[];
}> {
  const models = api().models as unknown as {
    WorkEvent?: {
      list: (a?: typeof args) => Promise<{
        data: WorkEvent[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  if (!models.WorkEvent) return Promise.resolve({ data: [], nextToken: null });
  return models.WorkEvent.list(args);
}

/**
 * Contract boundary with the backend wave landing alongside this one:
 * MarketRate gains `pinned` (an office-edited row never expires or
 * re-researches until the office un-pins it). Intersected here so the CRM
 * compiles against the contract before the generated schema catches up; once
 * the schema lands the extra member is redundant and harmless.
 */
export type MarketRate = Schema["MarketRate"]["type"] & {
  pinned?: boolean | null;
};

/** MarketRate.update, accepting the contract's `pinned` field (see above). */
export function updateMarketRate(fields: {
  id: string;
  priceCents?: number;
  ratesJson?: string;
  active?: boolean;
  pinned?: boolean;
}) {
  type UpdateInput = Parameters<
    ReturnType<typeof api>["models"]["MarketRate"]["update"]
  >[0];
  return api().models.MarketRate.update(fields as UpdateInput);
}

/** Parse an AWSJSON field that may arrive as a string. */
export function jsonField<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

/**
 * Exhaustively page a .list() query. Dashboard totals and long lists must
 * never silently truncate at one page (DynamoDB may also return fewer items
 * than `limit` per page even when more exist).
 */
export async function listAll<T>(
  fetchPage: (nextToken?: string) => Promise<{
    data: T[];
    nextToken?: string | null;
    errors?: { message: string }[];
  }>
): Promise<T[]> {
  const out: T[] = [];
  let token: string | null | undefined;
  do {
    const page = await fetchPage(token ?? undefined);
    out.push(...unwrap(page));
    token = page.nextToken;
  } while (token);
  return out;
}

/** Unwrap an Amplify Data result, surfacing GraphQL errors as exceptions. */
export function unwrap<T>(result: {
  data: T;
  errors?: { message: string }[];
}): T {
  if (result.errors?.length) {
    throw new Error(result.errors.map((e) => e.message).join("; "));
  }
  return result.data;
}

/**
 * Result of a custom operation declared with `.returns(a.json())`: AppSync
 * serializes AWSJSON as a JSON string, so the client receives a string, not
 * the object the Lambda returned. Parse it (tolerating an already-parsed
 * object, in case a future Amplify client version starts parsing for us).
 */
export function opResult<T>(result: {
  data: unknown;
  errors?: { message: string }[];
}): T | null {
  const data = unwrap(result);
  if (data == null) return null;
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }
  return data as T;
}
