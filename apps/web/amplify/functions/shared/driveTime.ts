/**
 * Google Routes API helpers — drive times from BuzzKill HQ and between
 * arbitrary addresses. The key is API-restricted to the Routes API, so
 * plain address strings are used everywhere (no separate geocoding).
 */

export const HQ_ADDRESS = "81 Greenwich Rd, Ware, MA 01082";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const MATRIX_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/** Minutes to drive between two addresses; null when unroutable. */
export async function driveMinutesBetween(
  apiKey: string,
  origin: string,
  destination: string
): Promise<number | null> {
  try {
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.duration",
      },
      body: JSON.stringify({
        origin: { address: origin },
        destination: { address: destination },
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      routes?: { duration?: string }[];
    };
    const seconds = parseInt(json.routes?.[0]?.duration ?? "", 10);
    return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
  } catch {
    return null;
  }
}

/**
 * Drive minutes from one origin address to many destinations in a single
 * computeRouteMatrix call. Returns minutes per destination index; null for
 * unroutable entries. Destinations are capped at 50 per Routes API limits.
 */
export async function driveMatrixFrom(
  apiKey: string,
  origin: string,
  destinations: string[]
): Promise<(number | null)[]> {
  const dests = destinations.slice(0, 50);
  if (dests.length === 0) return [];
  try {
    const res = await fetch(MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
      },
      body: JSON.stringify({
        origins: [{ waypoint: { address: origin } }],
        destinations: dests.map((address) => ({ waypoint: { address } })),
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) return dests.map(() => null);
    // computeRouteMatrix returns a JSON array of elements.
    const elements = (await res.json()) as {
      destinationIndex?: number;
      duration?: string;
      condition?: string;
    }[];
    const out: (number | null)[] = dests.map(() => null);
    for (const el of Array.isArray(elements) ? elements : []) {
      if (el.condition !== "ROUTE_EXISTS") continue;
      const idx = el.destinationIndex ?? -1;
      const seconds = parseInt(el.duration ?? "", 10);
      if (idx >= 0 && idx < out.length && Number.isFinite(seconds)) {
        out[idx] = Math.round(seconds / 60);
      }
    }
    return out;
  } catch {
    return dests.map(() => null);
  }
}
