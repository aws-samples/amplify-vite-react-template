import { randomBytes } from "node:crypto";
import type { AppSyncResolverEvent } from "aws-lambda";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import Anthropic from "@anthropic-ai/sdk";
import { dataClient } from "../shared/dataClient";
import { opFieldName } from "../shared/opEvent";
import { callerEmail, callerIsOffice, callerIsOwner } from "../shared/authz";
import { bookingLinkUrl, ensureBookingLinkToken } from "../shared/bookingLink";
import { activeTechBases } from "../shared/capacity";
import { driveMinutesFromNearestBase } from "../shared/driveTime";
import { notifyLeads } from "../shared/email";
import {
  clearsLeadFee,
  freqLabel,
  money,
  oneTimeGrossProfitCents,
  priceMosquito,
  zoneFromMinutes,
  ZONE_B,
  type Frequency,
  type PricedPlan,
  type PriceLine,
  type Zone,
} from "./rateCards";
import {
  _resetRollbackMemoForTests,
  areaKeyFor,
  enqueueRateResearch,
  getCachedRate,
  hoaBandFor,
  pickServingRow,
  rateKeyFor,
  readPricingRollback,
  sqftBucket,
  type MarketRateResult,
  type MarketRateService,
  type PlanCadence,
} from "../shared/marketRate";

const s3 = new S3Client();
const ssm = new SSMClient();
const lambda = new LambdaClient();

const BUCKET = () => {
  const b = process.env.DOCS_BUCKET;
  if (!b) throw new Error("DOCS_BUCKET is not configured");
  return b;
};

/**
 * The public booking funnel — the one next step every quoted reply offers.
 * There is no reply-to-schedule and no emailed agreement: the customer
 * converts themselves at /quote (price confirmed, day picked, paid by card).
 */
const FUNNEL_URL = () =>
  `${process.env.MARKETING_URL ?? "https://www.pestbuzzkill.com"}/quote`;

type Args = {
  inputText?: string | null;
  screenshotKey?: string | null;
  customerId?: string | null;
  leadFeeCents?: number | null;
  contentType?: string;
  versionId?: string;
  reasonCode?: string;
  note?: string | null;
  rateKey?: string;
  resumeRunId?: string | null;
};

export const handler = async (event: AppSyncResolverEvent<Args>) => {
  if (!callerIsOffice(event.identity)) throw new Error("Owner role required");
  switch (opFieldName(event)) {
    case "priceLead":
      return priceLead(event.arguments);
    case "getPricingUploadUrl":
      return getPricingUploadUrl(event.arguments.contentType!);
    case "requestPricingResearch":
      return requestPricingResearch(event.arguments, callerEmail(event.identity));
    case "rollbackPricing":
      // GL-16: price authority stays role-controlled — OWNER only, checked
      // server-side on top of the schema's group rule.
      if (!callerIsOwner(event.identity)) throw new Error("Owner role required");
      return rollbackPricing(event.arguments, callerEmail(event.identity));
    case "clearPricingRollback":
      if (!callerIsOwner(event.identity)) throw new Error("Owner role required");
      return clearPricingRollback(event.arguments, callerEmail(event.identity));
    default:
      throw new Error(`Unknown field ${opFieldName(event)}`);
  }
};

// ---------------------------------------- explicit market-research request

const RESEARCH_REASONS = new Set([
  "COMPETITOR_CHANGE",
  "MARGIN_REVIEW",
  "CONVERSION_REVIEW",
  "PROMPT_CHANGE",
  "OTHER",
]);

function townFromAreaKey(areaKey: string): { city: string; state: string } | null {
  const split = areaKey.lastIndexOf("-");
  if (split <= 0 || split === areaKey.length - 1) return null;
  return {
    city: areaKey.slice(0, split).replace(/-/g, " "),
    state: areaKey.slice(split + 1).toUpperCase(),
  };
}

async function wakePricingResearch(
  rateKey: string,
  source: "quote" | "manual"
): Promise<void> {
  const functionName = process.env.PRICING_REFRESH_FUNCTION_NAME;
  if (!functionName) return;
  await lambda
    .send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ rateKey, source })),
      })
    )
    .catch((err) => {
      // The durable request remains queued; the five-minute recovery worker
      // will still pick it up.
      console.error("pricing research wake-up failed; scheduled recovery remains", err);
    });
}

/**
 * One attributable staff request for one existing market-rate key. No town
 * expansion, neighboring service, size band, or age-based refresh can ride
 * along with it.
 */
async function requestPricingResearch(
  args: Args,
  actor: string | null
): Promise<{ ok: true; rateKey: string }> {
  const rateKey = String(args.rateKey ?? "").trim();
  const reasonCode = String(args.reasonCode ?? "").trim();
  const note = args.note?.trim() ?? "";
  if (!rateKey) throw new Error("Pick the rate to research");
  if (!RESEARCH_REASONS.has(reasonCode)) {
    throw new Error("Pick a business reason for the market review");
  }
  if (reasonCode === "OTHER" && !note) {
    throw new Error("Explain the market-review reason");
  }
  if (await readPricingRollback()) {
    throw new Error(
      "AI research is paused while the catalog is rolled back — clear the rollback first"
    );
  }

  const client = await dataClient();
  const { data: rows } =
    await client.models.MarketRate.listMarketRateByRateKey({ rateKey });
  const serving = pickServingRow(rows, rateKey, null);
  if (!serving) throw new Error("This rate is not currently serving");
  if (serving.pinned) {
    throw new Error("Unpin the office rate before requesting new AI research");
  }
  const location = townFromAreaKey(serving.areaKey);
  if (!location) throw new Error("The rate's service area could not be read");
  const bandPart = rateKey.split("#")[2];
  const band = bandPart ? Number(bandPart) : null;
  if (bandPart && !Number.isFinite(band)) {
    throw new Error("The rate's size band could not be read");
  }

  const requestedAt = new Date().toISOString();
  const requestReason = `${reasonCode}${note ? ` — ${note}` : ""}`.slice(0, 500);
  const { data: existing } = await client.models.RateCoverage.get({ id: rateKey });
  if (existing) {
    const { data, errors } = await client.models.RateCoverage.update({
      id: rateKey,
      active: true,
      source: "MANUAL",
      researchRequestedAt: requestedAt,
      researchRequestedBy: actor ?? "STAFF",
      researchRequestReason: requestReason,
      exhaustedAt: null,
      nextEligibleAt: null,
      failCount: 0,
    });
    if (!data || errors?.length) {
      throw new Error(errors?.[0]?.message ?? "Could not queue market research");
    }
  } else {
    const { data, errors } = await client.models.RateCoverage.create({
      id: rateKey,
      service: serving.service,
      areaKey: serving.areaKey,
      city: location.city,
      state: location.state,
      band: band ?? undefined,
      source: "MANUAL",
      active: true,
      failCount: 0,
      researchRequestedAt: requestedAt,
      researchRequestedBy: actor ?? "STAFF",
      researchRequestReason: requestReason,
      notify: JSON.stringify([]),
    });
    if (!data || errors?.length) {
      throw new Error(errors?.[0]?.message ?? "Could not queue market research");
    }
  }

  await wakePricingResearch(rateKey, "manual");
  return { ok: true, rateKey };
}

// ------------------------------------------------- GL-16 catalog rollback

