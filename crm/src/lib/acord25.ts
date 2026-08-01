// ACORD 25 (Certificate of Liability Insurance) field mapping.
// Public entry point: ./acord.ts

import { AGENCY } from "./agency";
import type { Account, Carrier, Certificate, Policy } from "./client";
import { ACORD25_TEMPLATE_PATH } from "./acordRegistry";
import { amt, fmtUs, todayUs } from "./acordFormat";
import {
  fillTemplate,
  type FieldValues,
  type FillResult,
  type SignatureInfo,
} from "./acordPdf";

/** Candidate names cover the ACORD 25 (2016/03) eForm and common older editions. */
function buildAcord25Values(
  account: Account,
  cert: Certificate,
  policies: Policy[],
  carriers: Carrier[]
): FieldValues {
  const values: FieldValues = {
    date: {
      candidates: ["Form_CompletionDate_A", "DATE", "Date"],
      value: todayUs(),
    },
    certificateNumber: {
      candidates: [
        "CertificateOfLiabilityInsurance_ACORDForm_CertificateNumberIdentifier_A",
        "Certificate_Number_A",
        "CERTIFICATE NUMBER",
      ],
      value: cert.certificateNumber ?? "",
    },

    // ── Producer (agency) block — split address fields ──
    producer: {
      candidates: ["Producer_FullName_A", "PRODUCER", "Producer"],
      value: AGENCY.name,
    },
    producerAddress1: {
      candidates: ["Producer_MailingAddress_LineOne_A"],
      value: AGENCY.addressLine1,
    },
    producerCity: {
      candidates: ["Producer_MailingAddress_CityName_A"],
      value: AGENCY.city,
    },
    producerState: {
      candidates: ["Producer_MailingAddress_StateOrProvinceCode_A"],
      value: AGENCY.state,
    },
    producerZip: {
      candidates: ["Producer_MailingAddress_PostalCode_A"],
      value: AGENCY.zip,
    },
    producerContact: {
      candidates: ["Producer_ContactPerson_FullName_A", "CONTACT NAME:"],
      value: AGENCY.contactName,
    },
    producerPhone: {
      candidates: [
        "Producer_ContactPerson_PhoneNumber_A",
        "PHONE (A/C, No, Ext):",
      ],
      value: AGENCY.phone,
    },
    producerEmail: {
      candidates: ["Producer_ContactPerson_EmailAddress_A", "E-MAIL ADDRESS:"],
      value: AGENCY.email,
    },

    // ── Insured block — split address fields ──
    insured: {
      candidates: ["NamedInsured_FullName_A", "INSURED", "Insured"],
      value: account.name,
    },
    insuredAddress1: {
      candidates: ["NamedInsured_MailingAddress_LineOne_A"],
      value: account.address ?? "",
    },
    insuredCity: {
      candidates: ["NamedInsured_MailingAddress_CityName_A"],
      value: account.city ?? "",
    },
    insuredState: {
      candidates: ["NamedInsured_MailingAddress_StateOrProvinceCode_A"],
      value: account.state ?? "",
    },
    insuredZip: {
      candidates: ["NamedInsured_MailingAddress_PostalCode_A"],
      value: account.zip ?? "",
    },

    // ── Certificate holder ──
    holder: {
      candidates: [
        "CertificateHolder_FullName_A",
        "CERTIFICATE HOLDER",
        "CertificateHolder",
      ],
      value: cert.holderName,
    },
    holderAddress1: {
      candidates: ["CertificateHolder_MailingAddress_LineOne_A"],
      value: cert.holderAddress ?? "",
    },

    // ── Description of operations / remarks ──
    description: {
      candidates: [
        "CertificateOfLiabilityInsurance_ACORDForm_RemarkText_A",
        "OperationsDescription_A",
        "DescriptionOfOperations_A",
        "DESCRIPTION OF OPERATIONS / LOCATIONS / VEHICLES",
      ],
      value: cert.descriptionOfOperations ?? "",
    },
  };

  // ── Insurer letters A–F with NAIC codes ──
  const certPolicies = policies.filter((p) => (cert.policyIds ?? []).includes(p.id));
  const carrierIds = [...new Set(certPolicies.map((p) => p.carrierId).filter(Boolean))];
  const letters = ["A", "B", "C", "D", "E", "F"];
  const letterFor = (carrierId: string | null | undefined): string =>
    carrierId ? letters[carrierIds.indexOf(carrierId)] ?? "" : "";
  carrierIds.slice(0, 6).forEach((cid, i) => {
    const carrier = carriers.find((c) => c.id === cid);
    if (!carrier) return;
    values[`insurer${letters[i]}`] = {
      candidates: [
        `Insurer_FullName_${letters[i]}`,
        `INSURER ${letters[i]} :`,
        `InsurerLetter${letters[i]}`,
      ],
      value: carrier.name,
    };
    if (carrier.naicCode) {
      values[`insurer${letters[i]}Naic`] = {
        candidates: [`Insurer_NAICCode_${letters[i]}`, `NAIC ${letters[i]}`],
        value: carrier.naicCode,
      };
    }
  });

  // ── Coverage rows (policy number / effective / expiration) ──
  const rowFor = (needle: string) =>
    certPolicies.find((p) =>
      (p.lines ?? []).some((l) => l?.toLowerCase().includes(needle))
    );

  const gl = rowFor("liability");
  if (gl) {
    values.glInsurerLetter = {
      candidates: ["GeneralLiability_InsurerLetterCode_A"],
      value: letterFor(gl.carrierId),
    };
    values.glPolicyNumber = {
      candidates: [
        "Policy_GeneralLiability_PolicyNumberIdentifier_A",
        "GeneralLiability_PolicyNumberIdentifier_A",
      ],
      value: gl.policyNumber ?? "",
    };
    values.glEffective = {
      candidates: [
        "Policy_GeneralLiability_EffectiveDate_A",
        "GeneralLiability_PolicyEffectiveDate_A",
      ],
      value: fmtUs(gl.effectiveDate),
    };
    values.glExpiration = {
      candidates: [
        "Policy_GeneralLiability_ExpirationDate_A",
        "GeneralLiability_PolicyExpirationDate_A",
      ],
      value: fmtUs(gl.expirationDate),
    };

    // ── Limits ──
    // A COI without limits is useless to the holder; this is the whole
    // point of the certificate.
    values.glEachOccurrence = {
      candidates: ["GeneralLiability_EachOccurrence_LimitAmount_A"],
      value: amt(gl.glEachOccurrence),
    };
    values.glRentedPremises = {
      candidates: ["GeneralLiability_FireDamageRentedPremises_EachOccurrenceLimitAmount_A"],
      value: amt(gl.glDamageToRentedPremises),
    };
    values.glMedExp = {
      candidates: ["GeneralLiability_MedicalExpense_EachPersonLimitAmount_A"],
      value: amt(gl.glMedicalExpense),
    };
    values.glPersonalAdv = {
      candidates: ["GeneralLiability_PersonalAndAdvertisingInjury_LimitAmount_A"],
      value: amt(gl.glPersonalAdvInjury),
    };
    values.glGeneralAggregate = {
      candidates: ["GeneralLiability_GeneralAggregate_LimitAmount_A"],
      value: amt(gl.glGeneralAggregate),
    };
    values.glProductsAggregate = {
      candidates: ["GeneralLiability_ProductsAndCompletedOperations_AggregateLimitAmount_A"],
      value: amt(gl.glProductsCompletedOps),
    };

    // Occurrence is the default form; only tick claims-made when told.
    values.glOccurrence = {
      candidates: ["GeneralLiability_OccurrenceIndicator_A"],
      value: gl.glClaimsMade ? "" : "x",
    };
    values.glClaimsMade = {
      candidates: ["GeneralLiability_ClaimsMadeIndicator_A"],
      value: gl.glClaimsMade ? "x" : "",
    };

    const aggMap: Record<string, string> = {
      POLICY: "GeneralLiability_GeneralAggregate_LimitAppliesPerPolicyIndicator_A",
      PROJECT: "GeneralLiability_GeneralAggregate_LimitAppliesPerProjectIndicator_A",
      LOCATION: "GeneralLiability_GeneralAggregate_LimitAppliesPerLocationIndicator_A",
      OTHER: "GeneralLiability_GeneralAggregate_LimitAppliesToOtherIndicator_A",
    };
    const aggField = aggMap[gl.glAggregateAppliesTo ?? "POLICY"];
    if (aggField) {
      values.glAggregateApplies = { candidates: [aggField], value: "x" };
    }
  }

  const umbrella = rowFor("umbrella");
  if (umbrella) {
    values.umbInsurerLetter = {
      candidates: ["ExcessUmbrella_InsurerLetterCode_A"],
      value: letterFor(umbrella.carrierId),
    };
    values.umbPolicyNumber = {
      candidates: [
        "Policy_ExcessLiability_PolicyNumberIdentifier_A",
        "ExcessUmbrella_PolicyNumberIdentifier_A",
        "Umbrella_PolicyNumberIdentifier_A",
      ],
      value: umbrella.policyNumber ?? "",
    };
    values.umbEffective = {
      candidates: [
        "Policy_ExcessLiability_EffectiveDate_A",
        "ExcessUmbrella_PolicyEffectiveDate_A",
        "Umbrella_PolicyEffectiveDate_A",
      ],
      value: fmtUs(umbrella.effectiveDate),
    };
    values.umbExpiration = {
      candidates: [
        "Policy_ExcessLiability_ExpirationDate_A",
        "ExcessUmbrella_PolicyExpirationDate_A",
        "Umbrella_PolicyExpirationDate_A",
      ],
      value: fmtUs(umbrella.expirationDate),
    };
  }

  const wc = rowFor("workers");
  if (wc) {
    values.wcInsurerLetter = {
      candidates: ["WorkersCompensationEmployersLiability_InsurerLetterCode_A"],
      value: letterFor(wc.carrierId),
    };
    values.wcPolicyNumber = {
      candidates: [
        "Policy_WorkersCompensationAndEmployersLiability_PolicyNumberIdentifier_A",
      ],
      value: wc.policyNumber ?? "",
    };
    values.wcEffective = {
      candidates: ["Policy_WorkersCompensationAndEmployersLiability_EffectiveDate_A"],
      value: fmtUs(wc.effectiveDate),
    };
    values.wcExpiration = {
      candidates: ["Policy_WorkersCompensationAndEmployersLiability_ExpirationDate_A"],
      value: fmtUs(wc.expirationDate),
    };
  }

  // Property / D&O / crime / flood etc. go in the OTHER row.
  const other = certPolicies.find((p) => p !== gl && p !== umbrella && p !== wc);
  if (other) {
    values.otherInsurerLetter = {
      candidates: ["OtherPolicy_InsurerLetterCode_A"],
      value: letterFor(other.carrierId),
    };
    values.otherPolicyDescription = {
      candidates: [
        "OtherPolicy_OtherPolicyDescription_A",
        "OtherPolicy_PolicyDescription_A",
        "OtherPolicy_CoverageDescription_A",
      ],
      value: (other.lines ?? []).filter(Boolean).join(", "),
    };
    values.otherPolicyNumber = {
      candidates: ["OtherPolicy_PolicyNumberIdentifier_A"],
      value: other.policyNumber ?? "",
    };
    values.otherEffective = {
      candidates: ["OtherPolicy_PolicyEffectiveDate_A"],
      value: fmtUs(other.effectiveDate),
    };
    values.otherExpiration = {
      candidates: ["OtherPolicy_PolicyExpirationDate_A"],
      value: fmtUs(other.expirationDate),
    };
    // The OTHER block carries its own coverage rows — put the blanket limit
    // (or TIV) against the first one so the holder sees a number.
    values.otherCoverageCode = {
      candidates: ["OtherPolicy_CoverageCode_A"],
      value: other.replacementCostType ?? "",
    };
    values.otherCoverageLimit = {
      candidates: ["OtherPolicy_CoverageLimitAmount_A"],
      value: amt(other.blanketLimit),
    };
  }

  return values;
}

export async function fillAcord25(
  account: Account,
  cert: Certificate,
  policies: Policy[],
  carriers: Carrier[],
  signature?: SignatureInfo | null
): Promise<FillResult> {
  return fillTemplate(
    ACORD25_TEMPLATE_PATH,
    buildAcord25Values(account, cert, policies, carriers),
    signature
  );
}
