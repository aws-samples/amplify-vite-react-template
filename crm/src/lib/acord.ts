import { PDFDocument, PDFTextField, PDFCheckBox, PDFName, PDFBool } from "pdf-lib";
import { downloadData } from "aws-amplify/storage";
import { getUrl } from "aws-amplify/storage";
import { AGENCY } from "./agency";
import type { Account, Carrier, Certificate, Policy } from "./client";

/**
 * Mapping-driven ACORD form autofill.
 *
 * ACORD fillable PDFs are licensed, so templates are uploaded by the agency
 * to S3 (templates/acord25.pdf) via Settings. Field names vary between form
 * editions, so every logical value maps to a list of CANDIDATE field names —
 * the first one present in the template wins, everything else is skipped and
 * reported. Use the field inspector on the Settings page to see a template's
 * real names and extend the candidate lists below as needed.
 *
 * Adding another ACORD form later = new template path + new mapping object.
 */

export const ACORD25_TEMPLATE_PATH = "templates/acord25.pdf";

/** Registry of supported ACORD templates. Adding a form = one entry here
 * plus a mapping (see buildAppFormValues). */
export interface AcordFormDef {
  key: string;
  path: string;
  label: string;
  note: string;
}

export const ACORD_FORMS: AcordFormDef[] = [
  {
    key: "acord25",
    path: ACORD25_TEMPLATE_PATH,
    label: "ACORD 25 — Certificate of Liability Insurance",
    note: "Used by the Certificates tab on client accounts.",
  },
  {
    key: "acord125",
    path: "templates/acord125.pdf",
    label: "ACORD 125 — Commercial Insurance Application",
    note: "Generated from an account's Documents tab for carrier submissions.",
  },
  {
    key: "acord126",
    path: "templates/acord126.pdf",
    label: "ACORD 126 — Commercial General Liability Section",
    note: "Generated from an account's Documents tab for carrier submissions.",
  },
  {
    key: "acord140",
    path: "templates/acord140.pdf",
    label: "ACORD 140 — Property Section",
    note: "Generated from an account's Documents tab for carrier submissions.",
  },
  // ── Additional submission / certificate forms ──
  // Every ACORD eForm shares the header naming convention below, so these
  // fill producer, insured and signature out of the box. Form-specific
  // sections still need their own mapping — see buildAppFormValues.
  { key: "acord131", path: "templates/acord131.pdf", label: "ACORD 131 — Umbrella / Excess Section", note: "Carrier submissions." },
  { key: "acord141", path: "templates/acord141.pdf", label: "ACORD 141 — Crime Section", note: "Carrier submissions." },
  { key: "acord159", path: "templates/acord159.pdf", label: "ACORD 159 — Contractors Supplement", note: "Carrier submissions." },
  { key: "acord160", path: "templates/acord160.pdf", label: "ACORD 160 — Business Owners Section", note: "Carrier submissions." },
  { key: "acord810", path: "templates/acord810.pdf", label: "ACORD 810 — Directors & Officers Application", note: "Carrier submissions." },
  { key: "acord823", path: "templates/acord823.pdf", label: "ACORD 823 — Condominium Association Supplement", note: "Carrier submissions." },
  { key: "acord45", path: "templates/acord45.pdf", label: "ACORD 45 — Additional Interest Schedule", note: "Attaches to an application." },
  { key: "acord101", path: "templates/acord101.pdf", label: "ACORD 101 — Additional Remarks Schedule", note: "Overflow remarks for any form." },
  { key: "acord24", path: "templates/acord24.pdf", label: "ACORD 24 — Certificate of Property Insurance", note: "Issued to holders." },
  { key: "acord27", path: "templates/acord27.pdf", label: "ACORD 27 — Evidence of Property Insurance", note: "Issued to lenders." },
  { key: "acord28", path: "templates/acord28.pdf", label: "ACORD 28 — Evidence of Commercial Property Insurance", note: "Issued to lenders." },
  { key: "acord35", path: "templates/acord35.pdf", label: "ACORD 35 — Cancellation Request / Policy Release", note: "Servicing." },
  { key: "acord36", path: "templates/acord36.pdf", label: "ACORD 36 — Agent / Broker of Record Change", note: "Servicing." },
  { key: "acord75", path: "templates/acord75.pdf", label: "ACORD 75 — Insurance Binder", note: "Issued at bind." },
];

type FieldValues = Record<string, { candidates: string[]; value: string }>;

export interface FillResult {
  bytes: Uint8Array;
  filled: string[]; // logical fields written
  missing: string[]; // logical fields with no matching PDF field
}

