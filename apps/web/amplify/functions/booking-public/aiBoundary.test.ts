import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * booking-public is a PUBLIC, unauthenticated Function URL. The Anthropic key
 * must never live on it: backend.ts states the funnel is "a pure rate READER
 * ... has no business holding the research key", and a paid AI call reachable
 * without authentication is also a standing invitation to burn spend.
 *
 * "Tell us what you need" therefore sends its text INWARD over an IAM invoke to
 * crm-pricing, which already holds the key, and only the structured answer
 * comes back. These are source-level assertions on purpose — the boundary is
 * about what the public bundle CONTAINS, which no runtime test would catch.
 */

const read = (p: string) => readFileSync(join(__dirname, p), "utf8");

describe("the public funnel never holds the AI research key", () => {
  const publicHandler = read("./handler.ts");

  it("does not import the Anthropic SDK", () => {
    expect(publicHandler).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
  });

  it("never reads ANTHROPIC_API_KEY", () => {
    expect(publicHandler).not.toContain("ANTHROPIC_API_KEY");
  });

  it("reaches extraction by invoking another function instead", () => {
    expect(publicHandler).toContain("CRM_PRICING_FUNCTION_NAME");
    expect(publicHandler).toContain("extractQuoteIntent");
  });

  it("gates the paid extraction behind the bot check AND the per-IP throttle", () => {
    // The endpoint's general gate runs past validation, which is too late for
    // an AI call — so the describe path carries its own, before extracting.
    const block = publicHandler.slice(
      publicHandler.indexOf("if (!resume && (input.describe"),
      publicHandler.indexOf("const described = await inputFromDescription")
    );
    expect(block).toContain("verifyBotToken");
    expect(block).toContain("throttleOk");
  });
});

describe("crm-pricing is where the key legitimately lives", () => {
  const pricingHandler = read("../crm-pricing/handler.ts");

  it("holds the Anthropic client and the key", () => {
    expect(pricingHandler).toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    expect(pricingHandler).toContain("ANTHROPIC_API_KEY");
  });

  it("serves the internal extraction op, and only by direct invoke", () => {
    expect(pricingHandler).toContain("extractQuoteIntent");
    // The internal branch must come BEFORE the office check — a direct invoke
    // carries no AppSync identity and could never satisfy it. Both needles are
    // asserted present first: a renamed gate would otherwise read as index -1
    // and quietly pass the ordering check.
    const internalAt = pricingHandler.indexOf(
      'internal?.op === "extractQuoteIntent"'
    );
    const gateAt = pricingHandler.indexOf("assertOffice(event.identity)");
    expect(internalAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(internalAt).toBeLessThan(gateAt);
  });
});
