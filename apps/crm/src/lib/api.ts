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
export type ServiceReportAmendment = Schema["ServiceReportAmendment"]["type"];
export type LeadPricingRun = Schema["LeadPricingRun"]["type"];
export type BookingRequest = Schema["BookingRequest"]["type"];
export type Product = Schema["Product"]["type"];
/** Append-only light-inventory stock ledger (on-hand = sum of deltas). */
export type ProductStockEntry = Schema["ProductStockEntry"]["type"];
export type WorkItem = Schema["WorkItem"]["type"];
export type WorkEvent = Schema["WorkEvent"]["type"];
export type LeadActivity = Schema["LeadActivity"]["type"];
// GL-16 — the AI pricing engine's work-list and control rows, read by the
// Market Rates screen's engine panel.
export type RateCoverage = Schema["RateCoverage"]["type"];
export type PricingControl = Schema["PricingControl"]["type"];
/** Staff-managed funnel discount codes (owner-only CRUD; the public booking
 *  Lambda reads them to discount checkout). */
export type PromoCode = Schema["PromoCode"]["type"];

/** GL-02 — controlled lead vocabularies (mirror the server validators). */
export const LEAD_LOST_REASONS = [
  { code: "PRICE", label: "Price" },
  { code: "NO_RESPONSE", label: "No response" },
  { code: "WENT_COMPETITOR", label: "Went with a competitor" },
  { code: "NOT_QUALIFIED", label: "Not qualified / out of scope" },
  { code: "OUT_OF_AREA", label: "Outside service area" },
  { code: "DUPLICATE", label: "Duplicate record" },
  { code: "OTHER", label: "Other" },
] as const;
export const LEAD_TOUCH_CHANNELS = [
  { code: "CALL", label: "Call" },
  { code: "TEXT", label: "Text" },
  { code: "EMAIL", label: "Email" },
  { code: "NOTE", label: "Note (no contact)" },
] as const;
export const LEAD_TOUCH_OUTCOMES = [
  { code: "REACHED", label: "Reached them" },
  { code: "DELIVERED", label: "Delivered to customer" },
  { code: "LEFT_MESSAGE", label: "Left a message" },
  { code: "NO_ANSWER", label: "No answer" },
  { code: "SENT", label: "Provider accepted (not delivered)" },
  { code: "QUALIFIED", label: "Qualified" },
  { code: "UNQUALIFIED", label: "Unqualified" },
  { code: "FAILED", label: "Failed" },
  { code: "BOUNCED", label: "Bounced" },
  { code: "SUPPRESSED", label: "Suppressed" },
  { code: "NOTE", label: "Just a note" },
] as const;

export const LEAD_OUTCOME_CODES_BY_CHANNEL: Record<string, readonly string[]> = {
  CALL: ["REACHED", "LEFT_MESSAGE", "NO_ANSWER", "FAILED"],
  TEXT: ["REACHED", "DELIVERED", "SENT", "FAILED", "BOUNCED", "SUPPRESSED"],
  EMAIL: ["REACHED", "DELIVERED", "SENT", "FAILED", "BOUNCED", "SUPPRESSED"],
  NOTE: ["QUALIFIED", "UNQUALIFIED", "NOTE"],
};

type LeadActivityPage = {
  data: LeadActivity[];
  nextToken?: string | null;
  errors?: { message: string }[];
};

/** Pure page collector so complete-history and page-error behavior stay tested. */
export async function collectLeadActivityPages(
  customerId: string,
  listPage: (args: {
    filter: unknown;
    limit: number;
    nextToken?: string | null;
  }) => Promise<LeadActivityPage>
): Promise<LeadActivity[]> {
  const data: LeadActivity[] = [];
  let nextToken: string | null | undefined;
  do {
    const page = await listPage({
      filter: { customerId: { eq: customerId } },
      limit: 500,
      nextToken,
    });
    if (page.errors?.length) {
      throw new Error(page.errors.map((error) => error.message).join("; "));
    }
    data.push(...page.data);
    nextToken = page.nextToken;
  } while (nextToken);
  return data;
}