const fmtUs = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString("en-US") : "";

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
      value: new Date().toLocaleDateString("en-US"),
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
      value: AGENCY.name,
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
  }

  return values;
}

/**
 * Draw a signature image into a form field's rectangle.
 *
 * ACORD signature slots are plain text fields, so there's nothing to "sign" —
 * we locate the field's widget, then stamp the PNG onto that page at those
 * coordinates and remove the field so it can't be typed over afterwards.
 * Aspect ratio is preserved and the image is inset slightly so it sits on the
 * ruled line rather than across it.
 */
async function stampSignature(
  pdf: PDFDocument,
  fieldName: string,
  pngBytes: Uint8Array
): Promise<boolean> {
  const form = pdf.getForm();
  let field;
  try {
    field = form.getField(fieldName);
  } catch {
    return false;
  }
  const widget = field.acroField.getWidgets()[0];
  if (!widget) return false;

  const rect = widget.getRectangle();
  const pageRef = widget.P();
  const page =
    pdf.getPages().find((p) => p.ref === pageRef) ?? pdf.getPages()[0];

  const png = await pdf.embedPng(pngBytes);
  const pad = 1;
  const maxW = rect.width - pad * 2;
  const maxH = rect.height - pad * 2;
  const scale = Math.min(maxW / png.width, maxH / png.height);
  const w = png.width * scale;
  const h = png.height * scale;

  page.drawImage(png, {
    x: rect.x + pad,
    y: rect.y + pad,
    width: w,
    height: h,
  });

  // The slot is signed — drop the input so nothing can overwrite the mark.
  try {
    form.removeField(field);
  } catch {
    /* older pdf-lib: leaving the field is harmless */
  }
  return true;
}

/** Signature slots we know how to fill, in preference order. */
const SIGNATURE_FIELDS = [
  "Producer_AuthorizedRepresentative_Signature_A",
  "Producer_Signature_A",
  "AuthorizedRepresentative_Signature_A",
];

const SIGNATURE_NAME_FIELDS = [
  "Producer_AuthorizedRepresentative_FullName_A",
  "Producer_ContactPerson_FullName_A",
];

export interface SignatureInfo {
  /** S3 key under signatures/ */
  key: string;
  /** Printed name that accompanies the mark. */
  name: string;
}

