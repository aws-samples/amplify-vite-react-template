// The registry of ACORD templates the app knows about. Deliberately
// dependency-free: mappings and the PDF engine both read it.
// Public entry point: ./acord.ts

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
