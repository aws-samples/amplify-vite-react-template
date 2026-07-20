import type { MarketRateService, PlanCadence } from "./marketRate";

/**
 * GL-01 — the ONE versioned service catalog.
 *
 * Before this module, "what services does BuzzKill sell" lived in at least
 * five hand-duplicated vocabularies: the funnel's BookingRequest.service
 * enum + SERVICE_OPTIONS, the pricing engine's MarketRateService, the
 * rateCards cost kinds, the lead-intake extraction vocab, and the CRM's
 * free-text Job.serviceType (typed by hand, matched by fragile string
 * heuristics like `planName.includes("mosquito")`). This module is the
 * single source those surfaces now derive from:
 *
 *  - the public funnel's selectable services (funnel: true) and their
 *    required inputs;
 *  - lead-intake/CRM pricing outcomes (leadForm: true);
 *  - the canonical customer-facing label for every sold service
 *    (serviceLabelFor) and the resolver that maps ANY historical label,
 *    plan name, or office-typed string back to its catalog entry
 *    (entryForLabel) — so legacy free-text rows join the catalog instead
 *    of being stranded;
 *  - property-class applicability and the locked 30/60-minute on-site rule;
 *  - the pricing source (engine rate sheet vs the deterministic mosquito
 *    card) and the variable-cost kind for margin protection;
 *  - the seasonal April–October flag (replacing name sniffing);
 *  - plan naming for recurring enrollments.
 *
 * PURE data + functions on purpose: no AWS imports, no side effects — the
 * web funnel and the CRM import it by value, Lambdas import it by value,
 * and everyone reads the same truth. Bump SERVICE_CATALOG_VERSION on any
 * change; every job/plan records the id + version it was sold under, so an
 * old record's meaning never drifts with a later catalog edit.
 */

export const SERVICE_CATALOG_VERSION = "2026-07-20.1";

export type PropertyClass = "RESIDENTIAL" | "COMMERCIAL" | "COMMUNITY";

export type CatalogServiceId =
  | "GENERAL_PEST"
  | "WASP_NEST"
  | "RODENT"
  | "ROACH"
  | "TERMITE"
  | "WILDLIFE"
  | "COMMERCIAL_PEST"
  | "HOA_COMMON_AREA"
  | "MOSQUITO"
  | "MOSQUITO_TICK";

export type CatalogEntry = {
  id: CatalogServiceId;
  /** The customer-facing label ROOT ("General pest control"). Sized/variant
   *  labels come from serviceLabelFor; plan names from planNameFor. */
  label: string;
  /** Selectable in the public booking funnel (as a service pick — the
   *  COMMERCIAL_PEST/HOA_COMMON_AREA entries are reached by property kind). */
  funnel: boolean;
  /** The funnel dropdown's wording when it deliberately differs from the
   *  sold-service label (the difference lives HERE, not in a duplicate). */
  funnelLabel?: string;
  /** A priceable outcome of the approved lead forms / lead pricing. */
  leadForm: boolean;
  /** Where the service applies. Duration is the LOCKED class rule
   *  (residential 30 on-site minutes, commercial/community 60) — the class,
   *  not the service, decides. */
  propertyClasses: PropertyClass[];
  needsSqft: boolean;
  needsNestCount: boolean;
  needsUnits: boolean;
  /** Offers a recurring plan (billed as a flat monthly subscription). */
  offersRecurring: boolean;
  cadences: PlanCadence[];
  /** GL-17 locked rule: one treatment per month April–October, billed in
   *  equal monthly installments year-round. */
  seasonal: boolean;
  /** The AI rate-sheet this prices from, or null for the deterministic
   *  mosquito card (rateCards.priceMosquito). */
  engineService: MarketRateService | null;
  /** rateCards cost kind for the variable-cost floor / margin math; null =
   *  no deterministic cost model exists (recorded, never invented). */
  costKind: string | null;
  /** Office "✓ Complete" allowed (administrative work). Field/pesticide
   *  work is completed only by the technician's finalized report. */
  officeCompletable: boolean;
};

const ALL_CADENCES: PlanCadence[] = ["MONTHLY", "BIMONTHLY", "QUARTERLY"];

/** The "what needs removed" choices the wildlife quote collects. The customer
 *  picks one; the count sets the price. Kept here so the funnel select and the
 *  lead-intake vocabulary read from the one catalog. */
