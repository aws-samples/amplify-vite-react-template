// Carrier-submission application forms: the shared eForm header plus the
// ACORD 125 and 140 sections. Public entry point: ./acord.ts

import { AGENCY } from "./agency";
import type { Account } from "./client";
import type { AcordFormDef } from "./acordRegistry";
import { fmtUs, todayUs } from "./acordFormat";
import { CONSTRUCTION_LABELS, CONSTRUCTION_PHRASES } from "./enums";
import {
  fillTemplate,
  type FieldValues,
  type FillResult,
  type SignatureInfo,
} from "./acordPdf";

// ── Carrier-submission application forms (125 / 126 / 140 / 151) ──────

interface BuildingInfo {
  label?: string | null;
  sqft?: number | null;
  streetAddress?: string | null;
  description?: string | null;
}

/** ACORD 125 has four premises rows on the form; the rest go on a schedule. */
const PREMISES_ROWS = ["A", "B", "C", "D"] as const;

const STOREY_WORD: Record<number, string> = {
  1: "one-story",
  2: "two-story",
  3: "three-story",
  4: "four-story",
};

/**
 * Underwriters read this line first. Build it from what the CRM knows —
 * "52-unit residential condominium association consisting of 13 two-story
 * wood-frame buildings constructed 2016-2017" — rather than emitting a
 * generic label that tells them nothing.
 */
