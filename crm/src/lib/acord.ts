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

// Split across ./acordRegistry, ./acordFormat, ./acordPdf, ./acord25 and
// ./acordApp; this file is the public surface and re-exports exactly what
// it exported before the split.

export { ACORD_FORMS, type AcordFormDef } from "./acordRegistry";
export { listTemplateFields, signatureFor } from "./acordPdf";
export { fillAcord25 } from "./acord25";
export { MAPPED_APP_FORM_KEYS, fillAcordApp } from "./acordApp";
