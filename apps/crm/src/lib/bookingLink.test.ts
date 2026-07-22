import { describe, expect, it } from "vitest";
import {
  bookingFunnelSpoken,
  bookingFunnelUrl,
  isStagingCrm,
  marketingSiteUrl,
} from "./bookingLink";

/**
 * The booking funnel is the lead's only road to becoming a customer, so the
 * URL the CRM shows (and a CSR reads aloud) must match the environment: the
 * production CRM must never hand out a staging link, and staging must never
 * point a test lead at the real checkout.
 */

const PROD_CRM = "app.pestbuzzkill.com";
const LEGACY_PROD_CRM = "main.d5ln2hbbp9s2j.amplifyapp.com";
const STAGING_CRM = "staging.d5ln2hbbp9s2j.amplifyapp.com";

describe("marketingSiteUrl", () => {
  it("maps the production CRM host to the production marketing site", () => {
    expect(marketingSiteUrl(PROD_CRM)).toBe("https://www.pestbuzzkill.com");
  });

  it("keeps the direct production Amplify host in production", () => {
    expect(marketingSiteUrl(LEGACY_PROD_CRM)).toBe(
      "https://www.pestbuzzkill.com"
    );
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

describe("isStagingCrm — the wipe gate, which must fail CLOSED", () => {
  it("is true on the known staging CRM host", () => {
    expect(isStagingCrm(STAGING_CRM)).toBe(true);
  });

  it("is true for local dev so the wipe is testable locally", () => {
    expect(isStagingCrm("localhost")).toBe(true);
    expect(isStagingCrm("127.0.0.1")).toBe(true);
  });

  it("is true for any staging.* host so a future staging domain still counts", () => {
    expect(isStagingCrm("staging.pestbuzzkill.com")).toBe(true);
  });

  it("is FALSE on production — the wipe must never be one tap away in prod", () => {
    expect(isStagingCrm(PROD_CRM)).toBe(false);
    expect(isStagingCrm(LEGACY_PROD_CRM)).toBe(false);
  });

  it("is FALSE for any unrecognized host — fails closed on drift", () => {
    expect(isStagingCrm("app.some-new-domain.com")).toBe(false);
    expect(isStagingCrm("")).toBe(false);
    expect(isStagingCrm("192.0.2.10")).toBe(false);
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
