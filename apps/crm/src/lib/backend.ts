import { Amplify } from "aws-amplify";

/**
 * amplify_outputs.json is generated, never committed:
 *   - locally: `npm run outputs` (fetches the web app's staging backend)
 *   - in CI: `npx ampx generate outputs` in the amplify.yml build phase
 *
 * The CRM shares the backend owned by apps/web rather than deploying its
 * own. import.meta.glob keeps the build working when the file is absent —
 * the app then runs without backend config (see the status pill in App).
 */
const candidates = import.meta.glob<Record<string, unknown>>(
  "/amplify_outputs.json",
  { import: "default" }
);

export async function connectBackend(): Promise<boolean> {
  const loader = candidates["/amplify_outputs.json"];
  if (!loader) return false;
  Amplify.configure(
    (await loader()) as Parameters<typeof Amplify.configure>[0]
  );
  return true;
}
