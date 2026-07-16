import { defineConfig } from "vitest/config";

/**
 * Backend unit tests. These cover the Lambda business rules in
 * `amplify/functions/**`, which are otherwise only exercised by deploying.
 *
 * Not included in any Lambda bundle: Amplify's esbuild starts from each
 * function's `entry` and follows imports, and nothing imports a `.test.ts`.
 */
export default defineConfig({
  test: {
    include: ["amplify/**/*.test.ts"],
    environment: "node",
  },
});
