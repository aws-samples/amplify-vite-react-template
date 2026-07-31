import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import Anthropic from "@anthropic-ai/sdk";
import type { Schema } from "../../data/resource";

/**
 * Two invocation modes:
 *  1. AppSync resolver (startLeadExtraction mutation): marks the account
 *     PENDING, re-invokes itself asynchronously with a work payload, and
 *     returns immediately (AppSync caps resolvers at 30s).
 *  2. Worker (async self-invoke): gathers OCR text/tables from the account's
 *     documents, calls Claude with a strict JSON schema, and writes the
 *     extraction result back onto the account.
 */

const lambda = new LambdaClient();

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

// ── Extraction schema (structured outputs — additionalProperties:false,
//    every property required, nullable via type arrays) ─────────────────

const field = (valueType: string | string[]) => ({
  // Every value is a plain string — no nullable/union types. Structured
  // outputs caps union-typed parameters at 16, and per-field
  // value/evidence/source nullability blew past that. "" means "not found";
  // numbers come back as digit strings, booleans as "Yes"/"No" — coerced
  // client-side on apply. valueType is retained only for the description.
  type: "object",
  properties: {
    value: {
      type: "string",
      description:
        Array.isArray(valueType) || valueType === "string"
          ? "The extracted value, or empty string if not found"
          : `The extracted ${valueType} as a plain string (digits only for numbers, "Yes"/"No" for booleans), or empty string if not found`,
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: {
      type: "string",
      description: "Short verbatim quote (<=150 chars) supporting the value, or empty string",
    },
    source: { type: "string", description: "Filename the value came from, or empty string" },
  },
  required: ["value", "confidence", "evidence", "source"],
  additionalProperties: false,
});

const enumField = (values: string[]) => ({
  type: "object",
  properties: {
    // Single-type string enum with "" allowed — not a union.
    value: { type: "string", enum: [...values, ""] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: { type: "string" },
    source: { type: "string" },
  },
  required: ["value", "confidence", "evidence", "source"],
  additionalProperties: false,
});

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    contactFirstName: field("string"),
    contactLastName: field("string"),
    contactEmail: field("string"),
    contactPhone: field("string"),
    address: field("string"),
    city: field("string"),
    state: {
      ...field("string"),
      description: "Two-letter US state code",
    },
    zip: field("string"),
    unitCount: field("integer"),
    yearBuilt: field("integer"),
    totalInsuredValue: field("number"),
    constructionType: enumField([
      "FRAME",
      "JOISTED_MASONRY",
      "NON_COMBUSTIBLE",
      "MASONRY_NON_COMBUSTIBLE",
      "MODIFIED_FIRE_RESISTIVE",
      "FIRE_RESISTIVE",
    ]),
    stories: field("integer"),
    coastal: field("boolean"),
    milesToCoast: field("number"),
    roofUpdatedYear: field("integer"),
    hvacUpdatedYear: field("integer"),
    electricalUpdatedYear: field("integer"),
    plumbingUpdatedYear: field("integer"),
    firewallsVerified: field("boolean"),
    currentCarrier: field("string"),
    currentAgent: {
      ...field("string"),
      description: "Incumbent agent/broker/agency servicing the account (not the carrier)",
    },
    currentAnnualPremium: field("number"),
    currentPolicyExpiration: {
      ...field("string"),
      description: "ISO date YYYY-MM-DD of current policy expiration",
    },
    buildings: {
      type: "array",
      description: "Individual buildings with square footage, if documented",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Building name/label, or empty string" },
          sqft: { type: "string", description: "Square footage as digits only, or empty string" },
        },
        required: ["label", "sqft"],
        additionalProperties: false,
      },
    },
    summary: {
      type: "string",
      description: "2-3 sentence underwriting summary of what the documents show",
    },
  },
  required: [
    "contactFirstName",
    "contactLastName",
    "contactEmail",
    "contactPhone",
    "address",
    "city",
    "state",
    "zip",
    "unitCount",
    "yearBuilt",
    "totalInsuredValue",
    "constructionType",
    "stories",
    "coastal",
    "milesToCoast",
    "roofUpdatedYear",
    "hvacUpdatedYear",
    "electricalUpdatedYear",
    "plumbingUpdatedYear",
    "firewallsVerified",
    "currentCarrier",
    "currentAgent",
    "currentAnnualPremium",
    "currentPolicyExpiration",
    "buildings",
    "summary",
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are a commercial insurance data-extraction assistant for an agency that writes condominium/HOA association master policies. You are given the OCR'd contents of documents attached to a lead (prior policy packets, association budgets, dues schedules, condo documents, loss runs).

Extract every requested datapoint you can find. Rules:
- Every value is a STRING. Use an empty string "" when the documents don't support a value — never guess or infer beyond the text.
- For numeric values return digits only, no "$", commas, or units (e.g. "5000000", "1985", "120"). For yes/no values return "Yes" or "No". Dates as YYYY-MM-DD.
- For each value give a short verbatim evidence quote and the source filename (or "" when the value is empty).
- Confidence: "high" when explicitly stated, "medium" when derived (e.g. summing per-building values), "low" when ambiguous or conflicting across documents.
- totalInsuredValue is the building/property limit (TIV), not liability limits or premium.
- Construction type maps to ISO classes (frame, joisted masonry, non-combustible, masonry non-combustible, modified fire resistive, fire resistive).
- If documents conflict, prefer the most recent/most authoritative (declarations page over marketing text) and note the conflict in the evidence.`;

// Category priority — most data-dense documents first, so caps trim the tail.
const CATEGORY_PRIORITY: Record<string, number> = {
  PRIOR_POLICY: 0,
  BUDGET: 1,
  DUES_SCHEDULE: 2,
  LOSS_RUNS: 3,
  OTHER: 4,
  QUOTE_DOC: 5,
  POLICY_DOC: 6,
  CONDO_DOCS: 7, // huge and low-density — last
  ACORD_FORM: 8,
  LICENSE: 9,
};

const TOTAL_CHAR_BUDGET = 400_000; // ~100K tokens of document text

function renderTables(raw: unknown): string {
  let v: unknown = raw;
  try {
    if (typeof v === "string") v = JSON.parse(v);
    if (typeof v === "string") v = JSON.parse(v);
  } catch {
    return "";
  }
  if (!Array.isArray(v)) return "";
  return (v as string[][][])
    .map((table, i) => `\n[Table ${i + 1}]\n` + table.map((row) => row.join("\t")).join("\n"))
    .join("\n");
}

async function runExtraction(accountId: string) {
  const client = await getDataClient();

  try {
    // DynamoDB applies `filter` AFTER reading a page, so a single list() call
    // returns nothing once the account's documents fall outside the first
    // ~100 scanned rows — which is exactly what happens as the table grows
    // across accounts. Page through until the token is exhausted.
    const docs: Awaited<
      ReturnType<typeof client.models.Document.list>
    >["data"] = [];
    let nextToken: string | undefined;
    do {
      const page = await client.models.Document.list({
        filter: { entityId: { eq: accountId }, ocrStatus: { eq: "COMPLETE" } },
        limit: 1000,
        nextToken,
      });
      docs.push(...page.data);
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);

    if (!docs.length) throw new Error("No OCR-complete documents on this account.");

    const sorted = [...docs].sort(
      (a, b) =>
        (CATEGORY_PRIORITY[a.category ?? "OTHER"] ?? 4) -
        (CATEGORY_PRIORITY[b.category ?? "OTHER"] ?? 4)
    );

    let budget = TOTAL_CHAR_BUDGET;
    const parts: string[] = [];
    let included = 0;
    for (const doc of sorted) {
      if (budget <= 5_000) break;
      const body = `${doc.ocrText ?? ""}${renderTables(doc.ocrTables)}`;
      const slice = body.slice(0, budget);
      parts.push(
        `===== DOCUMENT: ${doc.name} (category: ${doc.category ?? "OTHER"}) =====\n${slice}${
          slice.length < body.length ? "\n[document truncated]" : ""
        }`
      );
      budget -= slice.length;
      included++;
    }

    // Strict structured-output grammar can't compile for a schema this wide
    // ("compiled grammar too large"). Describe the exact JSON shape in the
    // prompt instead and parse defensively — Opus 4.8 returns clean JSON.
    const dataKeys = Object.keys(EXTRACTION_SCHEMA.properties).filter(
      (k) => k !== "buildings" && k !== "summary"
    );
    const shapeInstruction = `Respond with ONLY a JSON object — no markdown fences, no commentary. The object has exactly these keys:
${dataKeys.join(", ")}
Each of those keys maps to: { "value": <string>, "confidence": "high"|"medium"|"low", "evidence": <string>, "source": <string> }.
Also include:
  "buildings": array of { "label": <string>, "sqft": <string, digits only> } — [] if none documented,
  "summary": <string, 2-3 sentence underwriting summary>.
For "constructionType".value use exactly one of: FRAME, JOISTED_MASONRY, NON_COMBUSTIBLE, MASONRY_NON_COMBUSTIBLE, MODIFIED_FIRE_RESISTIVE, FIRE_RESISTIVE, or "".`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT + "\n\n" + shapeInstruction,
      messages: [
        {
          role: "user",
          content: `Extract the lead datapoints from these ${included} document(s):\n\n${parts.join(
            "\n\n"
          )}`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("Extraction was declined by the model.");
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("No extraction output returned.");
    // Tolerate stray fences / prose around the JSON object.
    let raw = text.text.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();
    const open = raw.indexOf("{");
    const close = raw.lastIndexOf("}");
    if (open > 0 || close < raw.length - 1) raw = raw.slice(open, close + 1);
    const result = JSON.parse(raw);

    const { errors } = await client.models.Account.update({
      id: accountId,
      extractionStatus: "COMPLETE",
      aiExtraction: JSON.stringify({
        ...result,
        extractedAt: new Date().toISOString(),
        documentCount: included,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      }),
      extractionError: null,
    });
    if (errors?.length) throw new Error(errors[0].message);
    console.log(
      `Extraction complete for ${accountId}: ${included} docs, ` +
        `${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`
    );
  } catch (err) {
    console.error(`Extraction failed for ${accountId}`, err);
    await client.models.Account.update({
      id: accountId,
      extractionStatus: "FAILED",
      extractionError: err instanceof Error ? err.message : String(err),
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = async (event: any) => {
  // Worker branch (async self-invoke)
  if (event?.work?.accountId) {
    await runExtraction(event.work.accountId);
    return { ok: true };
  }

  // Resolver branch (AppSync mutation)
  const accountId: string | undefined = event?.arguments?.accountId;
  if (!accountId) return { ok: false, error: "accountId is required" };

  const client = await getDataClient();
  await client.models.Account.update({
    id: accountId,
    extractionStatus: "PENDING",
    extractionError: null,
  });

  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ work: { accountId } })),
    })
  );

  return { ok: true, started: true };
};
