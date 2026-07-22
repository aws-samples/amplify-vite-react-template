import { describe, expect, it } from "vitest";
import {
  confirmationEmailBodyHtml,
  finalChargeDescription,
  pendingCancelMessage,
  planCanceledSuccessMessage,
  visitOutcomeSentence,
  type VisitResolutionSummary,
} from "./planCancellationPolicy";

/**
 * GL-08 R3/R5 — the plan-cancellation copy is pure and derived from the actual
 * resolution, so the preview, pending, success, and email surfaces can never
 * drift from each other or from what really happened.
 */

const summary = (over: Partial<VisitResolutionSummary> = {}): VisitResolutionSummary => ({
  stopped: 0,
  failed: 0,
  failedDates: [],
  refundsOwed: [],
  retained: [],
  pendingDecisions: 0,
  ...over,
});

describe("visitOutcomeSentence", () => {
  it("says visits stopped only when nothing failed to come off", () => {
    expect(visitOutcomeSentence({ failed: 0 })).toMatch(/have stopped\./i);
    expect(visitOutcomeSentence({ failed: 0 })).not.toMatch(/still need/i);
  });
  it("never claims all stopped while a removal failed", () => {
    const s = visitOutcomeSentence({ failed: 2 });
    expect(s).not.toMatch(/^Your recurring visits have stopped\.$/);
    expect(s).toMatch(/2 still need our team/i);
  });
});

describe("planCanceledSuccessMessage", () => {
  it("clean cancel: stopped, no remainder, and the email line only when sent", () => {
    const msg = planCanceledSuccessMessage(summary(), {
      confirmationEmailed: true,
    });
    expect(msg).toMatch(/won't be billed again/i);
    expect(msg).toMatch(/have stopped/i);
    expect(msg).toMatch(/confirmation email is on its way/i);
  });
  it("does not claim an email when the confirmation did not send, and states the 72-hour outcomes", () => {
    const msg = planCanceledSuccessMessage(
      summary({
        refundsOwed: [{ date: "2026-09-15", amountCents: 12000 }],
        retained: [{ date: null, amountCents: 9000 }],
      }),
      { confirmationEmailed: false }
    );
    expect(msg).not.toMatch(/email/i);
    // GL-08 R6: exact server outcomes — never a choice, never credit.
    expect(msg).toMatch(/\$120\.00.*refunded in full/i);
    expect(msg).toMatch(/\$90\.00 already paid isn't refunded/i);
    expect(msg).not.toMatch(/your choice|keep it or refund it|credit/i);
  });
});

describe("pendingCancelMessage", () => {
  it("is truthful: still active, refund promise, and never 'won't be charged again'", () => {
    const msg = pendingCancelMessage();
    expect(msg).toMatch(/still active/i);
    expect(msg).toMatch(/refund it/i);
    expect(msg).not.toMatch(/won't be charged again/i);
  });
});

describe("finalChargeDescription", () => {
  it("adds the outstanding-balance line only when money is owed", () => {
    expect(finalChargeDescription(0)).not.toMatch(/you still owe/i);
    expect(finalChargeDescription(9000)).toMatch(/\$90\.00/);
    expect(finalChargeDescription(9000)).toMatch(/doesn't clear that/i);
  });
});

describe("confirmationEmailBodyHtml", () => {
  it("a failed removal is named as a visit WE still need to take off — never 'prepaid'", () => {
    const html = confirmationEmailBodyHtml(
      "Quarterly Plan",
      summary({ failed: 1, failedDates: ["2026-08-01"] })
    );
    expect(html).toMatch(/still on the schedule/i);
    expect(html).toMatch(/won't be charged for it/i);
    // The failed (unpaid) visit is NOT described as one they paid for.
    expect(html).not.toMatch(/already paid for/i);
    // And the intro doesn't falsely claim every visit stopped.
    expect(html).not.toMatch(/Your recurring visits have stopped\./);
  });

  it("each paid visit carries its exact 72-hour outcome — never a choice, never credit", () => {
    const html = confirmationEmailBodyHtml(
      "Quarterly Plan",
      summary({
        refundsOwed: [{ date: "2026-09-15", amountCents: 12000 }],
        retained: [{ date: "2026-07-20", amountCents: 9000 }],
      })
    );
    expect(html).toMatch(/September 15, 2026/);
    expect(html).toMatch(/\$120\.00.*refunded in full/i);
    expect(html).toMatch(/July 20, 2026/);
    expect(html).toMatch(/\$90\.00 already paid isn't refunded/i);
    expect(html).not.toMatch(/keep it or refund it|your choice|credit/i);
  });

  it("a pending money/service decision is named with the one-business-day promise", () => {
    const html = confirmationEmailBodyHtml(
      "Quarterly Plan",
      summary({ pendingDecisions: 1 })
    );
    expect(html).toMatch(/our team is settling/i);
    expect(html).toMatch(/one business day/i);
  });

  it("a fully clean cancel says visits stopped and lists no remainder", () => {
    const html = confirmationEmailBodyHtml("Quarterly Plan", summary({ stopped: 3 }));
    expect(html).toMatch(/Your recurring visits have stopped\./);
    expect(html).not.toMatch(/still on the schedule/i);
    expect(html).not.toMatch(/paid visit/i);
  });
});
