import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENCY, AGENCY_FMT } from "../../../shared/agency";
import { AGENCY as CRM_AGENCY } from "../lib/agency";
import * as WEB_CONSTANTS from "../../../web/src/constants";

/**
 * Tests for the repo-root shared agency module (`shared/agency.ts`).
 *
 * They live here because Vitest is configured in `crm` only, and `crm`'s
 * `include: ["src"]` is what pulls the shared module into `tsc -b`. Wave 4
 * migrated both apps onto it, so the two consumer modules are imported above
 * and their exported values — not just their source text — are checked below.
 */

const read = (relToThisFile: string) =>
  readFileSync(new URL(relToThisFile, import.meta.url), "utf8");

const CRM_AGENCY_PATH = "../lib/agency.ts";
const WEB_CONSTANTS_PATH = "../../../web/src/constants.ts";

/** `export const NAME = "value";` → { NAME: "value" } */
function parseExportedStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/export\s+const\s+(\w+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** `key: "value",` inside an object literal → { key: "value" } */
function parseObjectStrings(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^\s{2}(\w+):\s*"([^"]*)"/gm)) {
    out[m[1]] = m[2];
  }
  return out;
}

type Drift = { name: string; expected: string; found: string };

/**
 * The drift check. Given the literals a file still holds and the canonical
 * value each of those names is supposed to carry, report every mismatch.
 *
 * Only names present in BOTH maps are compared, so the check keeps working
 * after Wave 4 replaces a file's literals with a re-export: the literal map
 * empties out and there is nothing left to disagree with. The
 * "still a real check" test below is what stops that from becoming a silent
 * pass for a file that was never migrated at all.
 */
function findDrift(
  literals: Record<string, string>,
  canonical: Record<string, string>
): Drift[] {
  const drift: Drift[] = [];
  for (const [name, expected] of Object.entries(canonical)) {
    const found = literals[name];
    if (found !== undefined && found !== expected) {
      drift.push({ name, expected, found });
    }
  }
  return drift;
}

/** What each `crm/src/lib/agency.ts` object key must equal. */
const CRM_CANONICAL: Record<string, string> = {
  name: AGENCY.name,
  contactName: AGENCY.contactName,
  addressLine1: AGENCY.addressLine1,
  city: AGENCY.city,
  state: AGENCY.state,
  zip: AGENCY.zip,
  phone: AGENCY.phone,
  email: AGENCY.email,
};

/** What each `web/src/constants.ts` export must equal. */
const WEB_CANONICAL: Record<string, string> = {
  PHONE: AGENCY.phone,
  PHONE_HREF: AGENCY_FMT.phoneHref,
  EMAIL: AGENCY.email,
  EMAIL_HREF: AGENCY_FMT.emailHref,
  ADDRESS_LINE1: AGENCY.addressLine1,
  ADDRESS_LINE2: AGENCY_FMT.addressLine2,
  FORMSUBMIT_URL: AGENCY_FMT.formsubmitUrl,
};

describe("shared/agency — stored fields", () => {
  it("holds the ACORD producer block in split form", () => {
    expect(AGENCY).toEqual({
      name: "HOA Insurance Agency LLC",
      contactName: "Jake Greasley",
      addressLine1: "420 Lakeside Ave, Suite 202",
      city: "Marlborough",
      state: "MA",
      zip: "01752",
      phone: "508-233-2261",
      email: "insurance@ProtectMyHOA.com",
    });
  });

  it("stores no joined or reformatted duplicate of a split field", () => {
    // If a stored field ever contained a comma-joined address or a `tel:`/
    // `mailto:` scheme, the same fact would be living in two places again.
    for (const value of Object.values(AGENCY)) {
      expect(value).not.toMatch(/^(tel:|mailto:|https?:)/);
    }
    expect(AGENCY.city).not.toContain(",");
    expect(AGENCY.addressLine1).not.toContain(AGENCY.zip);
  });
});

describe("shared/agency — derived shapes", () => {
  it("joins the footer address line out of the split city/state/zip", () => {
    expect(AGENCY_FMT.addressLine2).toBe(
      `${AGENCY.city}, ${AGENCY.state} ${AGENCY.zip}`
    );
    expect(AGENCY_FMT.addressLine2).toContain(AGENCY.city);
    expect(AGENCY_FMT.addressLine2).toContain(AGENCY.state);
    expect(AGENCY_FMT.addressLine2).toContain(AGENCY.zip);
  });

  it("derives both phone formats from the one stored phone", () => {
    const digits = AGENCY.phone.replace(/\D/g, "");
    expect(digits).toHaveLength(10);
    expect(AGENCY_FMT.phoneHref).toBe(`tel:+1${digits}`);
    expect(AGENCY_FMT.phoneHref).not.toMatch(/[-.() ]/);
    expect(AGENCY_FMT.phoneIntl).toBe(`+1-${AGENCY.phone}`);
    // Both machine formats must carry the same digits as the display form.
    expect(AGENCY_FMT.phoneHref.replace(/\D/g, "")).toBe(`1${digits}`);
    expect(AGENCY_FMT.phoneIntl.replace(/\D/g, "")).toBe(`1${digits}`);
  });

  it("derives every email shape from the one stored address", () => {
    expect(AGENCY_FMT.emailHref).toBe(`mailto:${AGENCY.email}`);
    expect(AGENCY_FMT.emailLower).toBe(AGENCY.email.toLowerCase());
    expect(AGENCY_FMT.formsubmitUrl).toBe(
      `https://formsubmit.co/ajax/${AGENCY_FMT.emailLower}`
    );
    // The two spellings differ only by case — they are one address, not two.
    expect(AGENCY_FMT.emailLower).not.toBe(AGENCY.email);
    expect(AGENCY_FMT.emailLower.toLowerCase()).toBe(AGENCY.email.toLowerCase());
  });

  it("keeps mixed case canonical and lowercase strictly a transport form", () => {
    expect(AGENCY.email).toBe("insurance@ProtectMyHOA.com");
    expect(AGENCY_FMT.emailHref).toContain("ProtectMyHOA");
    expect(AGENCY_FMT.formsubmitUrl).not.toContain("ProtectMyHOA");
    expect(AGENCY_FMT.formsubmitUrl).toBe(
      AGENCY_FMT.formsubmitUrl.toLowerCase()
    );
  });

  it("reproduces byte-for-byte what the two apps render today", () => {
    // Regression lock: this primitive must not change any rendered output.
    // Every string here is copied from the file it currently ships in.
    expect(AGENCY_FMT.addressLine2).toBe("Marlborough, MA 01752"); // constants.ts
    expect(AGENCY_FMT.phoneHref).toBe("tel:+15082332261"); // constants.ts
    expect(AGENCY_FMT.emailHref).toBe("mailto:insurance@ProtectMyHOA.com");
    expect(AGENCY_FMT.formsubmitUrl).toBe(
      "https://formsubmit.co/ajax/insurance@protectmyhoa.com"
    );
    expect(AGENCY_FMT.emailLower).toBe("insurance@protectmyhoa.com"); // QuoteApp SUBMIT_TO
    expect(AGENCY_FMT.phoneIntl).toBe("+1-508-233-2261"); // Layout.astro JSON-LD
  });
});