const ROLLBACK_REASONS = new Set([
  "BAD_PROMPT_RESULT",
  "MODEL_ERROR",
  "BULK_MISTAKE",
  "OTHER",
]);

/**
 * ONE atomic write flips the whole catalog back to the sheet that served at
 * the cutoff (pinned office rows still win), pauses research publication,
 * and records who/why/when. History is untouched — nothing is edited or
 * deleted, so clearing the rollback restores the newest rows just as
 * atomically.
 */
async function rollbackPricing(
  args: Args,
  actor: string | null
): Promise<{ ok: true; versionId: string }> {
  const versionId = String(args.versionId ?? "");
  const reasonCode = String(args.reasonCode ?? "");
  if (!versionId) {
    throw new Error("Pick the catalog version to restore");
  }
  if (!ROLLBACK_REASONS.has(reasonCode)) {
    throw new Error("A controlled rollback reason is required");
  }
  const reason = `${reasonCode}${args.note?.trim() ? ` — ${args.note.trim()}` : ""}`;
  const client = await dataClient();
  // The version must EXIST and parse before the pointer moves — a rollback
  // to an unreadable version would serve pinned rows only, silently.
  const versionModels = client.models as unknown as {
    CatalogVersion?: {
      get: (a: { id: string }) => Promise<{
        data: { manifestJson?: string | null; keyCount?: number | null } | null;
      }>;
    };
  };
  if (!versionModels.CatalogVersion) {
    throw new Error("Catalog versions are unavailable — nothing changed");
  }
  const { data: version } = await versionModels.CatalogVersion.get({
    id: versionId,
  });
  if (!version?.manifestJson) {
    throw new Error("That catalog version doesn't exist — nothing changed");
  }
  try {
    const parsed = JSON.parse(version.manifestJson) as Record<string, string>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
  } catch {
    throw new Error(
      "That catalog version's manifest is unreadable — pick another version; nothing changed"
    );
  }
  const nowIso = new Date().toISOString();
  const sets = {
    id: "catalog-rollback",
    kind: "ROLLBACK",
    rollbackVersionId: versionId,
    rollbackCutoff: null,
    rollbackReason: reason.slice(0, 500),
    rollbackActor: actor ?? "OWNER",
    rollbackAppliedAt: nowIso,
    rollbackClearedBy: null,
    rollbackClearedAt: null,
  };
  const { data: existing } = await client.models.PricingControl.get({
    id: "catalog-rollback",
  });
  if (existing) {
    const { data, errors } = await client.models.PricingControl.update(sets);
    if (!data || errors?.length) {
      throw new Error("The rollback could not be recorded — nothing changed");
    }
  } else {
    const { data, errors } = await client.models.PricingControl.create(sets);
    if (!data || errors?.length) {
      throw new Error("The rollback could not be recorded — nothing changed");
    }
  }
  _resetRollbackMemoForTests();
  await notifyLeads({
    subject: `PRICING ROLLED BACK to version ${versionId}`,
    heading: "AI pricing catalog rolled back",
    template: "ops-pricing-rollback",
    bodyHtml: `<p>${actor ?? "An owner"} rolled the rate catalog back to immutable version <strong>${versionId}</strong> (${reason}; ${version.keyCount ?? "?"} rate keys). Quotes now serve exactly that version's rows (office-pinned rows still win), and AI research is paused until the rollback is cleared from Market Rates.</p>`,
  }).catch(() => undefined);
  return { ok: true, versionId };
}

async function clearPricingRollback(
  args: Args,
  actor: string | null
): Promise<{ ok: true }> {
  const client = await dataClient();
  const { data: existing } = await client.models.PricingControl.get({
    id: "catalog-rollback",
  });
  if (!existing?.rollbackVersionId && !existing?.rollbackCutoff) {
    return { ok: true }; // idempotent
  }
  const { data, errors } = await client.models.PricingControl.update({
    id: "catalog-rollback",
    rollbackVersionId: null,
    rollbackCutoff: null,
    rollbackClearedBy: `${actor ?? "OWNER"}${args.note?.trim() ? ` — ${args.note.trim()}` : ""}`.slice(0, 500),
    rollbackClearedAt: new Date().toISOString(),
  });
  if (!data || errors?.length) {
    throw new Error("The rollback could not be cleared — it is still active");
  }
  _resetRollbackMemoForTests();
  await notifyLeads({
    subject: "Pricing rollback cleared — newest rates serve again",
    heading: "AI pricing rollback cleared",
    template: "ops-pricing-rollback",
    bodyHtml: `<p>${actor ?? "An owner"} cleared the catalog rollback. The newest rate rows serve again and AI research resumes on the next refresh run.</p>`,
  }).catch(() => undefined);
  return { ok: true };
}

// ---------- secrets (runtime SSM; cached per container) ----------

const secretCache = new Map<string, string | null>();

async function getSecret(name: string): Promise<string | null> {
  // Baked-in env (from Amplify Console app env vars) wins — no SSM needed.
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv !== "placeholder-set-me") return fromEnv;
  if (secretCache.has(name)) return secretCache.get(name) ?? null;
  const appId = process.env.AMPLIFY_APP_ID ?? "d26qpsjewk0bee";
  let value: string | null = null;
  for (const path of [
    `/amplify/${appId}/${process.env.AMPLIFY_BRANCH ?? "staging"}/${name}`,
    `/amplify/shared/${appId}/${name}`,
  ]) {
    try {
      const res = await ssm.send(
        new GetParameterCommand({ Name: path, WithDecryption: true })
      );
      if (res.Parameter?.Value && res.Parameter.Value !== "placeholder-set-me") {
        value = res.Parameter.Value;
        break;
      }
    } catch {
      /* parameter absent — try the next path */
    }
  }
  // Only cache hits: a missing key added later must not be pinned to null
  // for the container's whole lifetime.
  if (value !== null) secretCache.set(name, value);
  return value;
}

// ---------- screenshot upload ----------

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

