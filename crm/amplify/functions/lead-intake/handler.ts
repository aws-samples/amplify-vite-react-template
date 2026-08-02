import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import type { Schema } from "../../data/resource";
// Shares crm/src the way this handler already shares nothing else — see
// pagination.ts: enums.ts imports no runtime value beyond `shared/`, so it
// carries no browser data client into the bundle.
import { DEFAULT_ACCOUNT_TYPE, isAccountType } from "../../../src/lib/enums";

/**
 * Public website → CRM lead intake.
 *
 * Exposed via the API-key-authorized `submitWebLead` mutation so the static
 * marketing site can create leads directly. Everything is forced to
 * stage=LEAD / source=website here regardless of input — the public surface
 * can only ever create leads.
 */

let dataClient: ReturnType<typeof generateClient<Schema>> | undefined;

async function getDataClient() {
  if (!dataClient) {
    const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
      process.env as never
    );
    Amplify.configure(resourceConfig, libraryOptions);
    dataClient = generateClient<Schema>();
  }
  return dataClient;
}

const clean = (v: string | null | undefined, max = 500): string | undefined => {
  const t = v?.trim();
  return t ? t.slice(0, max) : undefined;
};

export const handler: Schema["submitWebLead"]["functionHandler"] = async (
  event
) => {
  const args = event.arguments;
  const client = await getDataClient();

  const name = clean(args.name, 200);
  if (!name) return { ok: false, error: "name is required" };

  const type = isAccountType(args.type) ? args.type : DEFAULT_ACCOUNT_TYPE;

  const email = clean(args.contactEmail, 320);
  // a.email() on Account rejects malformed addresses outright; drop instead
  // of losing the whole lead over a typo'd email.
  const validEmail = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;

  const extraNotes = [
    clean(args.notes, 2000),
    validEmail !== email && email ? `Email (unvalidated): ${email}` : undefined,
    clean(args.unitNumber) && `Unit: ${clean(args.unitNumber)}`,
    clean(args.currentCarrier) && `Current carrier: ${clean(args.currentCarrier)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, errors } = await client.models.Account.create({
    stage: "LEAD",
    type,
    name,
    contactFirstName: clean(args.contactFirstName, 100),
    contactLastName: clean(args.contactLastName, 100),
    contactEmail: validEmail,
    contactPhone: undefined, // free-form phone goes to notes; a.phone() is strict
    address: clean(args.address, 300),
    city: clean(args.city, 100),
    state: clean(args.state, 2)?.toUpperCase(),
    zip: clean(args.zip, 10),
    buildiumId: clean(args.buildiumId, 50),
    source: clean(args.source, 100) ?? "website",
    notes:
      [extraNotes, clean(args.contactPhone) && `Phone: ${clean(args.contactPhone)}`]
        .filter(Boolean)
        .join("\n") || undefined,
  });

  if (errors?.length || !data) {
    console.error("Lead intake failed", JSON.stringify(errors));
    return { ok: false, error: errors?.[0]?.message ?? "create failed" };
  }
  console.log(`Web lead created: ${data.id} (${name})`);
  return { ok: true, id: data.id };
};
