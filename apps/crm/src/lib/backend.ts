import { Amplify } from "aws-amplify";

/**
 * amplify_outputs.json is generated, never committed:
 *   - locally: `npm run outputs` (fetches the web app's staging backend)
 *   - in CI: `npx ampx generate outputs` in the amplify.yml build phase
 *
 * The CRM shares the backend owned by apps/web rather than deploying its
 * own. import.meta.glob keeps the build working when the file is absent —
 * the app then shows the not-configured screen.
 */
const candidates = import.meta.glob<Record<string, unknown>>(
  "/amplify_outputs.json",
  { import: "default" }
);

let outputs: Record<string, unknown> | null = null;

export async function connectBackend(): Promise<boolean> {
  const loader = candidates["/amplify_outputs.json"];
  if (!loader) return false;
  outputs = await loader();
  Amplify.configure(outputs as Parameters<typeof Amplify.configure>[0]);
  return true;
}

/** Custom backend outputs (Function URLs published by backend.ts). */
export function getCustomOutput(key: string): string | null {
  const custom = (outputs as { custom?: Record<string, unknown> } | null)
    ?.custom;
  const value = custom?.[key];
  return typeof value === "string" ? value : null;
}