function operationsSummary(
  account: Account,
  buildingCount: number
): string {
  if (account.type !== "ASSOCIATION") return "";
  const bits: string[] = [];
  bits.push(
    account.unitCount
      ? `${account.unitCount}-unit residential condominium association`
      : "Residential condominium association"
  );
  const shape = [
    account.stories ? STOREY_WORD[account.stories] ?? `${account.stories}-story` : "",
    account.constructionType
      ? CONSTRUCTION_PHRASES[account.constructionType] ?? ""
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  if (buildingCount > 0) {
    bits.push(
      `consisting of ${buildingCount} ${shape ? shape + " " : ""}building${
        buildingCount === 1 ? "" : "s"
      }`
    );
  } else if (shape) {
    bits.push(`${shape} construction`);
  }
  if (account.yearBuilt) bits.push(`constructed ${account.yearBuilt}`);
  return bits.join(" ") + ".";
}

/**
 * Registry keys buildAppFormValues actually has a mapping branch for. Every
 * other entry would generate with nothing but the shared header, so the UI
 * keeps its Generate button off. Add a key here when you add its branch.
 */
export const MAPPED_APP_FORM_KEYS = new Set(["acord125", "acord140"]);

/**
 * Shared applicant/producer values for the application-section forms.
 * The producer/insured blocks follow the same eForm naming convention as
 * the ACORD 25, so they're high-confidence; form-specific fields carry
 * best-effort candidates — refine them via Settings → Inspect fields
 * exactly like the 25 (misses are reported after each generation).
 */
function buildAppFormValues(
  formKey: string,
  account: Account,
  buildings: BuildingInfo[],
  /**
   * When the coverage being applied for starts. For a lead that's the
   * incumbent's expiration; for a client it's the expiring policy's end date
   * — `currentPolicyExpiration` is a lead-only field and is meaningless once
   * bound policies exist.
   */
  renewalDate?: string | null,
  /** Lines being applied for — ticks the line-of-business boxes. */
  lines: string[] = []
): FieldValues {
  const totalSqft = buildings.reduce((s, b) => s + (b.sqft ?? 0), 0);

  const zip = account.zip ?? "";
  const state = account.state ?? "";
  const city = account.city ?? "";
  const addr = account.address ?? "";
  const yb = account.yearBuilt?.toString() ?? "";
  const stories = account.stories?.toString() ?? "";
  const area = totalSqft ? totalSqft.toString() : "";
  const construction = account.constructionType
    ? CONSTRUCTION_LABELS[account.constructionType] ?? ""
    : "";

  // ── Shared header ──
  // Every ACORD eForm uses this naming convention, so this block applies to
  // all of them. Candidates with no matching field are skipped and reported,
  // so listing a field a given form lacks costs nothing.
  const legalName = account.legalName?.trim() || account.name;
  const proposedEff =
    renewalDate ??
    (account.stage === "CLIENT" ? "" : account.currentPolicyExpiration ?? "");

  const values: FieldValues = {
    date: {
      candidates: ["Form_CompletionDate_A"],
      value: todayUs(),
    },

    producer: { candidates: ["Producer_FullName_A"], value: AGENCY.name },
    producerContact: {
      candidates: ["Producer_ContactPerson_FullName_A"],
      value: AGENCY.contactName,
    },
    producerAddr1: { candidates: ["Producer_MailingAddress_LineOne_A"], value: AGENCY.addressLine1 },
    producerCity: { candidates: ["Producer_MailingAddress_CityName_A"], value: AGENCY.city },
    producerState: { candidates: ["Producer_MailingAddress_StateOrProvinceCode_A"], value: AGENCY.state },
    producerZip: { candidates: ["Producer_MailingAddress_PostalCode_A"], value: AGENCY.zip },
    producerPhone: { candidates: ["Producer_ContactPerson_PhoneNumber_A"], value: AGENCY.phone },
    producerEmail: { candidates: ["Producer_ContactPerson_EmailAddress_A"], value: AGENCY.email },

    // Carriers match submissions on the legal entity, not the short name.
    insured: { candidates: ["NamedInsured_FullName_A"], value: legalName },
    insuredAddr1: { candidates: ["NamedInsured_MailingAddress_LineOne_A"], value: account.address ?? "" },
    insuredCity: { candidates: ["NamedInsured_MailingAddress_CityName_A"], value: account.city ?? "" },
    insuredState: { candidates: ["NamedInsured_MailingAddress_StateOrProvinceCode_A"], value: account.state ?? "" },
    insuredZip: { candidates: ["NamedInsured_MailingAddress_PostalCode_A"], value: account.zip ?? "" },
    insuredPhone: { candidates: ["NamedInsured_Primary_PhoneNumber_A"], value: account.contactPhone ?? "" },
    insuredFein: { candidates: ["NamedInsured_TaxIdentifier_A"], value: account.fein ?? "" },
    insuredSic: { candidates: ["NamedInsured_SICCode_A"], value: account.sicCode ?? "" },
    insuredNaics: { candidates: ["NamedInsured_NAICSCode_A"], value: account.naicsCode ?? "" },

    policyEffective: { candidates: ["Policy_EffectiveDate_A"], value: fmtUs(proposedEff) },
    carrierName: {
      candidates: ["Policy_Insurer_FullName_A", "Insurer_FullName_A"],
      value: "",
    },
  };

  if (formKey === "acord125") {
    // Commercial Insurance Application — producer, applicant, premises.
    // A renewal submission is proposed to start when the current term ends.
    const proposedExp = proposedEff
      ? (() => {
          const d = new Date(proposedEff + "T00:00:00");
          d.setFullYear(d.getFullYear() + 1);
          return d.toISOString().slice(0, 10);
        })()
      : "";

    Object.assign(values, {
      notForProfit: {
        candidates: ["NamedInsured_LegalEntity_NotForProfitIndicator_A"],
        value: account.type === "ASSOCIATION" ? "x" : "",
      },
      condoType: {
        candidates: ["BusinessInformation_BusinessType_CondominiumsIndicator_A"],
        value: account.type === "ASSOCIATION" ? "x" : "",
      },

      proposedEffective: { candidates: ["Policy_EffectiveDate_A"], value: fmtUs(proposedEff) },
      proposedExpiration: { candidates: ["Policy_ExpirationDate_A"], value: fmtUs(proposedExp) },

      // Who the carrier's inspector calls to get on site.
      inspectionLabel: {
        candidates: ["NamedInsured_Contact_ContactDescription_A"],
        value: account.inspectionContactName ? "Inspection" : "",
      },
      inspectionName: {
        candidates: ["NamedInsured_Contact_FullName_A"],
        value: account.inspectionContactName ?? "",
      },
      inspectionPhone: {
        candidates: ["NamedInsured_Contact_PrimaryPhoneNumber_A"],
        value: account.inspectionContactPhone ?? "",
      },

      // ── Incumbent coverage ──
      priorCarrier: {
        candidates: ["PriorCoverage_GeneralLiability_InsurerFullName_A"],
        value: account.priorCarrierName ?? "",
      },
      priorPolicyNumber: {
        candidates: ["PriorCoverage_GeneralLiability_PolicyNumberIdentifier_A"],
        value: account.priorPolicyNumber ?? "",
      },
      priorPremium: {
        candidates: ["PriorCoverage_GeneralLiability_TotalPremiumAmount_A"],
        value: account.priorPremium != null ? account.priorPremium.toFixed(2) : "",
      },
      priorEffective: {
        candidates: ["PriorCoverage_GeneralLiability_EffectiveDate_A"],
        value: fmtUs(account.priorTermEffective),
      },
      priorExpiration: {
        candidates: ["PriorCoverage_GeneralLiability_ExpirationDate_A"],
        value: fmtUs(account.priorTermExpiration),
      },
      priorPolicyYear: {
        candidates: ["PriorCoverage_PolicyYear_A"],
        value: account.priorTermEffective
          ? account.priorTermEffective.slice(0, 4)
          : "",
      },

      natureOfBusiness: {
        candidates: [
          "CommercialPolicy_OperationsDescription_A",
          "BuildingOccupancy_OperationsDescription_A",
        ],
        value: operationsSummary(account, buildings.length),
      },
    } satisfies FieldValues);

    // ── Lines of business ──
    // Maps the CRM's line vocabulary onto the 125's checkboxes. Candidates
    // that a template edition lacks are skipped, so unknowns cost nothing.
    const LOB_FIELDS: Record<string, string[]> = {
      "Property": ["Policy_LineOfBusiness_CommercialProperty_A", "Policy_LineOfBusiness_CommercialPropertyIndicator_A"],
      "General Liability": ["Policy_LineOfBusiness_CommercialGeneralLiability_A", "Policy_LineOfBusiness_CommercialGeneralLiabilityIndicator_A"],
      "Crime/Fidelity": ["Policy_LineOfBusiness_CrimeIndicator_A"],
      "Umbrella": ["Policy_LineOfBusiness_UmbrellaIndicator_A", "Policy_LineOfBusiness_ExcessLiabilityIndicator_A"],
      "Workers Comp": ["Policy_LineOfBusiness_WorkersCompensationIndicator_A"],
      "Flood": ["Policy_LineOfBusiness_FloodIndicator_A"],
      "Earthquake": ["Policy_LineOfBusiness_EarthquakeIndicator_A"],
      "D&O": ["Policy_LineOfBusiness_ManagementLiabilityIndicator_A", "Policy_LineOfBusiness_DirectorsAndOfficersIndicator_A"],
    };
    for (const line of lines) {
      const candidates = LOB_FIELDS[line];
      if (!candidates) continue;
      values[`lob_${line.replace(/\W+/g, "")}`] = { candidates, value: "x" };
    }
    // Anything without its own box goes in the Other row.
    const otherLines = lines.filter((l) => !LOB_FIELDS[l]);
    if (otherLines.length) {
      values.lobOther = {
        candidates: ["Policy_LineOfBusiness_OtherIndicator_A"],
        value: "x",
      };
      values.lobOtherDesc = {
        candidates: [
          "Policy_LineOfBusiness_OtherDescription_A",
          "OtherLineOfBusiness_LineOfBusinessDescription_A",
        ],
        value: otherLines.join(", "),
      };
    }

    // ── Policy information ──
    // A carrier submission is a request to quote, not an issued policy.
    Object.assign(values, {
      policyStatusQuote: {
        candidates: ["Policy_Status_QuoteIndicator_A"],
        value: "x",
      },
      policyNumber: {
        candidates: ["Policy_PolicyNumberIdentifier_A"],
        // New business has no number yet; a renewal carries the incumbent's.
        value: account.priorPolicyNumber ?? "",
      },
      billingPlanDirect: {
        candidates: ["CommercialPolicy_BillingPlan_DirectBillIndicator_A"],
        value: "x",
      },
    } satisfies FieldValues);

    // ── Attachments ──
    // Only tick what we actually send, so the underwriter isn't hunting for
    // a schedule that doesn't exist.
    values.attachRemarks = {
      candidates: [
        "CommercialPolicy_Attachment_AdditionalRemarksScheduleIndicator_A",
        "Policy_SectionAttached_AdditionalRemarksIndicator_A",
      ],
      value: (account.notes ?? "").trim() ? "x" : "",
    };
    values.attachPropertySection = {
      candidates: ["Policy_SectionAttached_CommercialPropertyIndicator_A"],
      value: lines.includes("Property") ? "x" : "",
    };
    values.attachGlSection = {
      candidates: ["Policy_SectionAttached_CommercialGeneralLiabilityIndicator_A"],
      value: lines.includes("General Liability") ? "x" : "",
    };

    // ── Premises schedule ──
    // One row per building. Falls back to the account address when no
    // buildings are recorded, which is what the old mapping always did.
    const premises = buildings.length
      ? buildings
      : [{ streetAddress: addr, sqft: totalSqft || null, description: null }];

    premises.slice(0, PREMISES_ROWS.length).forEach((b, i) => {
      const row = PREMISES_ROWS[i];
      const line1 = b.streetAddress?.trim() || b.label?.trim() || addr;
      Object.assign(values, {
        [`premisesNum${row}`]: {
          candidates: [`CommercialStructure_Location_ProducerIdentifier_${row}`],
          value: String(i + 1),
        },
        [`premisesAddr${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_LineOne_${row}`],
          value: line1,
        },
        [`premisesCity${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_CityName_${row}`],
          value: city,
        },
        [`premisesCounty${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_CountyName_${row}`],
          value: account.county ?? "",
        },
        [`premisesState${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_StateOrProvinceCode_${row}`],
          value: state,
        },
        [`premisesZip${row}`]: {
          candidates: [`CommercialStructure_PhysicalAddress_PostalCode_${row}`],
          value: zip,
        },
        [`premisesArea${row}`]: {
          candidates: [`Construction_BuildingArea_${row}`],
          value: b.sqft != null ? String(b.sqft) : "",
        },
        // An association owns its buildings and sits inside town limits.
        [`premisesOwner${row}`]: {
          candidates: [`CommercialStructure_InsuredInterest_OwnerIndicator_${row}`],
          value: account.type === "ASSOCIATION" ? "x" : "",
        },
        [`premisesInCity${row}`]: {
          candidates: [`CommercialStructure_RiskLocation_InsideCityLimitsIndicator_${row}`],
          value: "x",
        },
        [`premisesDesc${row}`]: {
          candidates: [`BuildingOccupancy_OperationsDescription_${row}`],
          value: b.description?.trim() || "",
        },
      } satisfies FieldValues);
    });

    // More buildings than the form has rows — flag the attachment so the
    // underwriter knows a schedule follows rather than assuming four.
    if (buildings.length > PREMISES_ROWS.length) {
      values.additionalPremises = {
        candidates: ["CommercialPolicy_Attachment_AdditionalPremisesScheduleIndicator_A"],
        value: "x",
      };
    }
  }

  if (formKey === "acord126") {
    // GL section — only the header maps from account data; GL limits are
    // entered per submission. Named insured / producer / effective already set.
  }

  if (formKey === "acord140") {
    // Property section — the richest mapping (construction, improvements, TIV).
    Object.assign(values, {
      structureAddr1: { candidates: ["CommercialStructure_PhysicalAddress_LineOne_A"], value: addr },
      constructionCode: { candidates: ["Construction_ConstructionCode_A"], value: construction },
      stories: { candidates: ["Construction_StoreyCount_A"], value: stories },
      builtYear: { candidates: ["CommercialStructure_BuiltYear_A"], value: yb },
      buildingArea: { candidates: ["Construction_BuildingArea_A"], value: area },
      tivLimit: {
        candidates: ["CommercialProperty_Premises_LimitAmount_A"],
        value: account.totalInsuredValue != null ? Math.round(account.totalInsuredValue).toString() : "",
      },
      // System-improvement years + their "improved" indicators.
      wiringYear: { candidates: ["BuildingImprovement_WiringYear_A"], value: account.electricalUpdatedYear?.toString() ?? "" },
      wiringInd: {
        candidates: ["BuildingImprovement_WiringIndicator_A"],
        value: account.electricalUpdatedYear ? "x" : "",
      },
      roofYear: { candidates: ["BuildingImprovement_RoofingYear_A"], value: account.roofUpdatedYear?.toString() ?? "" },
      roofInd: {
        candidates: ["BuildingImprovement_RoofingIndicator_A"],
        value: account.roofUpdatedYear ? "x" : "",
      },
      plumbingYear: { candidates: ["BuildingImprovement_PlumbingYear_A"], value: account.plumbingUpdatedYear?.toString() ?? "" },
      plumbingInd: {
        candidates: ["BuildingImprovement_PlumbingIndicator_A"],
        value: account.plumbingUpdatedYear ? "x" : "",
      },
      heatingYear: { candidates: ["BuildingImprovement_HeatingYear_A"], value: account.hvacUpdatedYear?.toString() ?? "" },
      heatingInd: {
        candidates: ["BuildingImprovement_HeatingIndicator_A"],
        value: account.hvacUpdatedYear ? "x" : "",
      },
    } satisfies FieldValues);
  }

  return values;
}

export async function fillAcordApp(
  form: AcordFormDef,
  account: Account,
  buildings: BuildingInfo[],
  signature?: SignatureInfo | null,
  renewalDate?: string | null,
  lines: string[] = []
): Promise<FillResult> {
  return fillTemplate(
    form.path,
    buildAppFormValues(form.key, account, buildings, renewalDate, lines),
    signature
  );
}