async function getPricingUploadUrl(contentType: string) {
  const ext = IMAGE_TYPES[contentType.toLowerCase()];
  if (!ext) throw new Error("Unsupported image type — use PNG, JPEG, WEBP, or GIF");
  const key = `pricing/${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType }),
    { expiresIn: 900 }
  );
  return { key, uploadUrl, expiresInSeconds: 900 };
}

// ---------- extraction (Claude) ----------

type Extraction = {
  eligibility:
    | "ok"
    | "wildlife"
    | "bed_bugs"
    | "food_service"
    | "fumigation"
    | "out_of_area";
  propertyType:
    | "residential"
    | "association"
    | "commercial"
    | "mosquito"
    | "specialty"
    | "unknown";
  specialtyKind:
    | "wasp_nest"
    | "rodent_nest"
    | "rodent_exclusion"
    | "roach"
    | "termite"
    | "none";
  pest: string;
  customerName: string | null;
  town: string | null;
  state: string | null;
  fullAddress: string | null;
  sqft: number | null;
  units: number | null;
  nestCount: number | null;
  animalCount: number | null;
  halfAcres: number | null;
  tick: boolean;
  frequencyInterest: "monthly" | "bimonthly" | "quarterly" | "one_time" | "unspecified";
  leadFeeCents: number | null;
  rodentInterest: boolean;
  multiProperty: boolean;
  competitorMatchBelowFloor: boolean;
  complianceDocsRequested: boolean;
  assumptions: string[];
};

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "eligibility", "propertyType", "specialtyKind", "pest", "customerName",
    "town", "state", "fullAddress", "sqft", "units", "nestCount", "animalCount", "halfAcres",
    "tick", "frequencyInterest", "leadFeeCents", "rodentInterest",
    "multiProperty", "competitorMatchBelowFloor", "complianceDocsRequested",
    "assumptions",
  ],
  properties: {
    eligibility: { type: "string", enum: ["ok", "wildlife", "bed_bugs", "food_service", "fumigation", "out_of_area"] },
    propertyType: { type: "string", enum: ["residential", "association", "commercial", "mosquito", "specialty", "unknown"] },
    specialtyKind: { type: "string", enum: ["wasp_nest", "rodent_nest", "rodent_exclusion", "roach", "termite", "none"] },
    pest: { type: "string" },
    customerName: { type: ["string", "null"] },
    town: { type: ["string", "null"] },
    state: { type: ["string", "null"] },
    fullAddress: { type: ["string", "null"] },
    sqft: { type: ["number", "null"] },
    units: { type: ["number", "null"] },
    nestCount: { type: ["number", "null"] },
    animalCount: { type: ["number", "null"] },
    halfAcres: { type: ["number", "null"] },
    tick: { type: "boolean" },
    frequencyInterest: { type: "string", enum: ["monthly", "bimonthly", "quarterly", "one_time", "unspecified"] },
    leadFeeCents: { type: ["number", "null"] },
    rodentInterest: { type: "boolean" },
    multiProperty: { type: "boolean" },
    competitorMatchBelowFloor: { type: "boolean" },
    complianceDocsRequested: { type: "boolean" },
    assumptions: { type: "array", items: { type: "string" } },
  },
} as const;

const EXTRACTION_SYSTEM = `You are the intake extractor for BuzzKill Pest Control's lead-pricing engine (technicians are dispatched from their own home bases across eastern and central MA, not a single office; licensed in MA and RI only). You read a pasted Thumbtack lead (text and/or screenshot) and extract structured facts. You NEVER compute prices — a deterministic rate-card engine does that.

Eligibility (hard passes):
- "bed_bugs": any bed bug work.
- "food_service": restaurants, cafés, bars, commercial kitchens, food processing/handling, grocery.
- "fumigation": fumigation or tenting requests.
- "out_of_area": service address clearly outside MA and RI (CT, NH, VT, NY — even if close).
- "wildlife" is NOT a pass: set eligibility "wildlife" for wildlife work — squirrels, raccoons, bats, birds, snakes, skunks, opossums — and the engine quotes it as a one-time wildlife exclusion/removal visit. NOTE: dead rodents, mice, and rats INSIDE a structure are pest control (eligibility "ok"), not wildlife.
Otherwise "ok".

Property type: "association" for HOA/condo-association COMMON AREAS (unit counts); an individual condo unit is "residential". "mosquito" when the request is mosquito and/or tick yard treatment. "specialty" for wasp/hornet nest removal, rodent nest removal, rodent exclusion, a specialized roach/German-cockroach cleanout, or termite work (set specialtyKind). Otherwise "residential"/"commercial"/"unknown".

Extraction rules:
- sqft: null when not stated (the engine assumes 2,000 sqft and states the assumption). Do not guess.
- nestCount: how many wasp/hornet nests the lead mentions; null when not stated (the engine assumes one and states the assumption).
- animalCount: for wildlife work, how many animals need removed; null when not stated (the engine assumes one and states the assumption).
- halfAcres: yard size in half-acre increments for mosquito/tick leads; null when unknown (engine assumes up to ½ acre).
- leadFeeCents: the Thumbtack lead fee, in CENTS, when visible in the text/screenshot; null otherwise.
- frequencyInterest: only when the lead stated one.
- rodentInterest: true when mice/rats are mentioned at all.
- multiProperty: investor/property-manager portfolios across multiple properties.
- competitorMatchBelowFloor: they ask to match a lower competitor price.
- complianceDocsRequested: commercial compliance documentation / audit support.
- assumptions: every assumption you made, phrased for the customer reply (e.g. "assumed a typical ~2,000 sqft home — we'll confirm on the first visit").
- Do not infer facts that aren't there; null is always better than a guess.`;

async function extractLead(
  anthropic: Anthropic,
  inputText: string | null,
  screenshot: { data: string; mediaType: string } | null
): Promise<Extraction> {
  const content: Anthropic.ContentBlockParam[] = [];
  if (screenshot) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: screenshot.mediaType as "image/png",
        data: screenshot.data,
      },
    });
  }
  content.push({
    type: "text",
    text: `Extract the lead facts from this Thumbtack lead:\n\n${inputText ?? "(screenshot only)"}`,
  });

  const response = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content }],
    output_config: {
      format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
    },
  });
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to process this lead text");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("No extraction returned");
  return JSON.parse(text.text) as Extraction;
}

// ---------- zone (Google Routes API) ----------

/**
 * Minutes from the CLOSEST technician's home base. Lead triage PASSes a lead
 * when this exceeds 90 minutes, so the origin decides whether a paid lead is
 * refused: measuring from one fixed address discarded leads that a technician
 * lives minutes from. Null (no key, unreadable roster, unroutable) leaves the
 * zone UNKNOWN rather than PASSing — never refuse on an infrastructure fault.
 */
async function driveMinutes(address: string): Promise<number | null> {
  const key = await getSecret("GOOGLE_ROUTES_API_KEY");
  if (!key) return null;
  const bases = await activeTechBases();
  if (!bases) return null;
  return driveMinutesFromNearestBase(key, bases, address);
}

// ---------- pass scripts (deterministic, straight from the spec) ----------

const PASS_SCRIPTS: Record<string, string> = {
  bed_bugs:
    "Thanks for reaching out! Bed bug treatment is outside the services we offer, so I don't want to hold you up — you'll want a company that specializes there. If you ever need general pest, rodent, or mosquito control, we'd be glad to help.",
  food_service:
    "Thanks for reaching out! Food-service facilities are outside the services we offer, so I don't want to hold you up — you'll want a company that specializes there. If you ever need general pest, rodent, or mosquito control, we'd be glad to help.",
  fumigation:
    "Thanks for reaching out! Fumigation is outside the services we offer, so I don't want to hold you up — you'll want a company that specializes there. If you ever need general pest, rodent, or mosquito control, we'd be glad to help.",
  out_of_area:
    "Thanks for reaching out! Your address falls outside our current licensed service area (Massachusetts & Rhode Island, within our route zone), so we're not able to take this one on. Wishing you a quick fix!",
};

// ---------- AI base price → priced plan (deterministic zone overlay) ----------

/** Durable, resumable state while the exact rate sheet is being researched. */
export const AI_RATE_RESEARCHING_REASON =
  "AI is researching this exact service, location, and size. The quote will finish automatically.";

/**
 * A recurring GP plan from the researched sheet, with the deterministic
 * Zone B travel adders on top — exactly as the website funnel prices it
 * (R60: an 89-minute drive must not price like a 10-minute one).
 */
