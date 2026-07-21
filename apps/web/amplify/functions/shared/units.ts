/**
 * Small unit converter for product amounts — enough to deplete inventory and
 * roll usage up, not a general measures library. Three dimensions, each with a
 * canonical base:
 *   - volume  → base "fl oz"   (liquid concentrates, dilutions)
 *   - weight  → base "oz"      (granular baits, dusts)
 *   - count   → base "each"    (stations, tablets, packs)
 *
 * "oz" is treated as WEIGHT and "fl oz" as VOLUME on purpose — pest-control
 * records use both, and conflating them would silently corrupt stock math.
 * A unit we don't recognize returns null; callers deplete only when the usage
 * unit converts into the product's stockUnit, and otherwise skip (and say so)
 * rather than guess.
 */

export type UnitDimension = "volume" | "weight" | "count";

type UnitDef = { dim: UnitDimension; perBase: number };

// perBase = how many canonical base units one of this unit equals.
const UNITS: Record<string, UnitDef> = {
  // volume — base fl oz
  "fl oz": { dim: "volume", perBase: 1 },
  floz: { dim: "volume", perBase: 1 },
  gal: { dim: "volume", perBase: 128 },
  gallon: { dim: "volume", perBase: 128 },
  qt: { dim: "volume", perBase: 32 },
  quart: { dim: "volume", perBase: 32 },
  pt: { dim: "volume", perBase: 16 },
  pint: { dim: "volume", perBase: 16 },
  cup: { dim: "volume", perBase: 8 },
  tbsp: { dim: "volume", perBase: 0.5 },
  tsp: { dim: "volume", perBase: 1 / 6 },
  ml: { dim: "volume", perBase: 0.0338140227 },
  l: { dim: "volume", perBase: 33.8140227 },
  liter: { dim: "volume", perBase: 33.8140227 },
  litre: { dim: "volume", perBase: 33.8140227 },
  // weight — base oz
  oz: { dim: "weight", perBase: 1 },
  ounce: { dim: "weight", perBase: 1 },
  lb: { dim: "weight", perBase: 16 },
  lbs: { dim: "weight", perBase: 16 },
  pound: { dim: "weight", perBase: 16 },
  g: { dim: "weight", perBase: 0.0352739619 },
  gram: { dim: "weight", perBase: 0.0352739619 },
  kg: { dim: "weight", perBase: 35.2739619 },
  // count — base each
  each: { dim: "count", perBase: 1 },
  ea: { dim: "count", perBase: 1 },
  unit: { dim: "count", perBase: 1 },
  station: { dim: "count", perBase: 1 },
  stations: { dim: "count", perBase: 1 },
  bait: { dim: "count", perBase: 1 },
  baits: { dim: "count", perBase: 1 },
  tablet: { dim: "count", perBase: 1 },
  tablets: { dim: "count", perBase: 1 },
  pack: { dim: "count", perBase: 1 },
  packs: { dim: "count", perBase: 1 },
};

/** A curated, ordered set of units for a picker. */
export const COMMON_UNITS = [
  "fl oz",
  "gal",
  "qt",
  "oz",
  "lb",
  "g",
  "mL",
  "L",
  "each",
] as const;

/** Lowercase + fold common spellings so "FL OZ", "Fl. Oz.", "gallons" match. */
export function normalizeUnit(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ");
}

function lookup(unit: string | null | undefined): UnitDef | null {
  const key = normalizeUnit(unit);
  if (UNITS[key]) return UNITS[key];
  // Tolerate a trailing "s" plural not listed explicitly (e.g. "cups").
  if (key.endsWith("s") && UNITS[key.slice(0, -1)]) return UNITS[key.slice(0, -1)];
  return null;
}

/** The measurement family of a unit, or null if unrecognized. */
export function dimensionOf(unit: string | null | undefined): UnitDimension | null {
  return lookup(unit)?.dim ?? null;
}

/**
 * Convert `value` from `fromUnit` into `toUnit`. Returns null when either unit
 * is unknown or they belong to different dimensions (e.g. oz→gal) — the caller
 * must decide what to do with an inconvertible amount, never silently coerce.
 */
export function convert(
  value: number,
  fromUnit: string | null | undefined,
  toUnit: string | null | undefined
): number | null {
  if (!Number.isFinite(value)) return null;
  const from = lookup(fromUnit);
  const to = lookup(toUnit);
  if (!from || !to || from.dim !== to.dim) return null;
  return (value * from.perBase) / to.perBase;
}

/**
 * Parse a free-text amount like "2 oz", "1.5 fl oz", "3" into a numeric value
 * and its (normalized) unit. Mirrors the compliance parser but keeps the unit
 * verbatim (normalized) so it can be converted. Returns null when there's no
 * number to read.
 */
export function parseAmount(
  raw: string | null | undefined
): { value: number; unit: string } | null {
  const m = String(raw ?? "")
    .trim()
    .match(/^([0-9]*\.?[0-9]+)\s*(.*)$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: normalizeUnit(m[2]) };
}
