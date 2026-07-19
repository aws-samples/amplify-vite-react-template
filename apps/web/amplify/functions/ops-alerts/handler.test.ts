import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-22 — the alarm-to-owned-work bridge. An ALARM state change becomes ONE
 * deduplicated shared-Office INFRA_ALERT item plus an office email; OK
 * auto-resolves it; a processing failure THROWS so the delivery retries and
 * dead-letters visibly instead of being silently acknowledged.
 */

const workOpened: Record<string, unknown>[] = [];
const workResolved: Record<string, unknown>[] = [];
let openFails = false;
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async (o: Record<string, unknown>) => {
    if (openFails) throw new Error("dynamo down");
    workOpened.push(o);
    return "w1";
  },
  resolveOwnedWork: async (o: Record<string, unknown>) => {
    workResolved.push(o);
    return true;
  },
}));
const officeEmails: { subject: string }[] = [];
vi.mock("../shared/email", () => ({
  notifyOffice: async (o: { subject: string }) => {
    officeEmails.push(o);
    return true;
  },
}));

const { handler } = await import("./handler");

const snsEvent = (message: Record<string, unknown>) =>
  ({
    Records: [{ Sns: { Message: JSON.stringify(message), MessageId: "m1" } }],
  }) as never;

beforeEach(() => {
  workOpened.length = 0;
  workResolved.length = 0;
  officeEmails.length = 0;
  openFails = false;
});

describe("ops-alerts", () => {
  it("an ALARM becomes one deduplicated owned item and an office email", async () => {
    await handler(
      snsEvent({
        AlarmName: "buzzkill-staging-stripe-webhook-errors",
        AlarmDescription: "The stripe-webhook function is failing.",
        NewStateValue: "ALARM",
        NewStateReason: "1 error in 5 minutes",
      })
    );

    expect(workOpened).toHaveLength(1);
    expect(workOpened[0]).toMatchObject({
      kind: "INFRA_ALERT",
      dedupeKey: "alarm:buzzkill-staging-stripe-webhook-errors",
    });
    expect(String(workOpened[0].detail)).toContain("1 error in 5 minutes");
    expect(officeEmails[0].subject).toContain("INFRA ALERT");
  });

  it("OK auto-resolves the same item — the queue never shows a recovered ghost", async () => {
    await handler(
      snsEvent({
        AlarmName: "buzzkill-staging-stripe-webhook-errors",
        NewStateValue: "OK",
        NewStateReason: "back under threshold",
      })
    );

    expect(workResolved).toHaveLength(1);
    expect(workResolved[0]).toMatchObject({
      kind: "INFRA_ALERT",
      dedupeKey: "alarm:buzzkill-staging-stripe-webhook-errors",
    });
    expect(workOpened).toHaveLength(0);
  });

  it("a failed alert-processing run THROWS — never a silent acknowledgment", async () => {
    openFails = true;
    await expect(
      handler(
        snsEvent({ AlarmName: "x", NewStateValue: "ALARM", NewStateReason: "r" })
      )
    ).rejects.toThrow(/alarm record\(s\) failed/);
  });
});
