import { describe, expect, it } from "vitest";
import { googleRouteUrl } from "./Today";

describe("googleRouteUrl — whole-day route for Google Maps", () => {
  it("returns null when there are no addresses", () => {
    expect(googleRouteUrl([])).toBeNull();
    expect(googleRouteUrl(["", "  "])).toBeNull();
  });

  it("routes a single stop as the destination (no waypoints)", () => {
    expect(googleRouteUrl(["12 Oak St, Boston"])).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=12%20Oak%20St%2C%20Boston&travelmode=driving"
    );
  });

  it("chains stops in order: last is the destination, the rest are waypoints", () => {
    const url = googleRouteUrl([
      "1 A St, Town",
      "2 B St, Town",
      "3 C St, Town",
    ]);
    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=3%20C%20St%2C%20Town&travelmode=driving&waypoints=1%20A%20St%2C%20Town%7C2%20B%20St%2C%20Town"
    );
  });

  it("drops blank addresses but keeps the order of the rest", () => {
    const url = googleRouteUrl(["1 A St", "", "2 B St"]);
    expect(url).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=2%20B%20St&travelmode=driving&waypoints=1%20A%20St"
    );
  });
});