describe("shared/agency — drift check against the consumer files", () => {
  it("agrees with every literal still in crm/src/lib/agency.ts", () => {
    // Source-text half: nothing may be hand-typed back in and diverge.
    const literals = parseObjectStrings(read(CRM_AGENCY_PATH));
    expect(findDrift(literals, CRM_CANONICAL)).toEqual([]);
    // Value half: the module's real export, whatever route it took to get
    // there. Post-migration this is what carries the weight — the literal map
    // above is empty, so on its own it would prove nothing.
    expect(Object.keys(CRM_AGENCY).sort()).toEqual(
      Object.keys(CRM_CANONICAL).sort()
    );
    for (const [name, expected] of Object.entries(CRM_CANONICAL)) {
      expect(CRM_AGENCY[name as keyof typeof CRM_AGENCY]).toBe(expected);
    }
  });

  it("agrees with every literal still in web/src/constants.ts", () => {
    const literals = parseExportedStrings(read(WEB_CONSTANTS_PATH));
    expect(findDrift(literals, WEB_CANONICAL)).toEqual([]);
    // Same two halves as above: the seven agency-derived exports must hold the
    // canonical value at runtime, not merely fail to contradict it in source.
    for (const [name, expected] of Object.entries(WEB_CANONICAL)) {
      expect(WEB_CONSTANTS).toHaveProperty(name);
      expect(WEB_CONSTANTS[name as keyof typeof WEB_CONSTANTS]).toBe(expected);
    }
  });

  it("is still a real check — each file holds the literals or imports shared", () => {
    // Guards the graceful-degradation path above. A file may stop holding
    // literals only by starting to import the shared module; it may not
    // simply lose them and leave this suite passing on an empty comparison.
    const cases: Array<[string, Record<string, string>, Record<string, string>]> = [
      [CRM_AGENCY_PATH, parseObjectStrings(read(CRM_AGENCY_PATH)), CRM_CANONICAL],
      [
        WEB_CONSTANTS_PATH,
        parseExportedStrings(read(WEB_CONSTANTS_PATH)),
        WEB_CANONICAL,
      ],
    ];
    for (const [path, literals, canonical] of cases) {
      const text = read(path);
      const covered = Object.keys(canonical).filter((n) => n in literals);
      const importsShared = /from\s+"[^"]*shared\/agency"/.test(text);
      expect(
        covered.length === Object.keys(canonical).length || importsShared,
        `${path}: neither holds all its literals nor imports shared/agency`
      ).toBe(true);
    }
  });

  it("reports drift when a file diverges", () => {
    // Proof the check has teeth, run against fixtures rather than the real
    // files so nothing on disk has to be mutated.
    const divergedWeb = `
export const PHONE = "508-233-9999";
export const EMAIL = "insurance@protectmyhoa.com";
export const ADDRESS_LINE2 = "Marlboro, MA 01752";
`;
    expect(
      findDrift(parseExportedStrings(divergedWeb), WEB_CANONICAL)
    ).toEqual([
      { name: "PHONE", expected: "508-233-2261", found: "508-233-9999" },
      {
        name: "EMAIL",
        expected: "insurance@ProtectMyHOA.com",
        found: "insurance@protectmyhoa.com",
      },
      {
        name: "ADDRESS_LINE2",
        expected: "Marlborough, MA 01752",
        found: "Marlboro, MA 01752",
      },
    ]);

    const divergedCrm = `export const AGENCY = {\n  city: "Marlboro",\n  zip: "01752",\n};`;
    expect(findDrift(parseObjectStrings(divergedCrm), CRM_CANONICAL)).toEqual([
      { name: "city", expected: "Marlborough", found: "Marlboro" },
    ]);
  });

  it("catches a case-only divergence, which plain equality of intent would miss", () => {
    const caseOnly = `export const EMAIL = "Insurance@ProtectMyHOA.Com";`;
    expect(findDrift(parseExportedStrings(caseOnly), WEB_CANONICAL)).toEqual([
      {
        name: "EMAIL",
        expected: "insurance@ProtectMyHOA.com",
        found: "Insurance@ProtectMyHOA.Com",
      },
    ]);
  });
});
