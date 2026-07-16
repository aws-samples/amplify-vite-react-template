import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANCEL_FULL_REFUND_DAYS } from "../shared/bookingTerms";

/**
 * R17 (single-source half) — the cancellation policy a customer reads in the
 * confirmation email and signs in the agreement PDF must be rendered from
 * CANCEL_FULL_REFUND_DAYS in shared/bookingTerms, not from a hardcoded copy
 * that can drift from the rule /cancel actually enforces.
 */

const emails: { to: string; subject: string; html: string }[] = [];
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  sendEmail: async (o: { to: string; subject: string; html: string }) => {
    emails.push(o);
    return true;
  },
  notifyOffice: async () => true,
}));

const pdfBodies: string[] = [];
vi.mock("../shared/pdf", () => ({
  renderAgreementPdf: async (opts: { bodyText: string }) => {
    pdfBodies.push(opts.bodyText);
    return Buffer.from("pdf");
  },
}));

vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({ customers: { update: async () => ({}) } }),
}));

let booking: Record<string, unknown>;

const fakeDataClient = {
  models: {
    BookingRequest: {
      get: async () => ({ data: booking }),
      update: async (patch: Record<string, unknown>) => ({ data: patch }),
    },
    BookingFinalization: {
      create: async () => ({ data: { id: "b1" } }),
      delete: async () => ({ data: null }),
    },
    Customer: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "cust1", groupId: null, ...input },
      }),
      update: async (patch: Record<string, unknown>) => ({ data: patch }),
    },
    ServicePlan: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "plan1", ...input },
      }),
    },
    Job: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "job1", ...input },
      }),
    },
    Invoice: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "inv1", ...input },
      }),
    },
    Agreement: {
      create: async (input: Record<string, unknown>) => ({
        data: { id: "agr1", ...input },
      }),
    },
  },
};
vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));

const { finalizeBooking } = await import("../shared/bookingFinalize");

beforeEach(() => {
  emails.length = 0;
  pdfBodies.length = 0;
  delete process.env.DOCS_BUCKET; // skip the S3 write
  process.env.SES_NOTIFY_EMAIL = "office@pestbuzzkill.com";
  booking = {
    id: "b1",
    status: "QUOTED",
    name: "Dana Whitlock",
    email: "dana@example.com",
    phone: null,
    street: "12 Beacon St",
    city: "Ware",
    state: "MA",
    zip: "01082",
    quoteJson: JSON.stringify({
      serviceLabel: "Rodent treatment — up to 2,000 sqft",
      recurringOffer: null,
    }),
    selectedDate: "2026-07-22",
    selectedWindow: "MORNING",
    recurring: false,
    amountCents: 31300,
    cancelToken: "tok-1",
    stripeCustomerId: "cus_1",
    stripePaymentIntentId: "pi_1",
  };
});

describe("the finalize email renders the cancellation constant (R17)", () => {
  it("derives the confirmation-email policy copy from CANCEL_FULL_REFUND_DAYS", async () => {
    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 31300,
    });

    const confirmation = emails.find((e) => e.to === "dana@example.com");
    expect(confirmation).toBeDefined();
    expect(confirmation!.html).toContain("/cancel?token=tok-1");
    expect(confirmation!.html).toContain(
      `more than ${CANCEL_FULL_REFUND_DAYS} days out is a full refund; ${CANCEL_FULL_REFUND_DAYS} days or less is non-refundable`
    );
  });

  it("signs the agreement PDF with the same derived policy", async () => {
    await finalizeBooking({
      bookingRequestId: "b1",
      paymentIntentId: "pi_1",
      amountReceived: 31300,
    });

    expect(pdfBodies[0]).toContain(
      `Cancel more than ${CANCEL_FULL_REFUND_DAYS} days before your appointment for a full refund. Cancellations ${CANCEL_FULL_REFUND_DAYS} days or less before the appointment are not refundable.`
    );
  });
});
