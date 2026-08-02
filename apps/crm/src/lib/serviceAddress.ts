/**
 * Service-address composition for the CRM.
 *
 * The rules live in amplify/functions/shared/serviceAddress.ts — the ONE place
 * a customer's service address is composed. This file used to be a hand-kept
 * copy of them; it now re-exports the server module directly, so routing and
 * display can no longer drift between the office screens and the backend that
 * schedules against them.
 *
 * Only `shortDisplayAddress` lives here: it is a CRM list-row presentation
 * concern with no server caller.
 */

export type { ServiceAddressFields } from "../../../web/amplify/functions/shared/serviceAddress";
export {
  displayAddress,
  qualifyUnit,
  routingAddress,
} from "../../../web/amplify/functions/shared/serviceAddress";

import type { ServiceAddressFields } from "../../../web/amplify/functions/shared/serviceAddress";
import { qualifyUnit } from "../../../web/amplify/functions/shared/serviceAddress";

const clean = (v: string | null | undefined) => (v ?? "").trim();

/** Short form for list rows: street (+ unit) and city. */
export function shortDisplayAddress(c: ServiceAddressFields): string {
  const unit = clean(c.serviceUnit);
  const line1 = [clean(c.serviceStreet), unit ? qualifyUnit(unit) : ""]
    .filter(Boolean)
    .join(", ");
  return [line1, clean(c.serviceCity)].filter(Boolean).join(", ");
}
