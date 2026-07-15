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
export type PlanTemplate = Schema["PlanTemplate"]["type"];
export type Quote = Schema["Quote"]["type"];
export type LeadPricingRun = Schema["LeadPricingRun"]["type"];

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
