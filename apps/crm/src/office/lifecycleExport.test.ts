import { describe, expect, it } from "vitest";
import { buildLifecycleCsv, type LifecycleEventRow } from "./Command";

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
