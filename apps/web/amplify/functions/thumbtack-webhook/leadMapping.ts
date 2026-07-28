/**
 * Thumbtack questionnaire → BuzzKill quote inputs.
 *
 * Thumbtack's category questionnaire already carries most of what the pricing
 * engine keys on — property type, pest, and a square-footage BAND — so a lead
 * can usually be priced without asking the customer anything. What it never
 * carries is the street address (only Instant Book collects one) or an email.
 *
 * Everything here is deliberately conservative: an answer we do not recognise
 * becomes `null`, and a null anywhere the price depends on means "ask a human"
 * rather than "guess". A wrong guess here reaches a customer as a real price.
 */

export type TtDetail = { question?: string; answer?: string };

export type MappedLead = {
  service: string | null;
  propertyClass: "RESIDENTIAL" | "COMMERCIAL" | "COMMUNITY" | null;
  sqft: number | null;
  lotHalfAcres: number | null;
  units: number | null;
  /** Why we could not map it — surfaced to staff verbatim, never to the customer. */
  gaps: string[];
};

const norm = (v: string | undefined | null) => (v ?? "").trim().toLowerCase();

/** Answers are looked up by fuzzy question match: Thumbtack varies the exact
 *  wording per category ("Property size" vs "Total square footage of building"). */
export function answerFor(details: TtDetail[], ...needles: string[]): string | null {
  for (const needle of needles) {
    const hit = details.find((d) => norm(d.question).includes(needle));
    if (hit?.answer?.trim()) return hit.answer.trim();
  }
  return null;
}

/**
 * "3,000 - 4,000 sq ft" → 4000. Thumbtack answers are always ranges, and the
 * TOP of the band is used on purpose: under-quoting a job we then have to
 * re-price is worse for the customer than quoting the honest ceiling.
 */
export function sqftFromBand(answer: string | null): number | null {
  if (!answer) return null;
  const numbers = answer.replace(/,/g, "").match(/\d+/g);
  if (!numbers?.length) return null;
  const values = numbers.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!values.length) return null;
  return Math.max(...values);
}

/**
 * Lot size band → half-acres, which is what `priceMosquito` charges by.
 * One acre is 43,560 sq ft, so a half-acre is 21,780. Always at least 1: there
 * is no such thing as a zero-half-acre mosquito treatment.
 */
export function halfAcresFromBand(answer: string | null): number | null {
  if (!answer) return null;
  const acres = /acre/i.test(answer);
  const top = sqftFromBand(answer);
  if (top == null) return null;
  const squareFeet = acres ? top * 43_560 : top;
  return Math.max(1, Math.min(8, Math.ceil(squareFeet / 21_780)));
}

/** Thumbtack's property-type answer → our property class. */
export function propertyClassFrom(answer: string | null): MappedLead["propertyClass"] {
  const v = norm(answer);
  if (!v) return null;
  if (/(^|\W)(residential|home|house|apartment|condo unit|townhouse)/.test(v)) {
    return "RESIDENTIAL";
  }
  if (/(commercial|business|office|restaurant|retail|warehouse|industrial)/.test(v)) {
    return "COMMERCIAL";
  }
  if (/(hoa|community|association|multi-?family|apartment complex)/.test(v)) {
    return "COMMUNITY";
  }
  return null;
}

/**
 * Thumbtack category + pest answer → a SERVICE_CATALOG service id.
 *
 * Category alone is not enough: "Pest Control Services" covers ants (general
 * pest), wasps (priced per nest) and rodents, which price completely
 * differently. The pest answer wins when it is decisive.
 */
export function serviceFrom(
  category: string | null,
  pestAnswer: string | null,
  propertyClass: MappedLead["propertyClass"]
): string | null {
  const cat = norm(category);
  const pest = norm(pestAnswer);

  // Mosquito is its own Thumbtack category and its own seasonal product.
  if (/mosquito/.test(cat) || /mosquito/.test(pest)) return "MOSQUITO";
  if (/tick/.test(pest)) return "MOSQUITO_TICK";

  // Count-priced services override the property-class rule entirely.
  if (/(wasp|hornet|yellow ?jacket|bee)/.test(pest)) return "WASP_NEST";
  if (/(bat|raccoon|squirrel|skunk|opossum|groundhog|wildlife)/.test(pest)) {
    return "WILDLIFE";
  }
  if (/(rat|mice|mouse|rodent)/.test(pest)) return "RODENT";
  if (/termite/.test(cat) || /termite/.test(pest)) return "TERMITE";

  if (/(pest control|pesticide|exterminat)/.test(cat)) {
    return propertyClass === "COMMERCIAL" ? "COMMERCIAL_PEST" : "GENERAL_PEST";
  }
  return null;
}

/** Some pests are priced by COUNT, and Thumbtack never asks how many. Those
 *  always need a human (or a follow-up question) before a number is quoted. */
export const COUNT_PRICED = new Set(["WASP_NEST", "WILDLIFE"]);

export function mapThumbtackLead(
  category: string | null,
  details: TtDetail[]
): MappedLead {
  const gaps: string[] = [];

  const propertyClass = propertyClassFrom(
    answerFor(details, "property type", "type of property")
  );
  if (!propertyClass) gaps.push("property type");

  const pestAnswer = answerFor(
    details,
    "primary pest",
    "target pest",
    "pest type",
    "what kind of pest",
    "animal"
  );
  const service = serviceFrom(category, pestAnswer, propertyClass);
  if (!service) gaps.push("service (category and pest answer were not decisive)");

  const sqft = sqftFromBand(
    answerFor(details, "square footage", "square feet", "size of building", "home size")
  );
  const lotHalfAcres =
    service === "MOSQUITO" || service === "MOSQUITO_TICK"
      ? halfAcresFromBand(answerFor(details, "property size", "yard size", "lot size"))
      : null;
  const units = (() => {
    const raw = answerFor(details, "how many units", "number of units", "unit count");
    const n = raw ? Number(raw.replace(/[^\d]/g, "")) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  // Only complain about the input the CHOSEN service actually prices on.
  if (service === "MOSQUITO" || service === "MOSQUITO_TICK") {
    if (lotHalfAcres == null) gaps.push("yard size");
  } else if (service === "COMMUNITY" || propertyClass === "COMMUNITY") {
    if (units == null) gaps.push("unit count");
  } else if (service && COUNT_PRICED.has(service)) {
    gaps.push(
      service === "WASP_NEST"
        ? "nest count (Thumbtack never asks)"
        : "animal count (Thumbtack never asks)"
    );
  } else if (service && sqft == null) {
    gaps.push("square footage");
  }

  return { service, propertyClass, sqft, lotHalfAcres, units, gaps };
}
