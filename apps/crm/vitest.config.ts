import { defineConfig } from "vitest/config";

/**
 * CRM unit tests. Cover the business rules the office screens compute —
 * revenue totals, refundability — as pure functions in `src/lib`, so they can
 * be tested without a DOM and without mocking Amplify.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
