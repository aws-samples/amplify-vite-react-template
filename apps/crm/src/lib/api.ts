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
