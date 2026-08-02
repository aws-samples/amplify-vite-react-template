/**
 * The amount codec for a service-report product row.
 *
 * Two shapes meet here and they are NOT the same type:
 *
 *  - stored (`amplify/functions/shared/inventory.ts` `ReportProduct`) keeps
 *    `amountValue` as a **number**;
 *  - the tech editor keeps it as the raw **text** of a controlled input, so a
 *    half-typed "2." stays renderable.
 *
 * The editor used to cast the stored JSON straight into its own row type, so a
 * saved report handed it a number and `amountValue.trim()` threw
 * "`.trim is not a function`" — reproducible by reopening a draft report that
 * already carried a structured amount and saving without touching the field.
 * `toAmountText` is the coercion that boundary was missing.
 */

/** Stored value (number) or editor value (string) → editor text. */
export function toAmountText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Split a composed amount ("2 fl oz") into its value + unit for the inputs. */
export function splitAmount(raw: string | undefined): { value: string; unit: string } {
  const m = (raw ?? "").trim().match(/^([0-9]*\.?[0-9]+)\s*(.*)$/);
  if (!m) return { value: "", unit: "" };
  return { value: m[1], unit: m[2].trim() };
}

/** Compose the amount string the PDF and legacy readers use. */
export function composeAmount(value: string | undefined, unit: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "";
  return unit ? `${v} ${unit}` : v;
}
