import { describe, expect, it } from "vitest";
import {
  buildLifecycleCsv,
  businessDateEndUtcMs,
  businessDateStartUtcMs,
  type LifecycleEventRow,
} from "./Command";

/**
 * GL-09 — the complete lifecycle-history export's pure assembly: the exact
 * field set leadership was promised, inclusive date filtering, oldest-first
 * ordering, and RFC-4180 escaping so a reason containing commas, quotes, or
 * newlines cannot corrupt the record.
 */

const row = (over: Partial<LifecycleEventRow>): LifecycleEventRow => ({
  id: "ev-1",
  customerId: "c1",
  action: "DEACTIVATE",
  actorEmail: "office@pestbuzzkill.com",
  occurredAt: "2026-07-10T12:00:00.000Z",
  ...over,
});

const customers = [{ id: "c1", displayName: "Maple Ridge" }];

describe("buildLifecycleCsv", () => {
  it("exports every promised field in a stable header", () => {
    const { csv, count } = buildLifecycleCsv(
      [
        row({
          reason: "moved away",
          actorSub: "sub-1",
          priorStatus: "ACTIVE",
          newStatus: "INACTIVE",
          effects: "plan canceled; 2 visits refunded",
          policyVersion: "2026-07-19.1",
        }),
      ],
      customers,
      "",
      ""
    );

    const [header, line] = csv.split("\r\n");
    expect(header).toBe(
      "occurredAt,customerId,customerName,action,reason,actorEmail,actorSub,priorStatus,newStatus,result,policyVersion"
    );
    expect(line).toBe(
      "2026-07-10T12:00:00.000Z,c1,Maple Ridge,DEACTIVATE,moved away,office@pestbuzzkill.com,sub-1,ACTIVE,INACTIVE,plan canceled; 2 visits refunded,2026-07-19.1"
    );
    expect(count).toBe(1);
  });

  it("escapes commas, quotes, and newlines RFC-4180 style", () => {
    const { csv } = buildLifecycleCsv(
      [row({ reason: 'said "no, thanks"\nvia phone' })],
      customers,
      "",
      ""
    );
    expect(csv).toContain('"said ""no, thanks""\nvia phone"');
  });

  it("filters to the inclusive date range and sorts oldest-first", () => {
    const rows = [
      row({ id: "late", occurredAt: "2026-07-15T09:00:00.000Z" }),
      row({ id: "early", occurredAt: "2026-07-05T09:00:00.000Z" }),
      row({ id: "out", occurredAt: "2026-08-01T09:00:00.000Z" }),
    ];
    const { csv, count } = buildLifecycleCsv(rows, customers, "2026-07-01", "2026-07-31");

    expect(count).toBe(2);
    const lines = csv.split("\r\n").slice(1);
    expect(lines[0]).toContain("2026-07-05");
    expect(lines[1]).toContain("2026-07-15");
    expect(csv).not.toContain("2026-08-01");
  });

  it("an unknown customer id exports with an empty name, never a crash", () => {
    const { csv } = buildLifecycleCsv([row({ customerId: "ghost" })], customers, "", "");
    expect(csv.split("\r\n")[1]).toContain(",ghost,,DEACTIVATE,");
  });
});