export const WILDLIFE_OTHER_KIND = "Other / not sure";
export const WILDLIFE_REMOVAL_KINDS: string[] = [
  "Squirrels",
  "Raccoons",
  "Bats",
  "Birds",
  "Skunks",
  "Opossums",
  "Snakes",
  "Groundhog",
  "Chipmunks",
  WILDLIFE_OTHER_KIND,
];

export const SERVICE_CATALOG: Record<CatalogServiceId, CatalogEntry> = {
  GENERAL_PEST: {
    id: "GENERAL_PEST",
    label: "General pest control",
    funnel: true,
    leadForm: true,
    propertyClasses: ["RESIDENTIAL"],
    needsSqft: true,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: true,
    cadences: ALL_CADENCES,
    seasonal: false,
    engineService: "GENERAL_PEST",
    costKind: "one_time_gpc",
    officeCompletable: false,
  },
  WASP_NEST: {
    id: "WASP_NEST",
    label: "Wasp / hornet nest removal",
    funnel: true,
    leadForm: true,
    // Nest removal prices by the number of nests at EVERY property class —
    // the service, not the property, sets the price here (a commercial or
    // community wasp job is still priced per nest, never by sqft/units).
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"],
    needsSqft: false,
    needsNestCount: true,
    needsUnits: false,
    offersRecurring: false,
    cadences: [],
    seasonal: false,
    engineService: "WASP_NEST",
    costKind: "wasp_nest",
    officeCompletable: false,
  },
  RODENT: {
    id: "RODENT",
    label: "Rodent treatment",
    funnel: true,
    leadForm: true,
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL"],
    needsSqft: true,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: false,
    cadences: [],
    seasonal: false,
    engineService: "RODENT",
    costKind: "rodent_nest",
    officeCompletable: false,
  },
  ROACH: {
    id: "ROACH",
    label: "Specialized roach treatment",
    funnel: true,
    funnelLabel: "Roach treatment",
    leadForm: true,
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL"],
    needsSqft: true,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: false,
    cadences: [],
    seasonal: false,
    engineService: "ROACH",
    costKind: "rodent_nest",
    officeCompletable: false,
  },
  TERMITE: {
    id: "TERMITE",
    label: "Termite treatment",
    funnel: true,
    funnelLabel: "Termite inspection & treatment",
    leadForm: true,
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL"],
    needsSqft: true,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: false,
    cadences: [],
    seasonal: false,
    engineService: "TERMITE",
    costKind: null,
    officeCompletable: false,
  },
  WILDLIFE: {
    id: "WILDLIFE",
    label: "Wildlife exclusion and removal",
    funnel: true,
    funnelLabel: "Wildlife removal",
    leadForm: true,
    // Priced by WHAT needs removed and HOW MANY at every property class —
    // the animal count sets the price (base removal + per-extra-animal), so
    // sqft is not collected and the property class doesn't override it.
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"],
    needsSqft: false,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: false,
    cadences: [],
    seasonal: false,
    engineService: "WILDLIFE",
    costKind: null,
    officeCompletable: false,
  },
  COMMERCIAL_PEST: {
    id: "COMMERCIAL_PEST",
    label: "Commercial pest control",
    funnel: false, // reached by propertyKind COMMERCIAL, not a service pick
    leadForm: true,
    propertyClasses: ["COMMERCIAL"],
    needsSqft: true,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: true,
    cadences: ALL_CADENCES,
    seasonal: false,
    engineService: "COMMERCIAL",
    costKind: null,
    officeCompletable: false,
  },
  HOA_COMMON_AREA: {
    id: "HOA_COMMON_AREA",
    label: "Community common-area pest control",
    funnel: false, // reached by propertyKind COMMUNITY; plan-only
    leadForm: true,
    propertyClasses: ["COMMUNITY"],
    needsSqft: false,
    needsNestCount: false,
    needsUnits: true,
    offersRecurring: true,
    cadences: ALL_CADENCES,
    seasonal: false,
    engineService: "HOA",
    costKind: null,
    officeCompletable: false,
  },
  MOSQUITO: {
    id: "MOSQUITO",
    label: "Mosquito plan (Apr–Oct)",
    funnel: true, // GL-17: the CEO selected the public funnel as the sale path
    leadForm: true,
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"],
    needsSqft: false,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: true,
    cadences: ["MONTHLY"],
    seasonal: true,
    engineService: null, // deterministic card: rateCards.priceMosquito
    costKind: "mosquito_one_time",
    officeCompletable: false,
  },
  MOSQUITO_TICK: {
    id: "MOSQUITO_TICK",
    label: "Mosquito + tick plan (Apr–Oct)",
    funnel: true, // GL-17: sold through the funnel alongside MOSQUITO
    leadForm: true,
    propertyClasses: ["RESIDENTIAL", "COMMERCIAL", "COMMUNITY"],
    needsSqft: false,
    needsNestCount: false,
    needsUnits: false,
    offersRecurring: true,
    cadences: ["MONTHLY"],
    seasonal: true,
    engineService: null,
    costKind: "mosquito_one_time",
    officeCompletable: false,
  },
};

