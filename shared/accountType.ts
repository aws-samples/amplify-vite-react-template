/**
 * `AccountType` — the one schema enum that crosses the app boundary.
 *
 * The marketing site posts leads into the CRM through the `submitWebLead`
 * mutation, so `web` needs to name the same three account types the CRM's
 * schema declares. It cannot import them: `crm` and `web` are two independent
 * npm projects (see the two `appRoot`s in amplify.yml), there is no workspace,
 * and `@aws-amplify/backend` — which `crm/amplify/data/resource.ts` imports as
 * a *value* — is not installed under `web/`.
 *
 * So this file follows the `shared/agency.ts` pattern: dependency-free and
 * value-only, which is what lets a plain relative import work from an Astro
 * page, a React island, a Vite SPA module and a Vitest test with no
 * build-system plumbing.
 *
 *   from crm:  import { ACCOUNT_TYPES } from "../../../shared/accountType";
 *   from web:  import type { AccountType } from "../../shared/accountType";
 *
 * This is a hand-written copy of a schema enum, which is exactly what the rest
 * of this migration deletes — it survives only because the import is
 * impossible. It does not drift, because `crm/src/lib/enums.ts` asserts this
 * list against `Schema["AccountType"]["type"]` in both directions, so crm's
 * `tsc` fails if the schema and this file disagree. Edit the schema first.
 */

/** The schema's `AccountType`, in schema order (resource.ts:24). */
export const ACCOUNT_TYPES = [
  "ASSOCIATION",
  "PERSONAL",
  "COMMERCIAL_OTHER",
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];
