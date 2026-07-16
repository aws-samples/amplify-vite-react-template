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
export type Invoice = Schema["Invoice"]["type"];
export type Quote = Schema["Quote"]["type"];
export type LeadPricingRun = Schema["LeadPricingRun"]["type"];
export type Product = Schema["Product"]["type"];

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

/**
 * How the office quotes a price it can see on screen. Same contract
 * boundary: the backend wave replaces quoteFromTemplate with createQuote —
 * planName + serviceFrequency + listPriceCents ride in directly (plan
 * templates are gone). The deviation guard lives server-side: it re-reads
 * the live AI sheets for the customer's area, refuses a listPriceCents no
 * live sheet carries, and a priceCents that differs from it needs
 * priceOverrideReason, recorded on the quote with the caller's name.
 */
export function createQuoteMutation(args: {
  customerId: string;
  planName: string;
  serviceFrequency: "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
  priceCents: number;
  listPriceCents: number;
  initialFeeCents?: number | null;
  priceOverrideReason?: string | null;
  /** HOA quotes: unit count, so the server can verify per-unit × units. */
  units?: number | null;
  notes?: string | null;
}) {
  const mutations = api().mutations as unknown as {
    createQuote: (a: typeof args) => Promise<{
      data: unknown;
      errors?: { message: string }[];
    }>;
  };
  return mutations.createQuote(args);
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
