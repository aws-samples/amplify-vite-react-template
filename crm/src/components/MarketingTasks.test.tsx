import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact — the
// same approach as client.test.ts and storage.test.ts.
const MarketingTask = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({ models: { MarketingTask } }),
}));

import { AllMarketingTasks } from "./MarketingTasks";

/**
 * The four render states of a migrated read.
 *
 * `AllMarketingTasks` stands in for the thirteen call sites migrated onto
 * `useAsyncResource`: it is the one with no props, and it carried the sharpest
 * form of the bug the migration exists to remove — `setLoaded(true)` sat on the
 * success path with no `.catch()`, so a failed read left the screen on
 * "Loading…" permanently and a failure was indistinguishable from an empty
 * list. These assert the distinction now exists, rather than asserting it from
 * the diff.
 *
 * The CRM is behind Cognito magic-link auth, so the migrated screens cannot be
 * driven in a browser without a real sign-in. This is the substitute.
 */
const renderPage = () =>
  render(
    <MemoryRouter>
      <AllMarketingTasks />
    </MemoryRouter>
  );

/** A never-settling read, to hold the component in its in-flight state. */
const pending = () => new Promise<never>(() => {});

describe("AllMarketingTasks read states", () => {
  it("shows a loader while the read is in flight", () => {
    MarketingTask.list.mockReturnValue(pending());
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty message when the read returns nothing", async () => {
    MarketingTask.list.mockResolvedValue({ data: [], nextToken: null });
    renderPage();
    expect(
      await screen.findByText(/No open marketing tasks\./)
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the error — not the empty message, and not a stuck loader", async () => {
    MarketingTask.list.mockRejectedValue(new Error("network is down"));
    renderPage();

    // The regression this migration removes: before it, a rejection left
    // `loaded` false forever and this screen sat on "Loading…" with the
    // failure visible only as an unhandled rejection in the console.
    expect(await screen.findByText(/network is down/)).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No open marketing tasks\./)).not.toBeInTheDocument();
  });

  it("renders rows when the read succeeds", async () => {
    MarketingTask.list.mockResolvedValue({
      data: [
        {
          id: "t1",
          accountId: "a1",
          accountName: "Elm Street Condominium",
          carrierName: "Acme Mutual",
          status: "OPEN",
          sourceType: "POLICY",
          lines: ["Property"],
          submitBy: "2026-09-01",
        },
      ],
      nextToken: null,
    });
    renderPage();

    expect(
      await screen.findByText("Elm Street Condominium")
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText(/No open marketing tasks\./)).not.toBeInTheDocument();
  });
});