/** Fetch a stored signature PNG. Returns null when there isn't one. */
async function loadSignature(key: string): Promise<Uint8Array | null> {
  try {
    const { body } = await downloadData({ path: key }).result;
    const blob = await body.blob();
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function fetchTemplate(path: string): Promise<ArrayBuffer> {
  const { url } = await getUrl({ path });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Template fetch failed (${res.status})`);
  return res.arrayBuffer();
}

/** List every form field in a template PDF — the Settings-page inspector. */
export async function listTemplateFields(path: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await fetchTemplate(path), {
    ignoreEncryption: true,
  });
  // instanceof, not constructor.name — minified builds mangle class names.
  const typeOf = (f: unknown) =>
    f instanceof PDFTextField ? "text" : f instanceof PDFCheckBox ? "checkbox" : "other";
  return pdf
    .getForm()
    .getFields()
    .map((f) => `${f.getName()}  (${typeOf(f)})`);
}

/** Shared fill core: first matching candidate wins; misses are reported. */
async function fillTemplate(
  path: string,
  values: FieldValues,
  signature?: SignatureInfo | null
): Promise<FillResult> {
  const pdf = await PDFDocument.load(await fetchTemplate(path), {
    ignoreEncryption: true,
  });
  const form = pdf.getForm();
  const fieldNames = new Set(form.getFields().map((f) => f.getName()));

  const filled: string[] = [];
  const missing: string[] = [];

  for (const [logical, { candidates, value }] of Object.entries(values)) {
    if (!value) continue;
    const name = candidates.find((c) => fieldNames.has(c));
    if (!name) {
      missing.push(logical);
      continue;
    }
    // Guard each field: a single malformed field on a large ACORD form
    // should never abort the whole generation.
    try {
      const field = form.getField(name);
      if (field instanceof PDFTextField) {
        field.setText(value);
        filled.push(logical);
      } else if (field instanceof PDFCheckBox) {
        field.check();
        filled.push(logical);
      }
    } catch {
      missing.push(logical);
    }
  }

  // ── Signature ──
  // Stamped after the text fields so the printed name is already in place.
  if (signature?.key) {
    for (const nameField of SIGNATURE_NAME_FIELDS) {
      if (!fieldNames.has(nameField)) continue;
      try {
        const f = form.getField(nameField);
        if (f instanceof PDFTextField && !f.getText()) f.setText(signature.name);
      } catch {
        /* non-fatal */
      }
      break;
    }
    const png = await loadSignature(signature.key);
    if (png) {
      for (const sigField of SIGNATURE_FIELDS) {
        if (!fieldNames.has(sigField)) continue;
        const ok = await stampSignature(pdf, sigField, png);
        if (ok) filled.push("signature");
        break;
      }
    }
  }

  // Deliberately NOT flattened — the PDF stays editable for manual touch-ups.
  // pdf-lib regenerates field appearances on save; complex ACORD templates
  // reference fonts pdf-lib can't rebuild, throwing during save. If that
  // happens, set NeedAppearances so the PDF viewer renders values itself
  // and save without pdf-lib's (failing) appearance generation.
  let bytes: Uint8Array;
  try {
    bytes = await pdf.save();
  } catch {
    try {
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
    } catch {
      /* older pdf-lib internals — best effort */
    }
    bytes = await pdf.save({ updateFieldAppearances: false });
  }
  return { bytes, filled, missing };
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

// ── Carrier-submission application forms (125 / 126 / 140 / 151) ──────

const CONSTRUCTION_LABELS: Record<string, string> = {
  FRAME: "Frame",
  JOISTED_MASONRY: "Joisted Masonry",
  NON_COMBUSTIBLE: "Non-Combustible",
  MASONRY_NON_COMBUSTIBLE: "Masonry Non-Combustible",
  MODIFIED_FIRE_RESISTIVE: "Modified Fire Resistive",
  FIRE_RESISTIVE: "Fire Resistive",
};

export interface BuildingInfo {
  label?: string | null;
  sqft?: number | null;
  streetAddress?: string | null;
  description?: string | null;
}

/** ACORD 125 has four premises rows on the form; the rest go on a schedule. */
const PREMISES_ROWS = ["A", "B", "C", "D"] as const;

const CONSTRUCTION_PHRASE: Record<string, string> = {
  FRAME: "wood-frame",
  JOISTED_MASONRY: "joisted masonry",
  NON_COMBUSTIBLE: "non-combustible",
  MASONRY_NON_COMBUSTIBLE: "masonry non-combustible",
  MODIFIED_FIRE_RESISTIVE: "modified fire-resistive",
  FIRE_RESISTIVE: "fire-resistive",
};

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
export function operationsSummary(
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
      ? CONSTRUCTION_PHRASE[account.constructionType] ?? ""
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
 * Shared applicant/producer values for the application-section forms.
 * The producer/insured blocks follow the same eForm naming convention as
 * the ACORD 25, so they're high-confidence; form-specific fields carry
 * best-effort candidates — refine them via Settings → Inspect fields
 * exactly like the 25 (misses are reported after each generation).
 */
function buildAppFormValues(
  formKey: string,
  account: Account,
  buildings: BuildingInfo[]
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
  const proposedEff = account.currentPolicyExpiration ?? "";

  const values: FieldValues = {
    date: {
      candidates: ["Form_CompletionDate_A"],
      value: new Date().toLocaleDateString("en-US"),
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
    const legalName = account.legalName?.trim() || account.name;
    // A renewal submission is proposed to start when the incumbent expires.
    const proposedEff = account.currentPolicyExpiration ?? "";
    const proposedExp = proposedEff
      ? (() => {
          const d = new Date(proposedEff + "T00:00:00");
          d.setFullYear(d.getFullYear() + 1);
          return d.toISOString().slice(0, 10);
        })()
      : "";

    Object.assign(values, {
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
      insuredAddr1: { candidates: ["NamedInsured_MailingAddress_LineOne_A"], value: addr },
      insuredCity: { candidates: ["NamedInsured_MailingAddress_CityName_A"], value: city },
      insuredState: { candidates: ["NamedInsured_MailingAddress_StateOrProvinceCode_A"], value: state },
      insuredZip: { candidates: ["NamedInsured_MailingAddress_PostalCode_A"], value: zip },
      insuredPhone: { candidates: ["NamedInsured_Primary_PhoneNumber_A"], value: account.contactPhone ?? "" },
      insuredFein: { candidates: ["NamedInsured_TaxIdentifier_A"], value: account.fein ?? "" },
      insuredSic: { candidates: ["NamedInsured_SICCode_A"], value: account.sicCode ?? "" },
      insuredNaics: { candidates: ["NamedInsured_NAICSCode_A"], value: account.naicsCode ?? "" },
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
  signature?: SignatureInfo | null
): Promise<FillResult> {
  return fillTemplate(
    form.path,
    buildAppFormValues(form.key, account, buildings),
    signature
  );
}
