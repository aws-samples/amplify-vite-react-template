import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";

/**
 * IAM-authorized Amplify Data client for backend functions. Requires the
 * function to be granted schema access via `allow.resource(fn)` in
 * data/resource.ts. Lazily initialized so cold-start config errors surface
 * per-invocation instead of at import time.
 */
let clientPromise: Promise<ReturnType<typeof generateClient<Schema>>> | null =
  null;

export function dataClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { resourceConfig, libraryOptions } =
        await getAmplifyDataClientConfig(
          process.env as unknown as Parameters<
            typeof getAmplifyDataClientConfig
          >[0]
        );
      Amplify.configure(resourceConfig, libraryOptions);
      return generateClient<Schema>({ authMode: "iam" });
    })();
  }
  return clientPromise;
}
