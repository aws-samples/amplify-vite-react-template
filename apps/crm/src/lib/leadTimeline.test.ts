import { describe, expect, it, vi } from "vitest";
import { collectLeadActivityPages, type LeadActivity } from "./api";

const activity = (id: string) =>
  ({ id, customerId: "lead-1", occurredAt: `2026-07-19T00:00:0${id}.000Z` }) as LeadActivity;

describe("complete lead timeline", () => {
  it("pages to completion before returning activity", async () => {
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [activity("1")], nextToken: "page-2" })
      .mockResolvedValueOnce({ data: [activity("2")], nextToken: null });

    await expect(collectLeadActivityPages("lead-1", listPage)).resolves.toEqual([
      expect.objectContaining({ id: "1" }),
      expect.objectContaining({ id: "2" }),
    ]);
    expect(listPage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nextToken: "page-2" })
    );
  });

  it("surfaces a page read failure instead of returning a partial or empty history", async () => {
    const listPage = vi
      .fn()
      .mockResolvedValueOnce({ data: [activity("1")], nextToken: "page-2" })
      .mockResolvedValueOnce({
        data: [],
        errors: [{ message: "timeline page unavailable" }],
      });

    await expect(
      collectLeadActivityPages("lead-1", listPage)
    ).rejects.toThrow(/timeline page unavailable/i);
  });
});
