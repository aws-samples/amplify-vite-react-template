import { describe, expect, it } from "vitest";
import { renderQuotePdf } from "./pdf";

const isPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-";

const base = {
  quoteRef: "bk-abc123",
  quotedAtIso: "2026-07-20T15:00:00.000Z",
  validThroughIso: "2026-07-21T15:00:00.000Z",
  customerName: "Dana Rivera",
  customerEmail: "dana@example.com",
  customerPhone: "(413) 555-0123",
  serviceAddress: "12 Maple St, Springfield, MA 01103",
};

describe("renderQuotePdf", () => {
  it("renders a one-time-only quote (no plan offer)", async () => {
    const pdf = await renderQuotePdf({
      ...base,
      serviceLabel: "Wasp nest removal",
      oneTimeCents: 24900,
      plan: null,
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders a one-time treatment with a recurring plan option", async () => {
    const pdf = await renderQuotePdf({
      ...base,
      serviceLabel: "General pest control",
      oneTimeCents: 18900,
      plan: { frequency: "QUARTERLY", monthlyCents: 4900, initialFeeCents: 4900 },
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders a plan-only quote with no one-time box", async () => {
    const pdf = await renderQuotePdf({
      ...base,
      serviceLabel: "Community common-area plan — 24 units",
      oneTimeCents: 4200, // present but must be ignored under planOnly
      plan: { frequency: "MONTHLY", monthlyCents: 42000, initialFeeCents: 42000 },
      planOnly: true,
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders an off-season seasonal enrollment (no day board)", async () => {
    const pdf = await renderQuotePdf({
      ...base,
      serviceLabel: "Mosquito plan",
      oneTimeCents: null,
      plan: { frequency: "MONTHLY", monthlyCents: 8900, initialFeeCents: 8900 },
      planOnly: true,
      offSeason: true,
      offSeasonMessage:
        "Mosquito season runs April–October. Enroll now and your plan starts today.",
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("survives a minimal payload (no address, no optional fields)", async () => {
    const pdf = await renderQuotePdf({
      quoteRef: "bk-min",
      quotedAtIso: "2026-07-20T15:00:00.000Z",
      customerName: "Customer",
      serviceLabel: "Rodent treatment",
      oneTimeCents: 30000,
    });
    expect(isPdf(pdf)).toBe(true);
  });
});
