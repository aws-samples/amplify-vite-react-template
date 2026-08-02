/**
 * The one place the schema's enums are named.
 *
 * `amplify/data/resource.ts` declares 19 `a.enum(...)` types. Before this
 * module they were re-typed by hand all over the app — as `Record<string, …>`
 * label maps, literal unions, runtime `Set`s, `[value, label]` tuples and
 * inline `<option>` lists — none of it checked against the schema. Adding or
 * renaming a member compiled clean everywhere and failed at runtime. It had
 * already happened once: the Documents panel's category list was missing
 * `ACORD_FORM`, so an ACORD document rendered with no category label at all.
 *
 * How drift is prevented, following `quoteStatus.ts`: every table below is
 * `satisfies Record<TheEnum, …>`, where the enum is `Schema["X"]["type"]` —
 * the schema's own type. Add a member in `resource.ts` and this file stops
 * compiling until the member is given a label; remove one and the now-excess
 * key stops compiling too. Ordered lists are *derived* from those tables by
 * sorting, never written out a second time, so a display order cannot fall out
 * of step with the member set.
 *
 * `satisfies` rather than `:` on purpose — it enforces exhaustiveness while
 * leaving the literal key types intact for the derivations below. The exported
 * label maps are then widened to `Record<string, string>` so callers can keep
 * indexing them with a loose `string | null` straight off a model row.
 *
 * `QuoteStatus` is not here: `quoteStatus.ts` already owns it, with a
 * classification this module has no business duplicating.
 *
 * ─ Import constraints ────────────────────────────────────────────────────────
 * Type-only import of `Schema`, so nothing from `amplify/` reaches a bundle or
 * a test run. Combined with importing no runtime value except the
 * dependency-free `shared/accountType`, that makes this module safe for a
 * Lambda handler to import — the `pagination.ts` convention. It must never
 * import `client.ts`, which calls `generateClient()` at module scope.
 */
import type { Schema } from "../../amplify/data/resource";
import { ACCOUNT_TYPES, type AccountType } from "../../../shared/accountType";

// ── Derived enum types ───────────────────────────────────────────────────────

export type AccountStage = Schema["AccountStage"]["type"];
export type PolicyStatus = Schema["PolicyStatus"]["type"];
export type DocumentCategory = NonNullable<Schema["DocumentCategory"]["type"]>;
export type OcrStatus = Schema["OcrStatus"]["type"];
export type UserRole = Schema["UserRole"]["type"];
export type MarketingTaskResolution = Schema["MarketingTaskResolution"]["type"];
export type MarketingTaskSource = Schema["MarketingTaskSource"]["type"];
export type LicenseHolderType = Schema["LicenseHolderType"]["type"];
export type LicenseClass = Schema["LicenseClass"]["type"];
export type LicenseResidency = Schema["LicenseResidency"]["type"];
export type LicenseStatus = Schema["LicenseStatus"]["type"];
export type ConstructionType = Schema["ConstructionType"]["type"];
export type ReplacementCostType = Schema["ReplacementCostType"]["type"];
export type AggregateAppliesTo = Schema["AggregateAppliesTo"]["type"];

/**
 * `AccountType` is re-exported from `shared/` rather than derived here: `web`
 * needs it too and cannot reach the schema. These two assertions are what stop
 * the shared copy drifting — they fail compilation if the shared list gains,
 * loses or renames a member relative to the schema.
 */
type SchemaAccountType = Schema["AccountType"]["type"];
type SharedCoversSchema = [SchemaAccountType] extends [AccountType] ? true : never;
type SchemaCoversShared = [AccountType] extends [SchemaAccountType] ? true : never;
const _sharedMatchesSchema: [SharedCoversSchema, SchemaCoversShared] = [true, true];
void _sharedMatchesSchema;

export { ACCOUNT_TYPES, type AccountType };

// ── Option lists ─────────────────────────────────────────────────────────────

/** One `<option>`: the stored enum value plus the text shown for it. */
export interface EnumOption<K extends string> {
  readonly value: K;
  readonly label: string;
}

/**
 * Turn a label table into the option list a `<select>` renders, sorted by
 * label. Every list in this file was alphabetical-by-label where it was
 * written by hand, so sorting reproduces the existing order rather than
 * restating it — which is the point: there is no second copy of the members to
 * fall out of step.
 */
function optionsByLabel<K extends string>(
  table: Record<K, string>
): readonly EnumOption<K>[] {
  return Object.freeze(
    (Object.keys(table) as K[])
      .map((value) => Object.freeze({ value, label: table[value] }))
      .sort((a, b) => a.label.localeCompare(b.label))
  );
}

// ── ConstructionType ─────────────────────────────────────────────────────────

/**
 * ISO construction classes. Two renderings, one table: `label` is the Title
 * Case form shown in dropdowns and the extraction review, `phrase` is the
 * lower-case form that reads correctly inside the ACORD operations sentence.
 */
