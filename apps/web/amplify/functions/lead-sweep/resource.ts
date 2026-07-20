import { defineFunction } from "@aws-amplify/backend";

export const leadSweep = defineFunction({
  name: "lead-sweep",
  entry: "./handler.ts",
  timeoutSeconds: 120,
  schedule: "0/15 * * * ? *",
});
