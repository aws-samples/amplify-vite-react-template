export type CityEntry = {
  city: string;
  state: string;
  stateAbbr: string;
  slug: string;
};

/** Generate a URL-safe slug from city + state */
function toSlug(city: string, stateAbbr: string): string {
  return `${city}-${stateAbbr}`
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function entry(city: string, state: string, stateAbbr: string): CityEntry {
  return { city, state, stateAbbr, slug: toSlug(city, stateAbbr) };
}

// ── Massachusetts ────────────────────────────────────────────────────
const MA = (city: string) => entry(city, "Massachusetts", "MA");

// ── Rhode Island ─────────────────────────────────────────────────────
const RI = (city: string) => entry(city, "Rhode Island", "RI");

export const CITIES: CityEntry[] = [
  // Massachusetts
  MA("Acton"),
  MA("Ashland"),
  MA("Auburn"),
  MA("Bellingham"),
  MA("Boston"),
  MA("Boxborough"),
  MA("Braintree"),
  MA("Brockton"),
  MA("Brookline"),
  MA("Canton"),
  MA("Chelmsford"),
  MA("Chelsea"),
  MA("Chestnut Hill"),
  MA("Douglas"),
  MA("Framingham"),
  MA("Franklin"),
  MA("Grafton"),
  MA("Groton"),
  MA("Harvard"),
  MA("Hopedale"),
  MA("Hopkinton"),
  MA("Hudson"),
  MA("Leominster"),
  MA("Marlborough"),
  MA("Maynard"),
  MA("Medfield"),
  MA("Medway"),
  MA("Millis"),
  MA("Natick"),
  MA("Newton"),
  MA("Northborough"),
  MA("Northbridge"),
  MA("Plainville"),
  MA("Quincy"),
  MA("Rutland"),
  MA("Seekonk"),
  MA("Sherborn"),
  MA("Shirley"),
  MA("Shrewsbury"),
  MA("Stoneham"),
  MA("Stoughton"),
  MA("Sudbury"),
  MA("Sutton"),
  MA("Tewksbury"),
  MA("Upton"),
  MA("Uxbridge"),
  MA("Waltham"),
  MA("Webster"),
  MA("Wellesley"),
  MA("Westborough"),
  MA("Weston"),
  MA("Whitman"),
  MA("Worcester"),
  MA("Wrentham"),
  // Rhode Island
  RI("North Providence"),
  RI("Providence"),
];

/** Lookup map by slug for O(1) route matching */
export const CITY_BY_SLUG: Record<string, CityEntry> = Object.fromEntries(
  CITIES.map((c) => [c.slug, c]),
);