const CONSTRUCTION = {
  FRAME: { label: "Frame", phrase: "wood-frame" },
  JOISTED_MASONRY: { label: "Joisted Masonry", phrase: "joisted masonry" },
  NON_COMBUSTIBLE: { label: "Non-Combustible", phrase: "non-combustible" },
  MASONRY_NON_COMBUSTIBLE: {
    label: "Masonry Non-Combustible",
    phrase: "masonry non-combustible",
  },
  MODIFIED_FIRE_RESISTIVE: {
    label: "Modified Fire Resistive",
    phrase: "modified fire-resistive",
  },
  FIRE_RESISTIVE: { label: "Fire Resistive", phrase: "fire-resistive" },
} satisfies Record<ConstructionType, { label: string; phrase: string }>;

/** Every construction class, in schema order. */
export const CONSTRUCTION_TYPES: readonly ConstructionType[] = Object.freeze(
  Object.keys(CONSTRUCTION) as ConstructionType[]
);

export const CONSTRUCTION_LABELS: Record<string, string> = Object.freeze(
  Object.fromEntries(
    CONSTRUCTION_TYPES.map((k) => [k, CONSTRUCTION[k].label])
  ) as Record<ConstructionType, string>
);

export const CONSTRUCTION_PHRASES: Record<string, string> = Object.freeze(
  Object.fromEntries(
    CONSTRUCTION_TYPES.map((k) => [k, CONSTRUCTION[k].phrase])
  ) as Record<ConstructionType, string>
);

export const CONSTRUCTION_OPTIONS = optionsByLabel(
  CONSTRUCTION_LABELS as Record<ConstructionType, string>
);

// ── PolicyStatus ─────────────────────────────────────────────────────────────

/**
 * No labels: every policy-status `<select>` renders the raw token, and the
 * badge table in `badges.tsx` owns the coloured rendering.
 */
const POLICY_STATUS = {
  ACTIVE: true,
  EXPIRED: true,
  CANCELLED: true,
  NON_RENEWED: true,
} satisfies Record<PolicyStatus, true>;

/**
 * Alphabetical, which is the order both hand-written copies used — the
 * `CoverageForm` list re-sorts at render anyway, the `PoliciesTab` one does
 * not, so this order is load-bearing there.
 */
export const POLICY_STATUSES: readonly PolicyStatus[] = Object.freeze(
  (Object.keys(POLICY_STATUS) as PolicyStatus[]).sort((a, b) =>
    a.localeCompare(b)
  )
);

// ── ReplacementCostType ──────────────────────────────────────────────────────

const REPLACEMENT_COST = {
  RC: "RC — Replacement Cost",
  ERC: "ERC — Extended Replacement Cost",
  GRC: "GRC — Guaranteed Replacement Cost",
} satisfies Record<ReplacementCostType, string>;

export const REPLACEMENT_COST_OPTIONS = optionsByLabel(REPLACEMENT_COST);

// ── AggregateAppliesTo ───────────────────────────────────────────────────────

/**
 * `label` is the dropdown text; `acord25Field` is the ACORD 25 checkbox this
 * choice ticks. Keeping both here is what stops the PDF mapping and the form
 * offering different member sets.
 */
const AGGREGATE_APPLIES_TO = {
  POLICY: {
    label: "Policy",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesPerPolicyIndicator_A",
  },
  PROJECT: {
    label: "Project",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesPerProjectIndicator_A",
  },
  LOCATION: {
    label: "Location",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesPerLocationIndicator_A",
  },
  OTHER: {
    label: "Other",
    acord25Field:
      "GeneralLiability_GeneralAggregate_LimitAppliesToOtherIndicator_A",
  },
} satisfies Record<AggregateAppliesTo, { label: string; acord25Field: string }>;

/** The member every caller falls back to when the column is unset. */
export const DEFAULT_AGGREGATE_APPLIES_TO = "POLICY" satisfies AggregateAppliesTo;

export const AGGREGATE_APPLIES_TO_OPTIONS = optionsByLabel(
  Object.fromEntries(
    (Object.keys(AGGREGATE_APPLIES_TO) as AggregateAppliesTo[]).map((k) => [
      k,
      AGGREGATE_APPLIES_TO[k].label,
    ])
  ) as Record<AggregateAppliesTo, string>
);

export const ACORD25_AGGREGATE_FIELDS: Record<string, string> = Object.freeze(
  Object.fromEntries(
    (Object.keys(AGGREGATE_APPLIES_TO) as AggregateAppliesTo[]).map((k) => [
      k,
      AGGREGATE_APPLIES_TO[k].acord25Field,
    ])
  ) as Record<AggregateAppliesTo, string>
);

// ── DocumentCategory ─────────────────────────────────────────────────────────

/**
 * `label: null` means "not something a human uploads". `ACORD_FORM` is the
 * only such member: those documents are generated by the forms tab, so the
 * category is deliberately absent from the upload picker — and, because the
 * picker doubles as the table's label lookup, an ACORD document shows no
 * category. That is existing behaviour, preserved here on purpose; making it
 * `null` is what turns an accidental omission into a checked one.
 *
 * `extractionPriority` is the order the AI extraction Lambda feeds documents
 * to the model when it has to fit them in a character budget — lowest first.
 */