function planFromSheet(
  rate: MarketRateResult,
  cadence: PlanCadence,
  zone: Zone,
  serviceName = "Residential GPC"
): PricedPlan | null {
  const plan = rate.sheet.plans?.[cadence];
  if (!plan) return null;
  const lines: PriceLine[] = [
    {
      label: `AI market rate — ${freqLabel(cadence)} plan`,
      cents: plan.monthlyCents,
    },
    { label: "AI market rate — initial visit", cents: plan.initialFeeCents },
  ];
  let monthly = plan.monthlyCents;
  let initial = plan.initialFeeCents;
  if (zone === "B") {
    lines.push({ label: "Zone B travel adder (monthly)", cents: ZONE_B[cadence] });
    lines.push({
      label: "Zone B travel adder (initial)",
      cents: ZONE_B.ONE_TIME_FLAT,
    });
    monthly += ZONE_B[cadence];
    initial += ZONE_B.ONE_TIME_FLAT;
  }
  return {
    service: `${serviceName} — ${freqLabel(cadence)}`,
    frequency: cadence,
    monthlyCents: monthly,
    oneTimeCents: null,
    initialFeeCents: initial,
    lines,
  };
}

/** A one-time price from the sheet with the Zone B flat adder on top. */
function oneTimeFromSheet(opts: {
  service: string;
  lines: PriceLine[];
  baseCents: number;
  zone: Zone;
}): PricedPlan {
  const lines = [...opts.lines];
  let total = opts.baseCents;
  if (opts.zone === "B") {
    lines.push({ label: "Zone B travel adder", cents: ZONE_B.ONE_TIME_FLAT });
    total += ZONE_B.ONE_TIME_FLAT;
  }
  return {
    service: opts.service,
    frequency: "ONE_TIME",
    monthlyCents: null,
    oneTimeCents: total,
    initialFeeCents: null,
    lines,
  };
}

// ---------- reply composition ----------

async function composeReply(
  anthropic: Anthropic,
  facts: {
    pest: string;
    town: string | null;
    service: string;
    monthly: string | null;
    initial: string | null;
    oneTime: string | null;
    fallbackPlan: string | null;
    assumptions: string[];
    oneTimeAsked: boolean;
    rodentAddon: boolean;
    pivotedFromOneTime: string | null;
    funnelUrl: string;
  }
): Promise<string | null> {
  const allowedAmounts = [facts.monthly, facts.initial, facts.oneTime, facts.fallbackPlan, facts.pivotedFromOneTime]
    .filter(Boolean)
    .flatMap((s) => (s as string).match(/\$\d+(?:\.\d{2})?/g) ?? []);

  const prompt = `Write the paste-ready Thumbtack reply (2–4 sentences) for this quoted lead. Use ONLY these exact prices — never invent, change, or round any dollar amount:
- Service: ${facts.service}
- Pest: ${facts.pest}${facts.town ? `\n- Town: ${facts.town}` : ""}
${facts.monthly ? `- Plan price: ${facts.monthly}/mo` : ""}
${facts.initial ? `- Initial service visit: ${facts.initial} (75-minute first service: inspection, interior flush-out, exterior barrier)` : ""}
${facts.oneTime ? `- One-time price: ${facts.oneTime} flat (30-day guarantee)` : ""}
${facts.fallbackPlan ? `- Value fallback: ${facts.fallbackPlan}` : ""}
${facts.rodentAddon ? "- The plan price INCLUDES the rodent program (exterior bait stations, monitored and refilled every visit) — say so." : ""}
${facts.pivotedFromOneTime ? `- The lead asked for a one-time (${facts.pivotedFromOneTime}); position the plan as the better value: the ${facts.initial ?? "initial-visit"} first visit costs less than the one-time, and they're covered year-round. You MAY mention the one-time price ${facts.pivotedFromOneTime} for comparison.` : facts.oneTimeAsked ? "- The lead asked for a one-time; pitch the plan as the smarter option per the conversion script, then give the one-time price." : "- Plan-first framing: covered year-round, free re-treatments between visits, licensed & insured in MA & RI."}
- End with the next step: book online at ${facts.funnelUrl} — they confirm their exact price, pick their day, and pay to lock it in. Use that exact URL. NEVER promise to schedule by reply or to email paperwork.
${facts.assumptions.length ? `- Work these assumptions in naturally: ${facts.assumptions.join("; ")}` : ""}

Tone: warm, direct, no fluff. Output ONLY the reply text.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    const reply = text.text.trim();
    if (!replyUsesOnlyAllowedAmounts(reply, allowedAmounts)) return null;
    return reply;
  } catch {
    return null;
  }
}

/**
 * Consistency guard: every dollar amount in a composed reply must be one the
 * rate card computed. Nothing is whitelisted by literal — a hardcoded "$15"
 * or "$99" is exactly the class of amount this guard exists to catch (R58).
 * Thousands separators are normalized on both sides first.
 */
export function replyUsesOnlyAllowedAmounts(
  reply: string,
  allowedAmounts: string[]
): boolean {
  const normalize = (v: string) => v.replace(/,(?=\d{3})/g, "");
  const used = (reply.match(/\$[\d,]+(?:\.\d{2})?/g) ?? []).map(normalize);
  const allowed = new Set(allowedAmounts.map(normalize));
  return used.every((m) => allowed.has(m));
}

export function templateReply(facts: {
  pest: string;
  town: string | null;
  monthly: string | null;
  initial: string | null;
  oneTime: string | null;
  frequency: Frequency;
  assumptions: string[];
  funnelUrl?: string;
}): string {
  const where = facts.town ? ` in ${facts.town}` : "";
  const assumed = facts.assumptions.length ? ` (${facts.assumptions[0]})` : "";
  // The one next step, every branch: the funnel. "We can have our technician
  // out Thursday" was a promise to schedule by reply, and nothing on this
  // side of the funnel schedules anything. The URL carries the lead's
  // identity when the caller resolved one (funnelUrl), so the booking it
  // produces converts exactly this lead.
  const bookOnline = `You can confirm your exact price, pick your day, and book online in about a minute at ${facts.funnelUrl ?? FUNNEL_URL()}.`;
  if (facts.monthly && facts.initial) {
    return `For ${facts.pest}${where}, our ${freqLabel(facts.frequency)} plan is ${facts.monthly}/mo with a ${facts.initial} initial service — that first visit is the deep one: full inspection, interior treatment, and an exterior barrier${assumed}. After that you're covered year-round, and any re-treatment between visits is free. We're licensed and insured in MA & RI. ${bookOnline}`;
  }
  if (facts.monthly) {
    // R58: mosquito/tick plans carry no initial fee — this branch used to
    // hardcode "$99", quoting a fee that does not exist, in writing.
    return `For ${facts.pest}${where}, our ${freqLabel(facts.frequency)} plan is ${facts.monthly}/mo with no initial fee${assumed}. Any re-treatment between visits is free, and we're licensed and insured in MA & RI. ${bookOnline}`;
  }
  return `For ${facts.pest}${where}, the price is ${facts.oneTime} flat with a 30-day guarantee${assumed}. We're licensed and insured in MA & RI. ${bookOnline} Ask about our quarterly plan if you'd like year-round coverage with free re-treatments.`;
}

// ---------- the main flow ----------