export function clientActionId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

/** GL-02 lead mutations. Widened like the staff mutations — the actor is stamped
 *  server-side from the token, never these args. */
export function createLead(input: {
  displayName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  serviceStreet?: string;
  serviceCity?: string;
  serviceState?: string;
  serviceZip?: string;
  leadSource?: string;
  notes?: string;
  force?: boolean;
  idempotencyKey?: string;
  contactConsentChannels?: string[];
  contactConsentSource?: string;
  contactConsentText?: string;
  contactConsentPolicyVersion?: string;
}): OpResult {
  return (
    api().mutations as unknown as { createLead: (i: typeof input) => OpResult }
  ).createLead(input);
}

export function logLeadTouch(input: {
  customerId: string;
  channel: string;
  direction?: string;
  outcome: string;
  note?: string;
  nextAction?: string;
  nextActionAt?: string;
  idempotencyKey: string;
}): OpResult {
  return (
    api().mutations as unknown as { logLeadTouch: (i: typeof input) => OpResult }
  ).logLeadTouch(input);
}

export function setLeadDisposition(input: {
  customerId: string;
  disposition: "LOST" | "DNC" | "CLEAR" | "CONVERT";
  reasonCode?: string;
  note?: string;
  // CONVERT only — the manually-entered plan that turns the lead into a client.
  planName?: string;
  priceCents?: number;
  serviceFrequency?: "MONTHLY" | "BIMONTHLY" | "QUARTERLY" | "SEMIANNUAL";
  idempotencyKey: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      setLeadDisposition: (i: typeof input) => OpResult;
    }
  ).setLeadDisposition(input);
}

export function assignLeadOwner(input: {
  customerId: string;
  toSub?: string;
  toEmail?: string;
  idempotencyKey: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      assignLeadOwner: (i: typeof input) => OpResult;
    }
  ).assignLeadOwner(input);
}

/** Page the complete immutable timeline. A missing model or failed page is an
 * explicit error; it is never rendered as "no activity". */