const DOCUMENT_CATEGORY = {
  PRIOR_POLICY: { label: "Prior policy packet", extractionPriority: 0 },
  CONDO_DOCS: { label: "Condo documents", extractionPriority: 7 },
  BUDGET: { label: "Budget", extractionPriority: 1 },
  DUES_SCHEDULE: { label: "Dues per unit", extractionPriority: 2 },
  LOSS_RUNS: { label: "Loss runs", extractionPriority: 3 },
  QUOTE_DOC: { label: "Quote document", extractionPriority: 5 },
  POLICY_DOC: { label: "Policy document", extractionPriority: 6 },
  LICENSE: { label: "License", extractionPriority: 9 },
  ACORD_FORM: { label: null, extractionPriority: 8 },
  OTHER: { label: "Other", extractionPriority: 4 },
} satisfies Record<
  DocumentCategory,
  { label: string | null; extractionPriority: number }
>;

/** Categories a human may pick when uploading, sorted by label. */
export const DOCUMENT_CATEGORY_OPTIONS: readonly EnumOption<DocumentCategory>[] =
  Object.freeze(
    (Object.keys(DOCUMENT_CATEGORY) as DocumentCategory[])
      .flatMap((value) => {
        const { label } = DOCUMENT_CATEGORY[value];
        return label === null ? [] : [Object.freeze({ value, label })];
      })
      .sort((a, b) => a.label.localeCompare(b.label))
  );

/** Feed order for the extraction Lambda's character budget. Lowest first. */
export const DOCUMENT_CATEGORY_EXTRACTION_PRIORITY: Record<string, number> =
  Object.freeze(
    Object.fromEntries(
      (Object.keys(DOCUMENT_CATEGORY) as DocumentCategory[]).map((k) => [
        k,
        DOCUMENT_CATEGORY[k].extractionPriority,
      ])
    ) as Record<DocumentCategory, number>
  );

/** Where an uncategorised document sorts, and what it is treated as. */
export const DEFAULT_DOCUMENT_CATEGORY = "OTHER" satisfies DocumentCategory;

// ── UserRole ─────────────────────────────────────────────────────────────────

const USER_ROLE = {
  ADMIN: "Admin",
  STAFF: "Staff",
  PRODUCER: "Producer",
} satisfies Record<UserRole, string>;

export const USER_ROLES: readonly UserRole[] = Object.freeze(
  Object.keys(USER_ROLE) as UserRole[]
);

export const USER_ROLE_LABELS: Record<string, string> = Object.freeze({
  ...USER_ROLE,
});

export const USER_ROLE_OPTIONS = optionsByLabel(USER_ROLE);

/** The role a new invite gets when none is chosen. */
export const DEFAULT_USER_ROLE = "STAFF" satisfies UserRole;

/**
 * Is this one of the schema's roles? These are also the Cognito group names —
 * `amplify/auth/resource.ts` declares the same three — which is why the team
 * admin Lambda can validate an invite's role and then pass it straight to
 * `AdminAddUserToGroupCommand`.
 */
export function isUserRole(v: string | null | undefined): v is UserRole {
  return v != null && (USER_ROLES as readonly string[]).includes(v);
}

// ── Licensing ────────────────────────────────────────────────────────────────

const LICENSE_CLASS = {
  PRODUCER: "Producer",
  AGENCY: "Agency / business entity",
  SURPLUS_LINES: "Surplus lines",
  ADJUSTER: "Adjuster",
  CONSULTANT: "Consultant",
} satisfies Record<LicenseClass, string>;

export const LICENSE_CLASS_LABELS: Record<string, string> = Object.freeze({
  ...LICENSE_CLASS,
});

const LICENSE_STATUS = {
  ACTIVE: "Active",
  PENDING: "Pending",
  INACTIVE: "Inactive",
  LAPSED: "Lapsed",
  EXPIRED: "Expired",
} satisfies Record<LicenseStatus, string>;

export const LICENSE_STATUS_LABELS: Record<string, string> = Object.freeze({
  ...LICENSE_STATUS,
});

const LICENSE_RESIDENCY = {
  RESIDENT: "Resident",
  NON_RESIDENT: "Non-resident",
} satisfies Record<LicenseResidency, string>;

export const LICENSE_RESIDENCY_OPTIONS = optionsByLabel(LICENSE_RESIDENCY);

// ── AccountType ──────────────────────────────────────────────────────────────

const ACCOUNT_TYPE = {
  ASSOCIATION: "Association / HOA",
  PERSONAL: "Personal (HO-6)",
  COMMERCIAL_OTHER: "Commercial — other",
} satisfies Record<AccountType, string>;

export const ACCOUNT_TYPE_OPTIONS = optionsByLabel(ACCOUNT_TYPE);

/** What a lead with no stated type is recorded as. */
export const DEFAULT_ACCOUNT_TYPE = "ASSOCIATION" satisfies AccountType;

/** Is this one of the schema's account types at all? */
export function isAccountType(v: string | null | undefined): v is AccountType {
  return v != null && (ACCOUNT_TYPES as readonly string[]).includes(v);
}