async function priceLead(args: Args) {
  if (!args.resumeRunId && !args.inputText?.trim() && !args.screenshotKey) {
    throw new Error("Paste the lead text or attach a screenshot");
  }

  const client = await dataClient();
  type ResumableRun = {
    id: string;
    decision?: string | null;
    extracted?: unknown;
    customerId?: string | null;
    inputText?: string | null;
    screenshotKey?: string | null;
    leadFeeCents?: number | null;
    researchRateKey?: string | null;
    zone?: string | null;
    driveMinutes?: number | null;
  };
  let resumed: ResumableRun | null = null;
  if (args.resumeRunId) {
    const { data } = await client.models.LeadPricingRun.get({
      id: args.resumeRunId,
    });
    if (!data) throw new Error("That saved pricing run no longer exists");
    resumed = data as ResumableRun;
    // Idempotent resume: once another poll finished the run, return it rather
    // than creating another quote or spending another model call.
    if (resumed.decision !== "RESEARCHING") return data;
  }

  const apiKey = await getSecret("ANTHROPIC_API_KEY");
  if (!apiKey) {
    const failure = {
      decision: "ERROR" as const,
      reason:
        "AI pricing isn't configured. Add ANTHROPIC_API_KEY in Amplify, then retry.",
    };
    if (!resumed) return failure;
    const { data } = await client.models.LeadPricingRun.update({
      id: resumed.id,
      ...failure,
    });
    return data ?? { id: resumed.id, ...failure };
  }
  // AppSync caps custom-op resolvers at 30s — keep model calls fast and
  // fall back to the deterministic reply template when time runs short.
  const anthropic = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 0 });
  const startedAt = Date.now();

  // Screenshot from S3 → base64 for the initial vision call. A resume
  // reuses the immutable extracted facts on the run and never pays to read or
  // extract the same lead again.
  let screenshot: { data: string; mediaType: string } | null = null;
  if (!resumed && args.screenshotKey) {
    if (!args.screenshotKey.startsWith("pricing/")) {
      throw new Error("Invalid screenshot key");
    }
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET(), Key: args.screenshotKey })
    );
    const mediaType = (obj.ContentType ?? "image/png").toLowerCase();
    if (!IMAGE_TYPES[mediaType]) {
      throw new Error("Unsupported screenshot type — re-attach as PNG or JPEG");
    }
    const bytes = await obj.Body!.transformToByteArray();
    screenshot = {
      data: Buffer.from(bytes).toString("base64"),
      mediaType,
    };
  }

  let extracted: Extraction;
  if (resumed) {
    try {
      extracted = (typeof resumed.extracted === "string"
        ? JSON.parse(resumed.extracted)
        : resumed.extracted) as Extraction;
      if (!extracted || typeof extracted !== "object") throw new Error();
    } catch {
      const { data } = await client.models.LeadPricingRun.update({
        id: resumed.id,
        decision: "ERROR",
        reason:
          "The saved AI extraction is unreadable. Start a new pricing run.",
      });
      return data;
    }
  } else {
    extracted = await extractLead(
      anthropic,
      args.inputText ?? null,
      screenshot
    );
  }
  const assumptions = [...new Set(extracted.assumptions ?? [])];
  const addAssumption = (value: string) => {
    if (!assumptions.includes(value)) assumptions.push(value);
  };

  const persist = async (fields: Record<string, unknown>) => {
    const shared = {
      town: extracted.town ?? undefined,
      state: extracted.state ?? undefined,
      outcome: "PENDING",
      // Serialize the LIVE assumptions on every branch, not the raw extraction.
      extracted: JSON.stringify({ ...extracted, assumptions }),
      ...fields,
    };
    const { data: run, errors } = resumed
      ? await client.models.LeadPricingRun.update({
          id: resumed.id,
          ...shared,
        } as Parameters<typeof client.models.LeadPricingRun.update>[0])
      : await client.models.LeadPricingRun.create({
          customerId: args.customerId ?? undefined,
          inputText: args.inputText?.slice(0, 4000) ?? undefined,
          screenshotKey: args.screenshotKey ?? undefined,
          ...shared,
        } as Parameters<typeof client.models.LeadPricingRun.create>[0]);
    if (!run) {
      throw new Error(
        errors?.[0]?.message ?? "Could not save the pricing run"
      );
    }
    return run;
  };

  // Lead fee: explicit arg wins; 0 means "direct lead / no fee".
  const leadFeeCents =
    resumed?.leadFeeCents ?? args.leadFeeCents ?? extracted.leadFeeCents;
  const customerId = resumed?.customerId ?? args.customerId;

  // 1. Hard eligibility passes. Wildlife is no longer one of them — it
  // prices from the WILDLIFE market-rate sheet as a one-time
  // exclusion/removal visit, so it flows through the normal pipeline.
  if (extracted.eligibility !== "ok" && extracted.eligibility !== "wildlife") {
    const run = await persist({
      decision: "PASS",
      reason: `Eligibility: ${extracted.eligibility.replace(/_/g, " ")}`,
      replyText: PASS_SCRIPTS[extracted.eligibility],
      service: extracted.pest,
    });
    return run;
  }
  if (extracted.state && !["MA", "RI"].includes(extracted.state.toUpperCase())) {
    const run = await persist({
      decision: "PASS",
      reason: `Address outside MA/RI (${extracted.state})`,
      replyText: PASS_SCRIPTS.out_of_area,
      service: extracted.pest,
    });
    return run;
  }
  // R75: the licensing gate fails closed. A lead with no extractable state
  // used to skip the MA/RI check entirely and then geocode as "<town>, MA" —
  // Hartford, Nashua, and Brattleboro all sit inside the 90-minute zone
  // check. No state, no quote.
  if (!extracted.state) {
    const run = await persist({
      decision: "NEEDS_INFO",
      reason:
        "Couldn't read the service state from this lead — we're licensed in MA and RI only. Confirm the state (and the town or full address) and run again.",
      leadFeeCents: leadFeeCents ?? undefined,
      service: extracted.pest,
    });
    return run;
  }

  // 2. Lead fee required before quoting (spec step 0). 0 = direct lead.
  if (leadFeeCents == null) {
    const run = await persist({
      decision: "NEEDS_INFO",
      reason:
        "Lead fee is required before quoting — enter the exact Thumbtack lead fee (or 0 for a direct lead) and run again.",
    });
    return run;
  }

  // 3. Zone from real drive time.
  let zone: Zone = "UNKNOWN";
  let minutes: number | null = null;
  if (
    resumed?.zone &&
    ["A", "B", "OUT", "UNKNOWN"].includes(resumed.zone)
  ) {
    zone = resumed.zone as Zone;
    minutes = resumed.driveMinutes ?? null;
  } else if (extracted.fullAddress || extracted.town) {
    // extracted.state is guaranteed by the R75 gate above — never default it.
    const dest = extracted.fullAddress ?? `${extracted.town}, ${extracted.state}`;
    minutes = await driveMinutes(dest);
    if (minutes !== null) zone = zoneFromMinutes(minutes);
    if (!extracted.fullAddress) {
      addAssumption("zone computed from the town center — confirm the street address");
    }
  }
  if (zone === "OUT") {
    const run = await persist({
      decision: "PASS",
      reason: `Drive time ${minutes} min from the closest technician base exceeds 90 minutes`,
      replyText: PASS_SCRIPTS.out_of_area,
      zone,
      driveMinutes: minutes ?? undefined,
      leadFeeCents,
      service: extracted.pest,
    });
    return run;
  }
  if (zone === "UNKNOWN") {
    const key = await getSecret("GOOGLE_ROUTES_API_KEY");
    const run = await persist({
      decision: "NEEDS_INFO",
      reason: key
        ? "Couldn't compute the drive time for this address — check the service address and run again."
        : "Zone lookup isn't configured — add the GOOGLE_ROUTES_API_KEY secret (a server key with Routes API enabled) in the Amplify Console.",
      leadFeeCents,
    });
    return run;
  }

  // 4. Special situations remain visible, but never hand the lead to a
  // manager. The AI returns the standard safe quote and records what it did.
  const internalNotes: string[] = [];
  let pivotedFromOneTimeCents: number | null = null;
  if (extracted.multiProperty) {
    addAssumption(
      "this quote covers the described property only — price each additional address separately"
    );
    internalNotes.push("Multi-property lead: quoted the described property only");
  }
  if (extracted.competitorMatchBelowFloor)
    internalNotes.push(
      "Customer requested a below-floor competitor match; standard BuzzKill pricing shown"
    );
  if (extracted.complianceDocsRequested)
    internalNotes.push(
      "Compliance documentation requested; pricing is unaffected"
    );

  // 5. Map to the AI market-rate engine and price from the cached sheet
  // (deterministic Zone B adders on top, exactly as the website funnel does
  // it). Only mosquito/tick keeps its deterministic card — the engine has
  // no service kind for it yet (its seasonal end-condition is an open
  // decision, R32). Rodent exclusion uses the researched RODENT sheet.
  const statedFreq: Frequency | null =
    extracted.frequencyInterest === "monthly"
      ? "MONTHLY"
      : extracted.frequencyInterest === "bimonthly"
        ? "BIMONTHLY"
        : extracted.frequencyInterest === "quarterly"
          ? "QUARTERLY"
          : extracted.frequencyInterest === "one_time"
            ? "ONE_TIME"
            : null;

  let priced: PricedPlan | null = null;
  let gpKind = "one_time_gpc";
  // Kept for the value-fallback plan strings in the reply.
  let gpRate: MarketRateResult | null = null;

  // No complete cached sheet → persist and wake exactly one AI research
  // request. The UI resumes this same run until it becomes QUOTE; it never
  // re-extracts the lead and never creates a manager handoff.
  const researchRate = async (
    serviceLabel: string,
    engineService: MarketRateService,
    sqft?: number,
    requestReason: "MISSING_RATE_SHEET" | "INCOMPLETE_RATE_SHEET" =
      "MISSING_RATE_SHEET",
    pinned = false
  ) => {
    const exactRateKey = rateKeyFor(
      engineService,
      areaKeyFor(extracted.town!, extracted.state!),
      sqft != null ? sqftBucket(sqft) : null
    );
    if (requestReason === "INCOMPLETE_RATE_SHEET" && pinned) {
      return persist({
        decision: "ERROR",
        reason:
          "The office-controlled rate is missing a required price. Unpin that exact Market Rate, then retry this AI quote.",
        zone,
        driveMinutes: minutes ?? undefined,
        leadFeeCents,
        service: serviceLabel,
        researchRateKey: null,
      });
    }

    if (resumed) {
      const { data: coverage } = await client.models.RateCoverage.get({
        id: exactRateKey,
      });
      if (!coverage || !coverage.active) {
        return persist({
          decision: "ERROR",
          reason:
            "The AI research request is no longer active. Retry pricing to start it again.",
          service: serviceLabel,
          researchRateKey: null,
        });
      }
      if (coverage.exhaustedAt) {
        return persist({
          decision: "ERROR",
          reason:
            "AI could not produce a reliable rate after its bounded retries. Retry pricing to start one fresh exact-rate attempt.",
          service: serviceLabel,
          researchRateKey: null,
        });
      }
      // Polling is read-only while the exact request is still running. This
      // avoids a write every few seconds and returns the original saved run.
      return resumed;
    }

    const queued = await enqueueRateResearch({
      service: engineService,
      city: extracted.town!,
      state: extracted.state!,
      sqft,
      requestedBy: "CRM_LEAD",
      requestReason,
    });
    if (!queued) {
      return persist({
        decision: "ERROR",
        reason:
          "The exact AI research request could not be saved. Retry pricing; no manager handoff was created.",
        zone,
        driveMinutes: minutes ?? undefined,
        leadFeeCents,
        service: serviceLabel,
        researchRateKey: null,
      });
    }
    await wakePricingResearch(exactRateKey, "quote");
    return persist({
      decision: "RESEARCHING",
      reason: AI_RATE_RESEARCHING_REASON,
      zone,
      driveMinutes: minutes ?? undefined,
      leadFeeCents,
      service: serviceLabel,
      researchRateKey: exactRateKey,
    });
  };
  // The engine caches per service + area; the area key needs the town.
  const needsTown = async () =>
    persist({
      decision: "NEEDS_INFO",
      reason:
        "Couldn't read the service town from this lead — the pricing engine caches rates per area. Confirm the town and run again.",
      zone,
      driveMinutes: minutes ?? undefined,
      leadFeeCents,
      service: extracted.pest,
    });
  const town = extracted.town;

  if (extracted.eligibility === "wildlife") {
    // Wildlife exclusion/removal prices by HOW MANY animals need removed — a
    // base visit (first animal) plus a per-extra-animal increment from the
    // WILDLIFE sheet. Not sqft-priced.
    if (!town) return needsTown();
    const count = extracted.animalCount ?? 1;
    if (extracted.animalCount == null)
      addAssumption("assumed a single animal — we'll confirm on the first visit");
    const rate = await getCachedRate({
      service: "WILDLIFE",
      city: town,
      state: extracted.state,
    });
    if (!rate) {
      return researchRate("Wildlife exclusion and removal", "WILDLIFE");
    }
    const extraAnimals = count - 1;
    if (extraAnimals > 0 && rate.sheet.extraAnimalCents == null) {
      return researchRate(
        "Wildlife exclusion and removal",
        "WILDLIFE",
        undefined,
        "INCOMPLETE_RATE_SHEET",
        Boolean(rate.pinned)
      );
    }
    const wildlifeCents =
      rate.priceCents + extraAnimals * (rate.sheet.extraAnimalCents ?? 0);
    priced = oneTimeFromSheet({
      service: "Wildlife exclusion and removal",
      lines: [
        {
          label: `AI market rate — exclusion/removal visit${
            count > 1 ? ` (${count} animals)` : ""
          }`,
          cents: wildlifeCents,
        },
      ],
      baseCents: wildlifeCents,
      zone,
    });
    // No deterministic cost model exists for wildlife work; the exclusion
    // constants (180-minute onsite, exclusion materials) are the closest
    // deterministic economics for the 3× lead-fee test.
    gpKind = "rodent_exclusion";
  } else if (extracted.propertyType === "specialty" && extracted.specialtyKind !== "none") {
    if (extracted.specialtyKind === "termite") {
      // Termite prices from its sheet — the custom-quote policy is retired.
      if (!town) return needsTown();
      const sqft = extracted.sqft ?? 2000;
      if (extracted.sqft == null)
        addAssumption("based on a typical ~2,000 sqft home — we'll confirm on the first visit");
      const rate = await getCachedRate({
        service: "TERMITE",
        city: town,
        state: extracted.state,
        sqft,
      });
      if (!rate) {
        return researchRate("Termite treatment", "TERMITE", sqft);
      }
      priced = oneTimeFromSheet({
        service: "Termite treatment",
        lines: [
          { label: "AI market rate — one-time treatment", cents: rate.priceCents },
        ],
        baseCents: rate.priceCents,
        zone,
      });
      // No deterministic cost model exists for termite work; the 90-minute
      // GPC visit is the closest deterministic economics for the lead-fee
      // test rather than inventing new constants.
      gpKind = "one_time_gpc";
    } else if (extracted.specialtyKind === "rodent_exclusion") {
      if (!town) return needsTown();
      const sqft = extracted.sqft ?? 2000;
      if (extracted.sqft == null)
        addAssumption("based on a typical ~2,000 sqft home — we'll confirm on the first visit");
      const rate = await getCachedRate({
        service: "RODENT",
        city: town,
        state: extracted.state,
        sqft,
      });
      if (!rate) {
        return researchRate("Rodent exclusion (exterior only)", "RODENT", sqft);
      }
      priced = oneTimeFromSheet({
        service: "Rodent exclusion (exterior only)",
        lines: [
          {
            label: "AI market rate — rodent treatment with exclusion check",
            cents: rate.priceCents,
          },
        ],
        baseCents: rate.priceCents,
        zone,
      });
      gpKind = "rodent_exclusion";
    } else if (extracted.specialtyKind === "wasp_nest") {
      if (!town) return needsTown();
      const rate = await getCachedRate({
        service: "WASP_NEST",
        city: town,
        state: extracted.state,
      });
      if (!rate) {
        return researchRate("Wasp / hornet nest removal", "WASP_NEST");
      }
      const nests = Math.max(1, extracted.nestCount ?? 1);
      if (extracted.nestCount == null) {
        addAssumption("assumed a single nest — we'll confirm when scheduling");
      }
      // The sheet must actually price what was asked: a multi-nest job with
      // no extra-nest component is an unpriceable request.
      if (nests > 1 && rate.sheet.extraNestCents == null) {
        return researchRate(
          "Wasp / hornet nest removal — multiple nests",
          "WASP_NEST",
          undefined,
          "INCOMPLETE_RATE_SHEET",
          Boolean(rate.pinned)
        );
      }
      const lines: PriceLine[] = [
        { label: "AI market rate — first nest", cents: rate.priceCents },
      ];
      let base = rate.priceCents;
      if (nests > 1) {
        const extra = (nests - 1) * (rate.sheet.extraNestCents ?? 0);
        lines.push({
          label: `${nests - 1} × ${money(rate.sheet.extraNestCents ?? 0)} (each additional nest)`,
          cents: extra,
        });
        base += extra;
      }
      priced = oneTimeFromSheet({
        service: `Wasp / hornet nest removal${nests > 1 ? ` — ${nests} nests` : ""}`,
        lines,
        baseCents: base,
        zone,
      });
      gpKind = "wasp_nest";
    } else {
      // rodent_nest / roach: one-time treatments priced from their sheets.
      if (!town) return needsTown();
      const roach = extracted.specialtyKind === "roach";
      const sqft = extracted.sqft ?? 2000;
      if (extracted.sqft == null)
        addAssumption("based on a typical ~2,000 sqft home — we'll confirm on the first visit");
      const rate = await getCachedRate({
        service: roach ? "ROACH" : "RODENT",
        city: town,
        state: extracted.state,
        sqft,
      });
      const label = roach
        ? "Specialized roach treatment"
        : "Rodent treatment (trapping + exclusion check)";
      if (!rate) {
        return researchRate(label, roach ? "ROACH" : "RODENT", sqft);
      }
      priced = oneTimeFromSheet({
        service: label,
        lines: [{ label: "AI market rate — one-time treatment", cents: rate.priceCents }],
        baseCents: rate.priceCents,
        zone,
      });
      gpKind = "rodent_nest";
    }
  } else if (extracted.propertyType === "association") {
    if (extracted.units == null) {
      const run = await persist({
        decision: "NEEDS_INFO",
        reason: "Association lead without a unit count — get the number of units and run again.",
        zone,
        driveMinutes: minutes ?? undefined,
        leadFeeCents,
      });
      return run;
    }
    if (!town) return needsTown();
    // HOA auto-quotes like everything else now.
    const rate = await getCachedRate({
      service: "HOA",
      city: town,
      state: extracted.state,
    });
    const hoa = rate?.sheet.hoaPerUnitMonthly;
    if (!hoa) {
      return researchRate(
        "Association/HOA common areas",
        "HOA",
        undefined,
        rate ? "INCOMPLETE_RATE_SHEET" : "MISSING_RATE_SHEET",
        Boolean(rate?.pinned)
      );
    }
    const freq: PlanCadence =
      statedFreq && statedFreq !== "ONE_TIME" ? statedFreq : "MONTHLY";
    if (statedFreq === "ONE_TIME") {
      addAssumption(
        "quoted the monthly common-area plan — one-off association work is confirmed on a walkthrough"
      );
    }
    const units = Math.max(1, extracted.units);
    const perUnit = hoa[hoaBandFor(units)][freq];
    const lines: PriceLine[] = [
      {
        label: `${units} units × ${money(perUnit)}/unit (AI market rate, ${freqLabel(freq)})`,
        cents: perUnit * units,
      },
    ];
    let monthly = perUnit * units;
    if (zone === "B") {
      lines.push({ label: "Zone B travel adder (monthly)", cents: ZONE_B[freq] });
      monthly += ZONE_B[freq];
    }
    priced = {
      service: `Association/HOA common areas — ${freqLabel(freq)}`,
      frequency: freq,
      monthlyCents: monthly,
      oneTimeCents: null,
      initialFeeCents: null,
      lines,
    };
  } else if (extracted.propertyType === "commercial") {
    // Commercial prices from its sheet (one-time + all three plan cadences)
    // exactly like the funnel — the deterministic commercial card retired.
    const sqft = extracted.sqft ?? 2000;
    if (extracted.sqft == null) addAssumption("assumed ~2,000 sqft — confirm on booking");
    if (!town) return needsTown();
    const rate = await getCachedRate({
      service: "COMMERCIAL",
      city: town,
      state: extracted.state,
      sqft,
    });
    if (!rate) {
      return researchRate("Commercial pest control", "COMMERCIAL", sqft);
    }
    const freq = statedFreq ?? "MONTHLY";
    if (freq === "ONE_TIME") {
      priced = oneTimeFromSheet({
        service: "Commercial pest control — one-time",
        lines: [
          { label: "AI market rate — one-time treatment", cents: rate.priceCents },
        ],
        baseCents: rate.priceCents,
        zone,
      });
      // No deterministic cost model exists for commercial work; the GPC
      // visit constants stand in for the 3× lead-fee test.
      gpKind = "one_time_gpc";
    } else {
      priced = planFromSheet(rate, freq, zone, "Commercial pest control");
      // A COMMERCIAL sheet without plan cadences can't price a plan lead.
      if (!priced) {
        return researchRate(
          `Commercial pest control — ${freqLabel(freq)}`,
          "COMMERCIAL",
          sqft,
          "INCOMPLETE_RATE_SHEET",
          Boolean(rate.pinned)
        );
      }
    }
  } else if (extracted.propertyType === "mosquito") {
    if (extracted.halfAcres == null)
      addAssumption("assumed up to ½ acre yard — we'll confirm on the first visit");
    const mosquitoOneTime = statedFreq === "ONE_TIME";
    if (mosquitoOneTime && extracted.tick) {
      addAssumption(
        "the one-time event spray covers mosquitoes only — tick coverage is on the seasonal plan"
      );
    }
    priced = priceMosquito({
      tick: extracted.tick && !mosquitoOneTime,
      halfAcres: extracted.halfAcres ?? 1,
      zone,
      oneTime: mosquitoOneTime,
    });
    gpKind = "mosquito_one_time";
  } else {
    // Residential (default). Unknown sqft → assume 2,000 and say so.
    const sqft = extracted.sqft ?? 2000;
    if (extracted.sqft == null)
      addAssumption("based on a typical ~2,000 sqft home — we'll confirm on the first visit");
    if (!town) return needsTown();
    const rate = await getCachedRate({
      service: "GENERAL_PEST",
      city: town,
      state: extracted.state,
      sqft,
    });
    if (!rate) {
      return researchRate(
        "Residential general pest control",
        "GENERAL_PEST",
        sqft
      );
    }
    gpRate = rate;
    gpKind = "one_time_gpc";
    const freq = statedFreq ?? "QUARTERLY";

    if (freq === "ONE_TIME") {
      priced = oneTimeFromSheet({
        service: "Residential one-time treatment",
        lines: [
          { label: "AI market rate — one-time treatment", cents: rate.priceCents },
        ],
        baseCents: rate.priceCents,
        zone,
      });
      // One-time economics: if it fails the 3× lead-fee test, quote the plan
      // instead. The WHY stays internal (run.reason) — never customer-facing.
      const gp = oneTimeGrossProfitCents(gpKind, priced.oneTimeCents!, zone);
      if (clearsLeadFee(gp, leadFeeCents) === false) {
        const plan = planFromSheet(rate, "QUARTERLY", zone);
        if (plan) {
          pivotedFromOneTimeCents = priced.oneTimeCents;
          internalNotes.push(
            `One-time GP ${gp != null ? money(gp) : "?"} failed the 3× lead-fee test — pivoted to the quarterly plan`
          );
          priced = plan;
        }
        // No plans on the sheet: keep the one-time — the lead-fee PASS gate
        // below makes the call rather than inventing a plan price.
      }
    } else {
      priced = planFromSheet(rate, freq, zone);
      // A GENERAL_PEST sheet without plan cadences can't price a plan lead.
      if (!priced) {
        return researchRate(
          `Residential GPC — ${freqLabel(freq)}`,
          "GENERAL_PEST",
          sqft,
          "INCOMPLETE_RATE_SHEET",
          Boolean(rate.pinned)
        );
      }
    }
  }

  if (!priced) {
    return persist({
      decision: "NEEDS_INFO",
      reason:
        "AI couldn't identify a supported service from these details. Clarify the pest and property type, then run pricing again.",
      zone,
      driveMinutes: minutes ?? undefined,
      leadFeeCents,
    });
  }

  // 6. Specialty/one-time lead-fee test (recurring always clears).
  if (
    priced.oneTimeCents != null &&
    priced.monthlyCents == null &&
    leadFeeCents > 0
  ) {
    const gp = oneTimeGrossProfitCents(gpKind, priced.oneTimeCents, zone);
    if (clearsLeadFee(gp, leadFeeCents) === false) {
      const run = await persist({
        decision: "PASS",
        reason: `One-time gross profit ${gp != null ? money(gp) : "?"} fails the 3× lead-fee test (${money(3 * leadFeeCents)})`,
        zone,
        driveMinutes: minutes ?? undefined,
        leadFeeCents,
        service: priced.service,
        frequency: priced.frequency,
        oneTimePriceCents: priced.oneTimeCents,
        priceBreakdown: JSON.stringify(priced.lines),
      });
      return run;
    }
  }

  // 7. Compose the reply (AI-polished, price-validated; deterministic fallback).
  const factTown = extracted.town;
  const monthlyStr = priced.monthlyCents != null ? money(priced.monthlyCents) : null;
  const initialStr = priced.initialFeeCents != null ? money(priced.initialFeeCents) : null;
  const oneTimeStr = priced.oneTimeCents != null ? money(priced.oneTimeCents) : null;

  let fallbackPlanStr: string | null = null;
  if (extracted.propertyType === "residential" && priced.frequency === "QUARTERLY" && gpRate) {
    const bi = planFromSheet(gpRate, "BIMONTHLY", zone);
    if (bi) fallbackPlanStr = `bi-monthly at ${money(bi.monthlyCents!)}/mo`;
  } else if (extracted.propertyType === "residential" && priced.frequency === "MONTHLY" && gpRate) {
    const q = planFromSheet(gpRate, "QUARTERLY", zone);
    if (q) fallbackPlanStr = `quarterly at ${money(q.monthlyCents!)}/mo as the value option`;
  } else if (priced.service.startsWith("Mosquito + tick")) {
    const m = priceMosquito({ tick: false, halfAcres: extracted.halfAcres ?? 1, zone });
    fallbackPlanStr = `mosquito-only at ${money(m.monthlyCents!)}/mo`;
  }

  // The reply's booking link carries the lead's identity when we know who
  // they are (R-lead-identity): the paid booking it produces then converts
  // exactly this record instead of email-guessing. Best-effort — a resolve
  // or mint failure still replies with the bare funnel URL.
  let funnelUrl = FUNNEL_URL();
  if (customerId) {
    try {
      const { data: leadCustomer } = await client.models.Customer.get({
        id: customerId,
      });
      if (leadCustomer) {
        const token = await ensureBookingLinkToken(client, leadCustomer);
        funnelUrl = bookingLinkUrl(FUNNEL_URL(), token);
      }
    } catch (err) {
      console.error(
        `priceLead: could not resolve booking-link token for ${customerId}`,
        err
      );
    }
  }

  // Keep the second model call inside the AppSync window; the deterministic
  // template is always a valid reply.
  const timeLeft = Date.now() - startedAt < 15_000;
  const composed =
    (timeLeft
      ? await composeReply(anthropic, {
          pest: extracted.pest || "pests",
          town: factTown,
          service: priced.service,
          monthly: monthlyStr,
          initial: initialStr,
          oneTime: oneTimeStr,
          fallbackPlan: fallbackPlanStr,
          assumptions,
          oneTimeAsked: statedFreq === "ONE_TIME" && priced.monthlyCents != null,
          rodentAddon:
            extracted.rodentInterest && extracted.propertyType === "residential",
          pivotedFromOneTime:
            pivotedFromOneTimeCents != null ? money(pivotedFromOneTimeCents) : null,
          funnelUrl,
        })
      : null) ??
    templateReply({
      pest: extracted.pest || "pests",
      town: factTown,
      monthly: monthlyStr,
      initial: initialStr,
      oneTime: oneTimeStr,
      frequency: priced.frequency,
      assumptions,
      funnelUrl,
    });

  const run = await persist({
    decision: "QUOTE",
    reason: internalNotes.join("; ") || undefined,
    zone,
    driveMinutes: minutes ?? undefined,
    leadFeeCents,
    service: priced.service,
    frequency: priced.frequency,
    monthlyPriceCents: priced.monthlyCents ?? undefined,
    initialFeeCents: priced.initialFeeCents ?? undefined,
    oneTimePriceCents: priced.oneTimeCents ?? undefined,
    priceBreakdown: JSON.stringify(priced.lines),
    replyText: composed,
    researchRateKey: null,
  });
  return run;
}
