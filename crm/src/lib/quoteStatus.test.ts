import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_QUOTE_STATUSES,
  CLOSED_QUOTE_STATUSES,
  OPEN_QUOTE_STATUSES,
  SELECTABLE_QUOTE_STATUSES,
  isClosedQuoteStatus,
  isOpenQuoteStatus,
  isQuoteStatus,
  isSelectableQuoteStatus,
  openQuoteStatusFilter,
  quoteStatusFilter,
  type QuoteStatus,
} from "./quoteStatus";

/**
 * The compile-time exhaustiveness guard in quoteStatus.ts only bites while
 * `QuoteStatus` is a union of literals. If a schema or codegen change ever
 * widened it to `string`, `satisfies Record<QuoteStatus, …>` would accept
 * anything and the guard would go quiet without a single error. This asserts
 * the guard is still live.
 */
type QuoteStatusIsNotWidenedToString = [string] extends [QuoteStatus]
  ? never
  : true;

/**
 * The enum members as written in the schema, read from source rather than
 * imported: amplify/data/resource.ts pulls in @aws-amplify/backend at
 * runtime, and this module deliberately imports only its *type*.
 */
function quoteStatusEnumFromSchema(): string[] {
  // cwd is the crm/ package root under `vitest run`; import.meta.url is an
  // http:// URL there, so it can't be resolved with fs.
  const src = readFileSync(resolve(process.cwd(), "amplify/data/resource.ts"), "utf8");
  const block = /QuoteStatus:\s*a\.enum\(\[([^\]]*)\]\)/.exec(src);
  if (!block) throw new Error("QuoteStatus enum not found in resource.ts");
  return [...block[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

describe("QuoteStatus type", () => {
  it("is still a literal union, so the tsc guard is live", () => {
    const live: QuoteStatusIsNotWidenedToString = true;
    expect(live).toBe(true);
  });
});

describe("ALL_QUOTE_STATUSES", () => {
  it("matches the schema enum exactly, in schema order", () => {
    expect([...ALL_QUOTE_STATUSES]).toEqual(quoteStatusEnumFromSchema());
  });

  it("is the seven statuses the schema declares today", () => {
    expect([...ALL_QUOTE_STATUSES]).toEqual([
      "DRAFT",
      "SUBMITTED",
      "QUOTED",
      "PRESENTED",
      "BOUND",
      "DECLINED",
      "LOST",
    ]);
  });
});

describe("OPEN_QUOTE_STATUSES", () => {
  it("is exactly the four open statuses, in schema order", () => {
    expect([...OPEN_QUOTE_STATUSES]).toEqual([
      "DRAFT",
      "SUBMITTED",
      "QUOTED",
      "PRESENTED",
    ]);
  });

  it("is a subset of the full enum", () => {
    for (const s of OPEN_QUOTE_STATUSES) {
      expect(ALL_QUOTE_STATUSES).toContain(s);
    }
  });

  it("excludes every terminal status", () => {
    for (const s of ["BOUND", "DECLINED", "LOST"]) {
      expect(OPEN_QUOTE_STATUSES as readonly string[]).not.toContain(s);
    }
  });

  it("is frozen, so a consumer cannot mutate the shared list", () => {
    expect(Object.isFrozen(OPEN_QUOTE_STATUSES)).toBe(true);
  });
});

describe("classification is total", () => {
  it("classifies every enum member as open or closed", () => {
    const seen = [...OPEN_QUOTE_STATUSES, ...CLOSED_QUOTE_STATUSES].sort();
    expect(seen).toEqual([...ALL_QUOTE_STATUSES].sort());
  });

  it("classifies no status as both", () => {
    for (const s of ALL_QUOTE_STATUSES) {
      expect(isOpenQuoteStatus(s)).toBe(!isClosedQuoteStatus(s));
    }
  });

  it("leaves nothing unaccounted for", () => {
    expect(OPEN_QUOTE_STATUSES.length + CLOSED_QUOTE_STATUSES.length).toBe(
      ALL_QUOTE_STATUSES.length
    );
  });

  it("counts BOUND as closed, not open", () => {
    expect(isClosedQuoteStatus("BOUND")).toBe(true);
    expect(isOpenQuoteStatus("BOUND")).toBe(false);
  });
});

describe("SELECTABLE_QUOTE_STATUSES", () => {
  it("is the full enum minus BOUND", () => {
    expect([...SELECTABLE_QUOTE_STATUSES]).toEqual(
      [...ALL_QUOTE_STATUSES].filter((s) => s !== "BOUND")
    );
  });

  it("is a strict superset of the open statuses", () => {
    for (const s of OPEN_QUOTE_STATUSES) {
      expect(SELECTABLE_QUOTE_STATUSES as readonly string[]).toContain(s);
    }
    expect(SELECTABLE_QUOTE_STATUSES.length).toBeGreaterThan(
      OPEN_QUOTE_STATUSES.length
    );
  });

  it("reproduces the two hand-written superset copies", () => {
    // The two lists this replaced: CoverageForm's `QUOTE_STATUSES` and
    // QuotesPanel's `[...OPEN_STATUSES, "DECLINED", "LOST"]` — same set,
    // either order. Kept as a regression lock on the migrated values.
    const coverageForm = [
      "DRAFT",
      "SUBMITTED",
      "QUOTED",
      "PRESENTED",
      "DECLINED",
      "LOST",
    ];
    expect([...SELECTABLE_QUOTE_STATUSES].sort()).toEqual(
      [...coverageForm].sort()
    );
    expect([...SELECTABLE_QUOTE_STATUSES].sort()).toEqual(
      [...OPEN_QUOTE_STATUSES, "DECLINED", "LOST"].sort()
    );
  });
});

describe("status predicates", () => {
  it("rejects non-statuses and nullish input", () => {
    for (const bad of ["", "OPEN", "draft", "ACTIVE", null, undefined]) {
      expect(isQuoteStatus(bad)).toBe(false);
      expect(isOpenQuoteStatus(bad)).toBe(false);
      expect(isClosedQuoteStatus(bad)).toBe(false);
      expect(isSelectableQuoteStatus(bad)).toBe(false);
    }
  });

  it("is not fooled by inherited Object properties", () => {
    expect(isQuoteStatus("toString")).toBe(false);
    expect(isQuoteStatus("constructor")).toBe(false);
  });

  it("accepts every schema status", () => {
    for (const s of ALL_QUOTE_STATUSES) expect(isQuoteStatus(s)).toBe(true);
  });
});

describe("openQuoteStatusFilter", () => {
  it("reproduces the Dashboard.tsx or:-filter verbatim", () => {
    expect(openQuoteStatusFilter()).toEqual({
      or: [
        { status: { eq: "DRAFT" } },
        { status: { eq: "SUBMITTED" } },
        { status: { eq: "QUOTED" } },
        { status: { eq: "PRESENTED" } },
      ],
    });
  });

  it("has one clause per open status and no others", () => {
    const { or } = openQuoteStatusFilter();
    expect(or.map((c) => c.status.eq)).toEqual([...OPEN_QUOTE_STATUSES]);
  });

  it("returns a fresh, mutable object each call", () => {
    const a = openQuoteStatusFilter();
    const b = openQuoteStatusFilter();
    expect(a).not.toBe(b);
    expect(a.or).not.toBe(b.or);
    expect(Object.isFrozen(a.or)).toBe(false);
  });

  it("builds a filter for any status set", () => {
    expect(quoteStatusFilter(["BOUND"])).toEqual({
      or: [{ status: { eq: "BOUND" } }],
    });
    expect(quoteStatusFilter([]).or).toEqual([]);
  });
});
