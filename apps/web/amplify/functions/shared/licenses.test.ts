import { describe, expect, it } from "vitest";
import { licenseFactsFromRecords, licenseValidOnDate } from "./licenses";

/**
 * GL-17 — one-to-many licence records decide currency; the legacy single
 * fields only matter for a technician with zero records; and historical
 * authorship resolves the record valid ON the application date.
 */

const TECH = {
  id: "t1",
  licenseNumber: "LEGACY-1",
  licenseExpiresOn: "2027-01-01",
};

describe("licence records (GL-17)", () => {
  it("falls back to the legacy fields only when a technician has NO records", () => {
    const legacy = licenseFactsFromRecords([], TECH, "2026-07-19");
    expect(legacy.current).toBe(true);
    expect(legacy.number).toBe("LEGACY-1");
    expect(legacy.source).toBe("LEGACY");
  });

  it("records win over legacy fields the moment any record exists", () => {
    // A single EXPIRED record: even though the legacy fields read current, the
    // records are the authority — Compliance controls them.
    const facts = licenseFactsFromRecords(
      [{ number: "R-1", status: "EXPIRED", expiresOn: "2026-01-01" }],
      TECH,
      "2026-07-19"
    );
    expect(facts.current).toBe(false);
    expect(facts.source).toBe("RECORDS");
  });

  it("a CURRENT unexpired record makes the technician dispatchable", () => {
    const facts = licenseFactsFromRecords(
      [
        { number: "OLD", status: "EXPIRED", expiresOn: "2025-12-31" },
        { number: "NEW", status: "CURRENT", expiresOn: "2027-06-30" },
      ],
      TECH,
      "2026-07-19"
    );
    expect(facts.current).toBe(true);
    expect(facts.number).toBe("NEW");
  });

  it("a CURRENT record that has passed its expiration is NOT current on that date", () => {
    const facts = licenseFactsFromRecords(
      [{ number: "N", status: "CURRENT", expiresOn: "2026-07-01" }],
      TECH,
      "2026-07-19"
    );
    expect(facts.current).toBe(false);
  });

  it("currency is judged against the WORK date — an expiry between today and the visit removes it", () => {
    const records = [{ number: "N", status: "CURRENT", expiresOn: "2026-08-01" }];
    expect(licenseFactsFromRecords(records, TECH, "2026-07-19").current).toBe(true);
    expect(licenseFactsFromRecords(records, TECH, "2026-08-15").current).toBe(false);
  });

  it("PENDING and REVOKED records never grant currency", () => {
    expect(
      licenseFactsFromRecords(
        [{ number: "P", status: "PENDING", expiresOn: "2099-01-01" }],
        TECH,
        "2026-07-19"
      ).current
    ).toBe(false);
    expect(
      licenseFactsFromRecords(
        [{ number: "R", status: "REVOKED", expiresOn: "2099-01-01" }],
        TECH,
        "2026-07-19"
      ).current
    ).toBe(false);
  });

  it("historical authorship resolves the record valid ON the application date — a later expiry never rewrites it", () => {
    const records = [
      { number: "OLD-LICENSE", status: "EXPIRED", expiresOn: "2026-06-30" },
      { number: "NEW-LICENSE", status: "CURRENT", expiresOn: "2027-06-30" },
    ];
    // Application happened in May 2026, under the old licence.
    expect(licenseValidOnDate(records, TECH, "2026-05-10").number).toBe(
      "NEW-LICENSE"
    );
    // Wait — both were valid in May; the longest-lasting wins. On a date only
    // the old one covered:
    expect(
      licenseValidOnDate(
        [{ number: "OLD-LICENSE", status: "EXPIRED", expiresOn: "2026-06-30" }],
        TECH,
        "2026-05-10"
      ).number
    ).toBe("OLD-LICENSE");
    // A REVOKED record validates nothing, even historically.
    expect(
      licenseValidOnDate(
        [{ number: "BAD", status: "REVOKED", expiresOn: "2099-01-01" }],
        { id: "t1", licenseNumber: null, licenseExpiresOn: null },
        "2026-05-10"
      ).number
    ).toBeNull();
  });
});