export const CATALOG_IDS = Object.keys(SERVICE_CATALOG) as CatalogServiceId[];

export function catalogEntry(
  id: string | null | undefined
): CatalogEntry | null {
  if (!id) return null;
  return (SERVICE_CATALOG as Record<string, CatalogEntry>)[id] ?? null;
}

/** The services a customer can pick on the public funnel. Order matters —
 *  it is the dropdown order. */
export function funnelCatalog(): CatalogEntry[] {
  return CATALOG_IDS.map((id) => SERVICE_CATALOG[id]).filter((e) => e.funnel);
}

/** On-site minutes are the LOCKED property-class rule — the class decides,
 *  never the service. */
export function onsiteMinutesForClass(
  propertyClass: string | null | undefined
): number {
  return propertyClass === "COMMERCIAL" || propertyClass === "COMMUNITY"
    ? 60
    : 30;
}

/**
 * The canonical customer-facing label for a sold service — byte-identical
 * to what the funnel has always produced, so entryForLabel round-trips
 * every historical Job.serviceType.
 */
export function serviceLabelFor(
  id: CatalogServiceId,
  opts: {
    sqftBucket?: number;
    nestCount?: number;
    units?: number;
    removalKind?: string;
    removalCount?: number;
  } = {}
): string {
  const sizeLabel =
    opts.sqftBucket != null
      ? `up to ${opts.sqftBucket.toLocaleString()} sqft`
      : null;
  switch (id) {
    case "GENERAL_PEST":
      return "General pest control — one-time treatment";
    case "WASP_NEST":
      return `Wasp / hornet nest removal${
        (opts.nestCount ?? 1) > 1 ? ` — ${opts.nestCount} nests` : ""
      }`;
    case "RODENT":
      return `Rodent treatment${sizeLabel ? ` — ${sizeLabel}` : ""}`;
    case "ROACH":
      return `Specialized roach treatment${sizeLabel ? ` — ${sizeLabel}` : ""}`;
    case "TERMITE":
      return `Termite treatment${sizeLabel ? ` — ${sizeLabel}` : ""}`;
    case "WILDLIFE": {
      const kind = opts.removalKind?.trim();
      const count = opts.removalCount ?? 1;
      const named = kind && kind.toLowerCase() !== WILDLIFE_OTHER_KIND.toLowerCase();
      const scope = named
        ? ` — ${count > 1 ? `${count} ` : ""}${kind!.toLowerCase()}`
        : count > 1
          ? ` — ${count} animals`
          : "";
      return `Wildlife exclusion and removal${scope}`;
    }
    case "COMMERCIAL_PEST":
      return `Commercial pest control${sizeLabel ? ` — ${sizeLabel}` : ""}`;
    case "HOA_COMMON_AREA":
      return `Community common-area pest control${
        opts.units != null ? ` — ${opts.units} units` : ""
      }`;
    case "MOSQUITO":
      return "Mosquito plan (Apr–Oct)";
    case "MOSQUITO_TICK":
      return "Mosquito + tick plan (Apr–Oct)";
  }
}

/** A recurring enrollment's plan name — the label root + " plan", exactly
 *  what finalization has always derived by stripping the size suffix. */
export function planNameFor(id: CatalogServiceId): string {
  const base = serviceLabelFor(id).replace(/ — .*$/, "");
  // GL-17: seasonal labels already say "plan" — never "… plan plan".
  return /\bplan\b/i.test(base) ? base : `${base} plan`;
}

/**
 * Resolve ANY service string this business has ever written — funnel
 * labels, plan names, lead-pricing labels, the office's historical typed
 * strings — to its catalog entry. Null means genuinely not a catalog
 * service (the caller owns the decision; nothing is silently invented).
 */
