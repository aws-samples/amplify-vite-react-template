/**
 * Google Routes API helpers — drive times between arbitrary addresses. The key
 * is API-restricted to the Routes API, so plain address strings are used
 * everywhere (no separate geocoding).
 *
 * There is no company HQ: a technician starts and ends the day at their own
 * home base, so "how far away is this address" is only meaningful relative to
 * a technician's base. `driveMinutesFromNearestBase` is the origin-correct way
 * to ask it; `HQ_ADDRESS` survives ONLY as the legacy fallback inside
 * capacity's `baseAddressOf` for a technician whose base was never configured,
 * and must never be used to price or to judge a customer out of area.
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
 * Road distance in meters from a GPS point to an address, in a single Routes
 * call. Used for GL-15's on-site-presence check: the technician's captured
 * coordinate against the customer's service address, with no separate geocoder
 * (Routes accepts a latLng origin and an address destination). Drive distance is
 * always ≥ straight-line, so a small value reliably means "on the property".
 * Returns null when the key is missing, the address won't route, or the call
 * fails — the caller must treat null as "unknown", never as "far".
 */
export async function drivingDistanceMetersFromPoint(
  apiKey: string,
  origin: { lat: number; lng: number },
  destinationAddress: string
): Promise<number | null> {
  try {
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: { latitude: origin.lat, longitude: origin.lng },
          },
        },
        destination: { address: destinationAddress },
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      routes?: { distanceMeters?: number }[];
    };
    const meters = json.routes?.[0]?.distanceMeters;
    return typeof meters === "number" && Number.isFinite(meters) ? meters : null;
  } catch {
    return null;
  }
}

/**
 * Drive minutes from a live GPS point to an address — the "On My Way" ETA the
 * customer's tracking page shows. Same latLng-origin Routes call as the meters
 * helper, asking for duration instead. Null when the key is missing, the address
 * won't route, or the call fails — the page then shows the map without an ETA.
 */
export async function driveMinutesFromPoint(
  apiKey: string,
  origin: { lat: number; lng: number },
  destinationAddress: string
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
        origin: {
          location: {
            latLng: { latitude: origin.lat, longitude: origin.lng },
          },
        },
        destination: { address: destinationAddress },
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { routes?: { duration?: string }[] };
    const seconds = parseInt(json.routes?.[0]?.duration ?? "", 10);
    return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
  } catch {
    return null;
  }
}

/**
 * Drive minutes from many origins to ONE destination in a single
 * computeRouteMatrix call — the mirror of `driveMatrixFrom`. Returns minutes
 * per origin index; null for unroutable entries. Origins are capped at 50.
 */
export async function driveMatrixTo(
  apiKey: string,
  origins: string[],
  destination: string
): Promise<(number | null)[]> {
  const origs = origins.slice(0, 50);
  if (origs.length === 0) return [];
  try {
    const res = await fetch(MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
      },
      body: JSON.stringify({
        origins: origs.map((address) => ({ waypoint: { address } })),
        destinations: [{ waypoint: { address: destination } }],
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) return origs.map(() => null);
    const elements = (await res.json()) as {
      originIndex?: number;
      duration?: string;
      condition?: string;
    }[];
    const out: (number | null)[] = origs.map(() => null);
    for (const el of Array.isArray(elements) ? elements : []) {
      if (el.condition !== "ROUTE_EXISTS") continue;
      const idx = el.originIndex ?? -1;
      const seconds = parseInt(el.duration ?? "", 10);
      if (idx >= 0 && idx < out.length && Number.isFinite(seconds)) {
        out[idx] = Math.round(seconds / 60);
      }
    }
    return out;
  } catch {
    return origs.map(() => null);
  }
}

/**
 * Drive minutes from the CLOSEST of several technician bases to an address —
 * the honest measure of "how far away is this customer" for a business with no
 * central HQ. One Routes matrix call regardless of roster size, so this costs
 * the same as the single-origin call it replaces.
 *
 * Null when no base routes at all: the caller must treat that as "unknown",
 * never as "out of area".
 */
export async function driveMinutesFromNearestBase(
  apiKey: string,
  bases: string[],
  destination: string
): Promise<number | null> {
  const mins = (await driveMatrixTo(apiKey, bases, destination)).filter(
    (m): m is number => m != null
  );
  return mins.length > 0 ? Math.min(...mins) : null;
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
