import { defineFunction } from "@aws-amplify/backend";

/**
 * Office pricing administration: targeted market research and controlled
 * catalog rollback. The CRM no longer exposes a lead quote mutation; staff
 * and customers both use the public booking funnel as the one quote engine.
 *
 * The legacy lead-pricing implementation remains private inside the bundle
 * while historical pricing-run tests/data are retained, but it has no schema
 * resolver and therefore no callable CRM surface.
 */
export const crmPricing = defineFunction({
  name: "crm-pricing",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
});