export function entryForLabel(
  label: string | null | undefined
): CatalogEntry | null {
  const n = (label ?? "").trim().toLowerCase();
  if (!n) return null;
  // Order matters: more specific phrases first.
  if (n.includes("mosquito") && n.includes("tick")) {
    return SERVICE_CATALOG.MOSQUITO_TICK;
  }
  if (n.includes("mosquito")) return SERVICE_CATALOG.MOSQUITO;
  if (n.includes("wasp") || n.includes("hornet")) return SERVICE_CATALOG.WASP_NEST;
  if (n.includes("roach")) return SERVICE_CATALOG.ROACH;
  if (n.includes("termite")) return SERVICE_CATALOG.TERMITE;
  if (n.includes("wildlife")) return SERVICE_CATALOG.WILDLIFE;
  if (n.includes("rodent") || n.includes("mice") || n.includes("mouse")) {
    return SERVICE_CATALOG.RODENT;
  }
  if (n.includes("common-area") || n.includes("common area") || n.includes("hoa") || n.includes("association")) {
    return SERVICE_CATALOG.HOA_COMMON_AREA;
  }
  if (n.includes("commercial")) return SERVICE_CATALOG.COMMERCIAL_PEST;
  if (n.includes("general pest") || n.includes("pest control") || n === "gpc") {
    return SERVICE_CATALOG.GENERAL_PEST;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GL-20 tie — the public-promise conflict inventory
// ---------------------------------------------------------------------------

export type PublicConflict = {
  /** Exact public file(s) carrying the promise. */
  files: string[];
  /** The current public promise, quoted or summarized. */
  promise: string;
  /** Why it conflicts with the catalog/operations. */
  conflict: string;
  /** The proposed replacement — awaiting explicit CEO approval; the CRM
   *  never conceals or contradicts the mismatch. */
  proposal: string;
};

/**
 * Every known mismatch between the public site and this catalog /
 * operations. Rendered on the CRM Catalog screen so the mismatches stay
 * VISIBLE (never silently edited — public changes need explicit CEO
 * approval, GL-20).
 */
export const PUBLIC_CONFLICTS: PublicConflict[] = [
  {
    files: ["apps/web/src/pages/LicensedInsured.tsx"],
    promise:
      'License credential cards render the word "Active" and fixed license numbers as static text.',
    conflict:
      "Status and numbers are hard-coded, not driven by the CRM's verified technician-license records (GL-17).",
    proposal:
      "Render badges from verified current license data (or remove status wording); Compliance approves state-specific wording.",
  },
  {
    files: [
      "apps/web/src/components (site-wide announcement banner)",
    ],
    promise: 'A "4.9 Google Rating" appears site-wide.',
    conflict:
      "The structured-data layer deliberately omits an aggregate rating until reviews are collected — the banner asserts a statistic the business cannot substantiate.",
    proposal: "Remove the rating claim until real review data exists, or substantiate it with collected reviews.",
  },
  {
    files: [
      "apps/web/src/pages/services (attic restoration, rodent entry-sealing, wood-boring, tick program)",
    ],
    promise:
      "Specialized service pages ship ant-control titles, descriptions, and breadcrumbs.",
    conflict:
      "Copy-pasted metadata names the wrong service; these specialized services also have no selectable CRM/lead outcome in this catalog.",
    proposal:
      "Correct each page's metadata to its own service AND either add the service to this catalog (with pricing/dispatch/reporting behind it) or remove the page's booking calls-to-action.",
  },
  {
    files: [
      "apps/web/src/pages/Communities.tsx",
      "apps/web/src/pages/InUnitServices.tsx",
    ],
    promise: '"Residents can schedule in-unit service directly."',
    conflict:
      "No property-scoped resident scheduling flow exists (GL-11); the catalog has no in-unit resident service either.",
    proposal:
      "Back the claim with the approved property-scoped flow, or remove it until that flow ships.",
  },
  {
    files: ["apps/web/src/pages/services (specialized pages)"],
    promise: 'Blanket "exact price / no callbacks / no waiting" claims.',
    conflict:
      "Specialized work can fall to the honest review/callback path (catalog misses, unpriceable requests); the blanket claim overpromises.",
    proposal:
      "Limit the claims to services and circumstances this catalog prices instantly, with the review fallback disclosed before payment.",
  },
];