describe("GL-09 corrective — From/To are Eastern BUSINESS dates, DST included", () => {
  it("summer boundary: an event late on July 9 Eastern is excluded from a July 10 export", () => {
    const rows = [
      // 23:59 EDT on July 9 — UTC already says July 10.
      row({ id: "late-jul9", occurredAt: "2026-07-10T03:59:00.000Z" }),
      // 00:00 EDT on July 10 exactly.
      row({ id: "midnight-jul10", occurredAt: "2026-07-10T04:00:00.000Z" }),
    ];
    const { csv, count } = buildLifecycleCsv(rows, customers, "2026-07-10", "2026-07-10");
    expect(count).toBe(1);
    expect(csv).toContain("midnight-jul10".slice(0, 0) + "2026-07-10T04:00:00.000Z");
    expect(csv).not.toContain("2026-07-10T03:59:00.000Z");
  });

  it("inclusive To: the whole Eastern day is kept, through 23:59:59 EDT", () => {
    const rows = [
      // 23:30 EDT July 10 = 03:30 UTC July 11 — a naive UTC filter drops it.
      row({ id: "evening", occurredAt: "2026-07-11T03:30:00.000Z" }),
      // 00:00 EDT July 11 — the first instant OUTSIDE the range.
      row({ id: "next-day", occurredAt: "2026-07-11T04:00:00.000Z" }),
    ];
    const { count, csv } = buildLifecycleCsv(rows, customers, "2026-07-10", "2026-07-10");
    expect(count).toBe(1);
    expect(csv).toContain("2026-07-11T03:30:00.000Z");
  });

  it("DST fall-back (Nov 1, 2026): the 25-hour business day is honored end to end", () => {
    // EDT ends 2026-11-01 02:00 ET; the business day runs 04:00Z Nov 1 →
    // 05:00Z Nov 2.
    expect(businessDateStartUtcMs("2026-11-01")).toBe(Date.parse("2026-11-01T04:00:00Z"));
    expect(businessDateEndUtcMs("2026-11-01")).toBe(Date.parse("2026-11-02T05:00:00Z"));
    const rows = [
      row({ id: "est-evening", occurredAt: "2026-11-02T04:30:00.000Z" }), // 23:30 EST Nov 1
      row({ id: "nov2", occurredAt: "2026-11-02T05:00:00.000Z" }), // 00:00 EST Nov 2
    ];
    const { count, csv } = buildLifecycleCsv(rows, customers, "2026-11-01", "2026-11-01");
    expect(count).toBe(1);
    expect(csv).toContain("2026-11-02T04:30:00.000Z");
    expect(csv).not.toContain("2026-11-02T05:00:00.000Z");
  });

  it("DST spring-forward (Mar 8, 2026): the 23-hour day starts EST and ends EDT", () => {
    expect(businessDateStartUtcMs("2026-03-08")).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(businessDateEndUtcMs("2026-03-08")).toBe(Date.parse("2026-03-09T04:00:00Z"));
  });

  it("an unparsable timestamp is excluded from a dated export, never randomly placed", () => {
    const rows = [row({ id: "junk", occurredAt: "not-a-date" })];
    expect(buildLifecycleCsv(rows, customers, "2026-07-01", "2026-07-31").count).toBe(0);
    // With no range there is no boundary to misplace it against — still exported.
    expect(buildLifecycleCsv(rows, customers, "", "").count).toBe(1);
  });
});

describe("GL-09 corrective — spreadsheet formula injection is neutralized", () => {
  it.each([
    ["=HYPERLINK(\"http://evil\",\"click\")", "a formula"],
    ["+1-555-0100", "a plus-leading value"],
    ["-2+3+cmd", "a minus-leading value"],
    ["@SUM(A1:A9)", "an at-leading value"],
    ["\t=1+1", "a tab-leading value"],
    [" =1+1", "a space-then-equals value"],
  ])("prefixes %s with an apostrophe", (payload) => {
    const { csv } = buildLifecycleCsv([row({ reason: payload })], customers, "", "");
    const line = csv.split("\r\n")[1];
    // The neutralized field is the apostrophe + the original content,
    // then RFC-4180-escaped exactly like any other field.
    const rfc = (v: string) =>
      /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    expect(line).toContain(rfc(`'${payload}`));
  });

  it("a malicious CUSTOMER NAME cannot execute in the customerName column", () => {
    const evil = [{ id: "c1", displayName: "=cmd|' /C calc'!A0" }];
    const { csv } = buildLifecycleCsv([row({})], evil, "", "");
    const line = csv.split("\r\n")[1];
    // Neutralized in place — single quotes are not RFC-special, so the
    // field is simply the apostrophe-prefixed original.
    expect(line).toContain(",'=cmd|' /C calc'!A0,");
  });

  it("ordinary content is untouched — readable text stays byte-identical", () => {
    const { csv } = buildLifecycleCsv(
      [row({ reason: 'said "no, thanks"\nvia phone' })],
      customers,
      "",
      ""
    );
    expect(csv).toContain('"said ""no, thanks""\nvia phone"');
    expect(csv).not.toContain("'said");
  });
});
