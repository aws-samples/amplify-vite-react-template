import { describe, expect, it } from "vitest";
import {
  completeJobConfirmText,
  planBilledOnCompletion,
  startBillingConfirmText,
  type BillablePlan,
} from "./billingDisclosure";

/**
 * The office "✓ Complete" button quietly does what Start-billing does loudly:
 * for a recurring job on an ACTIVE, not-yet-billing plan the server creates
 * the Stripe subscription and takes the first monthly charge today. The
 * button that moves the money must say so — in the same words as the button
 * whose whole job is moving it — and must not cry wolf when completion moves
 * nothing.
 */

const plan = (over: Partial<BillablePlan> = {}): BillablePlan => ({
  id: "p1",
  planName: "Quarterly Defense",
  priceCents: 4500,
  status: "ACTIVE",
  stripeSubscriptionId: null,
  serviceFrequency: "QUARTERLY",
  ...over,
});

const recurringJob = { type: "RECURRING", servicePlanId: "p1" };

describe("planBilledOnCompletion", () => {
  it("finds the plan when completing will start its billing", () => {
    expect(planBilledOnCompletion(recurringJob, [plan()])?.id).toBe("p1");
  });

  it("moves no money for a one-time job", () => {
    expect(
      planBilledOnCompletion({ type: "ONE_TIME", servicePlanId: null }, [plan()])
    ).toBeNull();
  });

  it("moves no money when the plan is already billing", () => {
    expect(
      planBilledOnCompletion(recurringJob, [
        plan({ stripeSubscriptionId: "sub_123" }),
      ])
    ).toBeNull();
  });

  it.each(["PAUSED", "CANCELED"])(
    "moves no money when the plan is %s",
    (status) => {
      expect(planBilledOnCompletion(recurringJob, [plan({ status })])).toBeNull();
    }
  );

  it("moves no money when the plan is not in memory", () => {
    expect(planBilledOnCompletion(recurringJob, [])).toBeNull();
  });
});

describe("completeJobConfirmText", () => {
  it("states the money before it moves — amount, cadence, and card, today", () => {
    const text = completeJobConfirmText("Maple HOA", recurringJob, [plan()]);
    expect(text).toContain("won't get a field report");
    expect(text).toContain(
      "starts billing Maple HOA $45.00 every month for Quarterly Defense"
    );
    expect(text).toContain(
      "The first charge goes to their card on file today, then monthly."
    );
  });

  it("never lets quarterly visits read as quarterly charges", () => {
    expect(completeJobConfirmText("Maple HOA", recurringJob, [plan()])).toContain(
      "A technician visits every 3 months — the charge is still monthly."
    );
  });

  it("says the same money words as the Start-billing confirm", () => {
    const p = plan();
    const complete = completeJobConfirmText("Maple HOA", recurringJob, [p]);
    const start = startBillingConfirmText("Maple HOA", p);
    expect(complete).toContain(
      `billing Maple HOA $45.00 every month for ${p.planName}`
    );
    expect(start).toContain(
      `billing Maple HOA $45.00 every month for ${p.planName}`
    );
    // The disclosure sentence is shared verbatim, not paraphrased.
    const disclosure = start.split("\n\n")[1];
    expect(complete).toContain(disclosure);
  });

  it("stays quiet about billing when completion moves no money", () => {
    const text = completeJobConfirmText("Maple HOA", recurringJob, [
      plan({ stripeSubscriptionId: "sub_123" }),
    ]);
    expect(text).toBe(
      "Mark this job completed without a tech report? The customer won't get a field report for it."
    );
  });
});

describe("startBillingConfirmText", () => {
  it("asks with the amount, the cadence, and the plan name", () => {
    expect(startBillingConfirmText("Maple HOA", plan())).toBe(
      "Start billing Maple HOA $45.00 every month for Quarterly Defense?\n\n" +
        "The first charge goes to their card on file today, then monthly. " +
        "A technician visits every 3 months — the charge is still monthly."
    );
  });

  it("omits the visit note, not a dangling space, on an unknown cadence", () => {
    expect(startBillingConfirmText("Maple HOA", plan({ serviceFrequency: null }))).toBe(
      "Start billing Maple HOA $45.00 every month for Quarterly Defense?\n\n" +
        "The first charge goes to their card on file today, then monthly."
    );
  });
});
