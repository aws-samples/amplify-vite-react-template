import { defineFunction } from "@aws-amplify/backend";

/**
 * Public booking-funnel API (quote / book / cancel) behind a Function URL.
 * Long timeout: first quote in a new area may run AI market research, and
 * availability pricing calls the Google Routes matrix.
 */
export const bookingPublic = defineFunction({
  name: "booking-public",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  memoryMB: 512,
});
