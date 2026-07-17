import { describe, expect, it } from "vitest";
import {
  bookingFunnelSpoken,
  bookingFunnelUrl,
  marketingSiteUrl,
} from "./bookingLink";

/**
 * The booking funnel is the lead's only road to becoming a customer, so the
 * URL the CRM shows (and a CSR reads aloud) must match the environment: the
 * production CRM must never hand out a staging link, and staging must never
 * point a test lead at the real checkout.
 */

const PROD_CRM = "main.d5ln2hbbp9s2j.amplifyapp.com";
const STAGING_CRM = "staging.d5ln2hbbp9s2j.amplifyapp.com";

describe("marketingSiteUrl", () => {
  it("maps the production CRM host to the production marketing site", () => {
    expect(marketingSiteUrl(PROD_CRM)).toBe("https://www.pestbuzzkill.com");
  });

  it("maps the staging CRM host to the staging marketing site", () => {
    expect(marketingSiteUrl(STAGING_CRM)).toBe(
      "https://staging.d26qpsjewk0bee.amplifyapp.com"
    );
  });

  it("treats localhost as staging — dev must never point at real checkout", () => {
    expect(marketingSiteUrl("localhost")).toBe(
      "https://staging.d26qpsjewk0bee.amplifyapp.com"
    );
  });
});

describe("bookingFunnelUrl", () => {
  it("is the marketing site's /quote page", () => {
    expect(bookingFunnelUrl(PROD_CRM)).toBe(
      "https://www.pestbuzzkill.com/quote"
    );
    expect(bookingFunnelUrl(STAGING_CRM)).toBe(
      "https://staging.d26qpsjewk0bee.amplifyapp.com/quote"
    );
  });
});

describe("bookingFunnelSpoken", () => {
  it("drops the protocol and www so it reads aloud as typed", () => {
    expect(bookingFunnelSpoken(PROD_CRM)).toBe("pestbuzzkill.com/quote");
  });

  it("keeps the staging host intact apart from the protocol", () => {
    expect(bookingFunnelSpoken(STAGING_CRM)).toBe(
      "staging.d26qpsjewk0bee.amplifyapp.com/quote"
    );
  });
});