export async function listLeadActivity(customerId: string): Promise<{
  data: LeadActivity[];
}> {
  const models = api().models as unknown as {
    LeadActivity?: {
      list: (a: {
        filter?: unknown;
        limit?: number;
        nextToken?: string | null;
      }) => Promise<{
        data: LeadActivity[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  if (!models.LeadActivity) throw new Error("Lead activity is unavailable.");
  const data = await collectLeadActivityPages(
    customerId,
    models.LeadActivity.list
  );
  return { data };
}

/**
 * GL-13 row-scoping — the field app's scoped read surface.
 *
 * The Job, Customer, Route, Technician, and ServiceReport models no longer grant
 * TECH a model read: a technician must not be able to list, fetch, or subscribe
 * to another worker's rows by id. The two tech screens read exclusively through
 * these server-scoped queries, which the crm-docs Lambda answers under IAM after
 * proving the caller owns the work. Customer is reduced to visit fields and the
 * Job's money fields are dropped, server-side, so field least-privilege holds
 * here too. Office/portal code keeps using the raw models (they are authorized).
 *
 * A refused technicianJob (a job that is not the caller's) rejects with the same
 * opaque "Not authorized for this job" as a missing one — a known id proves
 * nothing. technicianDay returns { unlinked: true } for a TECH login the office
 * has not linked yet, so the screen shows guidance instead of an error.
 */
export type TechnicianDay = {
  unlinked?: boolean;
  /** GL-13: this login's field access has ended (deactivation/offboarding). */
  accessEnded?: boolean;
  /** GL-13: employed, but no current licence — no route or new visits. */
  licenseLapsed?: boolean;
  technicianId: string | null;
  technicianName: string | null;
  canPickTechnician: boolean;
  technicians: { id: string; name: string }[];
  route: {
    id: string;
    date: string | null;
    status: string | null;
    notes: string | null;
  } | null;
  jobs: Job[];
  customers: Record<string, Customer>;
};

export async function technicianDay(
  date: string,
  technicianId?: string
): Promise<TechnicianDay> {
  const res = await api().queries.technicianDay({ date, technicianId });
  const parsed = opResult<TechnicianDay>(res);
  if (!parsed) throw new Error("Could not load your day");
  return parsed;
}

export type PriorVisitFindings = {
  servicesPerformed?: string | null;
  productsUsed?: unknown;
  areasTreated?: string | null;
  targetPests?: string | null;
  recommendations?: string | null;
  reEntryIntervalHours?: number | null;
};

export type TechnicianJobDetail = {
  job: Job;
  /** GL-12: the locked on-site duration for the property classification. */
  onsiteMinutes?: number;
  /** GL-12: the packet changed since the technician last acknowledged. */
  packetChanged?: boolean;
  /** GL-12: this visit's chain of earlier attempts (rebook lineage). */
  lineage?: {
    id: string;
    status: string;
    scheduledDate?: string | null;
    noAccessReason?: string | null;
    notPerformedReason?: string | null;
  }[];
  customer: Customer | null;
  reports: ServiceReport[];
  technician: {
    id: string;
    name: string | null;
    active: boolean | null;
    userSub: string | null;
  } | null;
  catalog: Product[];
  priorVisits: (Pick<
    Job,
    "id" | "status" | "serviceType" | "scheduledDate" | "noAccessReason"
  > & { notPerformedReason?: string | null; findings?: PriorVisitFindings | null })[];
};

export async function technicianJob(
  jobId: string
): Promise<TechnicianJobDetail> {
  const res = await api().queries.technicianJob({ jobId });
  const parsed = opResult<TechnicianJobDetail>(res);
  if (!parsed) throw new Error("Job not found");
  return parsed;
}

/**
 * GL-18 — claim or resolve an exception. RESOLVE closes only from a verified
 * outcome: pass resolutionActionId to run a verified close (the server re-checks
 * the real-world fact), or reasonCode + note for an owner manual override. A
 * routine user can no longer close by free-text note alone.
 */
export function updateOwnedWork(input: {
  workItemId: string;
  action: "CLAIM" | "RESOLVE" | "RELEASE";
  note?: string;
  resolutionActionId?: string;
  reasonCode?: string;
}): OpResult {
  return api().mutations.updateOwnedWork(input);
}

/** GL-18 R2: lift a bounce/complaint suppression (required consent note) so
 *  the missed message can be re-sent. */
export function liftEmailSuppression(input: {
  email: string;
  reasonCode: "CUSTOMER_RECONSENTED" | "ENTERED_IN_ERROR";
  evidence: string;
}): OpResult {
  return api().mutations.liftEmailSuppression(input);
}

/** GL-08/GL-18: record that a notice reached the customer another way — the
 *  approved terminal alternative to a mailbox DELIVERED. */
export function recordNoticeAlternateDelivery(input: {
  relatedId: string;
  template: string;
  note: string;
}): OpResult {
  return api().mutations.recordNoticeAlternateDelivery(input);
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
 *
 * MARK_DEPOSITED / UNMARK_DEPOSITED ride the same mutation (CFN 500-resource
 * cap — no new custom ops): they stamp/clear Invoice.depositedAt on an
 * already-settled MANUAL invoice, confirming the cash/cheque physically
 * reached the bank. They refuse Stripe-settled invoices.
 */
export function settleInvoice(input: {
  invoiceId: string;
  method: "OFFLINE" | "CARD" | "MARK_DEPOSITED" | "UNMARK_DEPOSITED";
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

/** GL-08 — the honest consequences of canceling a plan, computed server-side
 *  for the portal's confirmation. Read-only; a CUSTOMER may preview only their
 *  own plan (enforced server-side against the plan's customer). */
export type PlanCancellationPreview = {
  servicePlanId: string;
  planName: string;
  priceCents: number;
  serviceFrequency: string;
  status: string;
  alreadyResolved: boolean;
  cancellationPending: boolean;
  effectiveDate: string;
  finalCharge: { amountCents: number; description: string };
  refundOutcome: { amountCents: number; description: string };
  queuedVisits: {
    jobId: string;
    scheduledDate: string | null;
    disposition: "STOPS" | "REMAINS";
    reason: string;
  }[];
  visitsStopping: number;
  paidVisitRemains: boolean;
  outstandingBalanceCents: number;
  coverageEnding: string;
  saveOfferAvailable: boolean;
};

export function previewPlanCancellation(input: {
  servicePlanId: string;
}): OpResult {
  return (
    api().queries as unknown as {
      previewPlanCancellation: (i: typeof input) => OpResult;
    }
  ).previewPlanCancellation(input);
}

/** GL-08 — the customer's own confirmed cancel. The reason is optional and
 *  never blocks. A Stripe outage returns status PENDING (not an error) so the
 *  portal shows a truthful in-progress state instead of a false "canceled". */
export type CustomerCancelOutcome =
  | {
      status: "CANCELED";
      alreadyCanceled: boolean;
      visitsStopped: number;
      visitsRemaining: number;
      confirmationEmailed: boolean;
      message: string;
    }
  | { status: "PENDING"; message: string; requestedAt: string };

export function cancelPlanByCustomer(input: {
  servicePlanId: string;
  reason?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      cancelPlanByCustomer: (i: typeof input) => OpResult;
    }
  ).cancelPlanByCustomer(input);
}

/**
 * GL-07 — one safe office cancel/reschedule workflow. The preview computes every
 * consequence server-side (amount paid/open, policy deadline, refund/credit/fee,
 * plan and route effects, the exact notice); the office picks a plain decision
 * and never types an amount.
 */
export type VisitCancellationPolicy = {
  policyDeadline: string | null;
  withinFreeWindow: boolean;
  daysUntilVisit: number | null;
  amountPaidCents: number;
  refundableCents: number;
  feeCents: number;
  explanation: string;
};

export type VisitChangePreview = {
  jobId: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  serviceType: string;
  scheduledDate: string | null;
  status: string;
  changeable: boolean;
  alreadyCanceled: boolean;
  amountPaidCents: number;
  amountOpenCents: number;
  policy: VisitCancellationPolicy;
  decisions: {
    reschedule: { available: boolean; description: string };
    cancelRefund: { available: boolean; amountCents: number; description: string };
  };
  planConsequence: string;
  routeConsequence: string;
  noticePreview: string;
};

/** "Keep as account credit" was dropped for launch (no real credit ledger). */
export type CancelDecision = "CANCEL_REFUND";

export type VisitCancelOutcome = {
  jobId: string;
  action: "CANCEL";
  decision: CancelDecision;
  canceled: boolean;
  alreadyCanceled: boolean;
  disposition: "REFUND" | "FEE_RETAINED" | "NONE";
  refundedCents: number;
  invoiceVoided: boolean;
  communicationResult: "SENT" | "FAILED" | "NO_EMAIL" | "PENDING";
  outcome: "COMPLETE" | "PARTIAL" | "PENDING";
  message: string;
};

/** Controlled reason codes for a visit cancel/reschedule (GL-07) — mirrors the
 *  server's VISIT_CANCEL_REASONS / VISIT_RESCHEDULE_REASONS. OTHER needs a note. */
export const VISIT_CANCEL_REASONS = [
  "CUSTOMER_REQUEST",
  "SCHEDULING_CONFLICT",
  "WEATHER",
  "TECH_UNAVAILABLE",
  "ACCESS_ISSUE",
  "DUPLICATE",
  "SERVICE_NOT_NEEDED",
  "OTHER",
] as const;
export const VISIT_RESCHEDULE_REASONS = [
  "CUSTOMER_REQUEST",
  "WEATHER",
  "TECH_UNAVAILABLE",
  "ROUTE_CHANGE",
  "ACCESS_ISSUE",
  "OTHER",
] as const;

/** The immutable visit-change ledger row (GL-07), read for the history screen. */
export type VisitChangeEvent = Schema["VisitChangeEvent"]["type"];

/** List visit-change ledger rows for the Ops/Finance history screen. Tolerant of
 *  the model being absent before the backend wave lands. */
export function listVisitChangeEvents(args?: {
  limit?: number;
  nextToken?: string;
}): Promise<{
  data: VisitChangeEvent[];
  nextToken?: string | null;
  errors?: { message: string }[];
}> {
  const models = api().models as unknown as {
    VisitChangeEvent?: {
      list: (a?: typeof args) => Promise<{
        data: VisitChangeEvent[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  if (!models.VisitChangeEvent)
    return Promise.resolve({ data: [], nextToken: null });
  return models.VisitChangeEvent.list(args);
}

export type VisitRescheduleOutcome = {
  jobId: string;
  action: "RESCHEDULE";
  rescheduled: boolean;
  priorScheduledDate: string | null;
  newScheduledDate: string | null;
  assignedToRoute: boolean;
  communicationResult: "SENT" | "FAILED" | "NO_EMAIL";
  outcome: "COMPLETE" | "PARTIAL";
  message: string;
};

export function previewVisitChange(input: { jobId: string }): OpResult {
  return (
    api().queries as unknown as {
      previewVisitChange: (i: typeof input) => OpResult;
    }
  ).previewVisitChange(input);
}

/** Cancel one visit as a single guided action — the server performs the refund/
 *  credit, voids any open invoice, takes the visit off its route, and notifies
 *  the customer, or opens an owned exception and reports PARTIAL. */
export function cancelVisit(input: {
  jobId: string;
  decision: CancelDecision;
  reasonCode: string;
  note?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      cancelVisit: (i: typeof input) => OpResult;
    }
  ).cancelVisit(input);
}

/** Reschedule one visit — revalidates capacity + technician license, moves the
 *  route, and emails the customer old and new details. */
export function rescheduleVisit(input: {
  jobId: string;
  scheduledDate?: string;
  technicianId?: string;
  routeId?: string;
  routeOrder?: number;
  reasonCode: string;
  note?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      rescheduleVisit: (i: typeof input) => OpResult;
    }
  ).rescheduleVisit(input);
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
 * The invoiceId is accepted (but not passed onward — it is voided here) so this
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
    idempotencyKey: clientActionId("invoice-payment-link"),
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
 * MarketRate gains `pinned` (an office-edited row cannot be replaced by AI
 * until the office unpins it and explicitly requests research). Intersected here so the CRM
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

/**
 * GL-14 — the owner-only staff roster and its two management actions. The
 * roster and its mutations are Lambda-backed (crm-admin) and OWNER-only
 * server-side; the CRM cannot touch Cognito directly, so it goes through these.
 */
export type StaffRosterRow = {
  username: string;
  sub: string | null;
  email: string;
  name: string | null;
  enabled: boolean;
  status: string | null;
  pendingInvite: boolean;
  lastLoginAt: string | null;
  roles: string[];
  linkedTechnicianId: string | null;
  technicianActive: boolean | null;
  licenseValid: boolean | null;
  licenseExpiresOn: string | null;
  unlinkedTech: boolean;
};

export function staffRoster(): OpResult {
  return (
    api().queries as unknown as { staffRoster: () => OpResult }
  ).staffRoster();
}

/** The controlled reason codes for a staff-access change (GL-14) — mirrors the
 *  server's STAFF_ROLE_CHANGE_REASONS / STAFF_OFFBOARD_REASONS. OTHER needs a
 *  note. */
export const STAFF_ROLE_CHANGE_REASONS = [
  "PROMOTION",
  "REASSIGNMENT",
  "REDUCE_ACCESS",
  "CORRECTION",
  "OTHER",
] as const;
export const STAFF_OFFBOARD_REASONS = [
  "DEPARTURE_VOLUNTARY",
  "DEPARTURE_INVOLUNTARY",
  "ROLE_ENDED",
  "SECURITY",
  "OTHER",
] as const;

/** GL-17 — licence records. Office adds/updates records; only an OWNER
 *  (Compliance seat) changes a record's status. */
export type TechnicianLicenseRecord = {
  id: string;
  technicianId: string;
  number: string;
  licenseType?: string | null;
  issuer?: string | null;
  status: string;
  expiresOn?: string | null;
  evidenceKey?: string | null;
  evidenceNote?: string | null;
  statusSetBy?: string | null;
  statusSetAt?: string | null;
};

export function saveTechnicianLicense(input: {
  licenseId?: string;
  technicianId: string;
  number: string;
  licenseType?: string;
  issuer?: string;
  expiresOn?: string;
  evidenceNote?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      saveTechnicianLicense: (i: typeof input) => OpResult;
    }
  ).saveTechnicianLicense(input);
}

export function setLicenseStatus(input: {
  licenseId: string;
  status: string;
  reason: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      setLicenseStatus: (i: typeof input) => OpResult;
    }
  ).setLicenseStatus(input);
}

/** Set a staff login's role set to exactly `roles`. A controlled reasonCode is
 *  required; an idempotencyKey makes a retry safe. Server ends sessions on a
 *  demotion, reads the effective roles back, and records the durable ledger row. */
export function changeStaffRoles(input: {
  email: string;
  roles: string[];
  reasonCode: string;
  reason?: string;
  idempotencyKey?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      changeStaffRoles: (i: typeof input) => OpResult;
    }
  ).changeStaffRoles(input);
}

/** Offboard a staff member: disable + sign out first, remove groups, reassign a
 *  linked technician's future work. Requires a controlled reasonCode; an
 *  idempotencyKey makes a retry safe. Server refuses the last usable owner,
 *  reads back that the login is disabled and the technician inactive, opens an
 *  owned case on any partial result, and records the durable ledger row. */
export function offboardStaff(input: {
  email: string;
  reasonCode: string;
  reason?: string;
  idempotencyKey?: string;
}): OpResult {
  return (
    api().mutations as unknown as {
      offboardStaff: (i: typeof input) => OpResult;
    }
  ).offboardStaff(input);
}

/** The immutable staff-access ledger row (GL-14), read directly from the model
 *  (OWNER-readable) for the Access History screen. */
export type StaffAccessEvent = Schema["StaffAccessEvent"]["type"];

/** List staff-access ledger rows for the owner-only history screen. Tolerates
 *  the model being absent before the backend wave lands. */
export function listStaffAccessEvents(args?: {
  limit?: number;
  nextToken?: string;
}): Promise<{
  data: StaffAccessEvent[];
  nextToken?: string | null;
  errors?: { message: string }[];
}> {
  const models = api().models as unknown as {
    StaffAccessEvent?: {
      list: (a?: typeof args) => Promise<{
        data: StaffAccessEvent[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  if (!models.StaffAccessEvent)
    return Promise.resolve({ data: [], nextToken: null });
  return models.StaffAccessEvent.list(args);
}

/** Controlled reason codes for a customer lifecycle transition (GL-09) — mirrors
 *  the server's DEACTIVATION_REASONS / REACTIVATION_REASONS. OTHER needs a note. */
export const DEACTIVATION_REASONS = [
  "CUSTOMER_REQUEST",
  "NONPAYMENT",
  "MOVED",
  "PROPERTY_SOLD",
  "SERVICE_ENDED",
  "DUPLICATE",
  "OTHER",
] as const;
export const REACTIVATION_REASONS = [
  "CUSTOMER_RETURNED",
  "PAYMENT_RESOLVED",
  "DEACTIVATED_IN_ERROR",
  "OTHER",
] as const;

/** The immutable customer-lifecycle ledger row (GL-09), read directly from the
 *  model (OWNER/OFFICE/FINANCE-readable) for the customer's history card. */
export type CustomerLifecycleEvent = Schema["CustomerLifecycleEvent"]["type"];

/** List a customer's COMPLETE lifecycle history — paged to exhaustion, with a
 *  read failure SURFACED (readFailed), never disguised as an empty timeline
 *  (GL-09/X1). Tolerates the model being absent before the backend wave lands. */
export async function listCustomerLifecycleEvents(customerId: string): Promise<{
  data: CustomerLifecycleEvent[];
  readFailed: boolean;
}> {
  const models = api().models as unknown as {
    CustomerLifecycleEvent?: {
      list: (a: {
        filter?: { customerId: { eq: string } };
        limit?: number;
        nextToken?: string | null;
      }) => Promise<{
        data: CustomerLifecycleEvent[];
        nextToken?: string | null;
        errors?: { message: string }[];
      }>;
    };
  };
  if (!models.CustomerLifecycleEvent) return { data: [], readFailed: false };
  const out: CustomerLifecycleEvent[] = [];
  try {
    let token: string | null | undefined;
    do {
      const page = await models.CustomerLifecycleEvent.list({
        filter: { customerId: { eq: customerId } },
        limit: 200,
        nextToken: token ?? undefined,
      });
      if (page.errors?.length) return { data: out, readFailed: true };
      out.push(...(page.data ?? []));
      token = page.nextToken;
    } while (token);
    return { data: out, readFailed: false };
  } catch {
    return { data: out, readFailed: true };
  }
}

/** GL-09 — the customer's lifecycle commands (durable transitions). A
 *  non-terminal command is a "Transition needs recovery" banner + resume. */
export async function listLifecycleCommands(customerId: string): Promise<
  {
    id: string;
    action: string;
    stage: string;
    outcome?: string | null;
    effects?: string | null;
    lastError?: string | null;
    requestedAt?: string | null;
  }[]
> {
  const models = api().models as unknown as {
    CustomerLifecycleCommand?: {
      listCustomerLifecycleCommandByCustomerIdAndRequestedAt: (
        q: { customerId: string },
        o: { limit: number; nextToken?: string | null }
      ) => Promise<{
        data: Record<string, unknown>[];
        nextToken?: string | null;
      }>;
    };
  };
  if (!models.CustomerLifecycleCommand) return [];
  try {
    // Paginated to exhaustion: the resumable PARTIAL the banner exists to
    // surface is the NEWEST row — exactly the one a single page can hide.
    const all: Record<string, unknown>[] = [];
    let nextToken: string | null | undefined = undefined;
    do {
      const res: {
        data: Record<string, unknown>[];
        nextToken?: string | null;
      } = await models.CustomerLifecycleCommand.listCustomerLifecycleCommandByCustomerIdAndRequestedAt(
        { customerId },
        { limit: 200, nextToken }
      );
      all.push(...(res.data ?? []));
      nextToken = res.nextToken;
    } while (nextToken);
    return all as never[];
  } catch {
    return [];
  }
}

/** GL-09 — the server-computed transition preview. */
export function previewLifecycleTransition(input: {
  customerId: string;
  action: string;
  reasonCode?: string;
}): OpResult {
  return (
    api().queries as unknown as {
      previewLifecycleTransition: (i: typeof input) => OpResult;
    }
  ).previewLifecycleTransition(input);
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
