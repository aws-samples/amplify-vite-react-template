import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIFECYCLE_POLICY_VERSION } from "./lifecycleReasons";

/**
 * GL-09 fast-follow: every lifecycle write durably records the policy version it
 * ran under, stamped inside the recorder from LIFECYCLE_POLICY_VERSION — not free
 * text a caller passes and could forget or let go stale.
 */

const created: Record<string, unknown>[] = [];
let createShouldFail = false;

const fakeDataClient = {
  models: {
    CustomerLifecycleEvent: {
      create: async (input: Record<string, unknown>) => {
        if (createShouldFail) return { data: null, errors: [{ message: "boom" }] };
        created.push({ ...input });
        return { data: input };
      },
    },
  },
};

const openOwnedWork = vi.fn(async () => "work-1");

vi.mock("./dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("./ownedWork", () => ({ openOwnedWork: (...a: unknown[]) => openOwnedWork(...a) }));

const { recordCustomerLifecycleEvent } = await import("./lifecycleLog");

const actor = { sub: "sub-1", email: "office@example.com" };

beforeEach(() => {
  created.length = 0;
  createShouldFail = false;
  openOwnedWork.mockClear();
});

describe("recordCustomerLifecycleEvent — policy version stamping", () => {
  it("stamps the current LIFECYCLE_POLICY_VERSION on a deactivation write", async () => {
    const res = await recordCustomerLifecycleEvent({
      customerId: "c1",
      action: "DEACTIVATE",
      actor,
      reason: "CUSTOMER_REQUEST",
      priorStatus: "ACTIVE",
      newStatus: "INACTIVE",
      effects: "1 plan(s) billing stopped.",
    });

    expect(res).toEqual({ recorded: true });
    expect(created).toHaveLength(1);
    // Durable, dedicated field — sourced from the constant, not the effects text.
    expect(created[0].policyVersion).toBe(LIFECYCLE_POLICY_VERSION);
  });

  it("stamps the current LIFECYCLE_POLICY_VERSION on a reactivation write", async () => {
    await recordCustomerLifecycleEvent({
      customerId: "c1",
      action: "REACTIVATE",
      actor,
      reason: "DEACTIVATED_IN_ERROR",
      priorStatus: "INACTIVE",
      newStatus: "ACTIVE",
      effects: "Portal login re-enabled.",
    });

    expect(created).toHaveLength(1);
    expect(created[0].policyVersion).toBe(LIFECYCLE_POLICY_VERSION);
  });

  it("opens LIFECYCLE_RECOVERY work when the audit write fails, without throwing", async () => {
    createShouldFail = true;

    const res = await recordCustomerLifecycleEvent({
      customerId: "c1",
      action: "DEACTIVATE",
      actor,
      reason: "NONPAYMENT",
      priorStatus: "ACTIVE",
      newStatus: "INACTIVE",
    });

    expect(res).toEqual({ recorded: false });
    expect(created).toHaveLength(0);
    expect(openOwnedWork).toHaveBeenCalledOnce();
  });
});
