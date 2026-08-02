import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// ./client calls generateClient() at module scope, so importing anything from
// it would blow up on an unconfigured Amplify. Stubbing generateClient rather
// than the whole ./client module keeps client.ts's real exports intact — the
// same approach as client.test.ts, storage.test.ts and MarketingTasks.test.tsx.
const listTeamUsers = vi.hoisted(() => vi.fn());
const UserProfile = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("aws-amplify/data", () => ({
  generateClient: () => ({
    models: { UserProfile },
    queries: { listTeamUsers },
    mutations: { inviteUser: vi.fn() },
  }),
}));

// SignatureManager (rendered once per roster row) imports these at module
// scope. Only getUrl can fire, and only for a profile that has a signatureKey —
// no row here does — but the module still has to resolve.
vi.mock("aws-amplify/storage", () => ({
  getUrl: vi.fn(),
  uploadData: vi.fn(),
  remove: vi.fn(),
}));

import Team from "./Team";
import type { UserProfile as UserProfileType } from "../lib/client";

/**
 * The four render states of the team roster.
 *
 * `Team` was the one screen the useAsyncResource migration left with a
 * three-branch ladder: loading, empty, table. It had no error branch, so a
 * failed roster read fell through to `users.length === 0` and rendered
 * "No users found." — a read failure presented as an empty organisation, on
 * the one screen where "there are no users" is never a true statement about a
 * signed-in admin's own team.
 *
 * The message was not invisible; it was in the wrong card. `team.error` was
 * rendered in the *invite* form's action row beside SaveStatus, where a
 * roster-read failure reads as "your invite failed". These assert it now
 * appears where the roster does, and only there.
 *
 * The CRM is behind Cognito magic-link auth, so this screen cannot be driven
 * in a browser without a real sign-in. This is the substitute, per PATTERNS.
 */
const profile = {
  id: "p-self",
  userId: "u-self",
  email: "admin@getgim.com",
  firstName: "Ada",
  lastName: "Admin",
} as UserProfileType;

const renderPage = () => render(<Team profile={profile} />);

/** A never-settling read, to hold the component in its in-flight state. */
const pending = () => new Promise<never>(() => {});

describe("Team roster read states", () => {
  it("shows a loader while the read is in flight", () => {
    listTeamUsers.mockReturnValue(pending());
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the empty message when the read returns no users", async () => {
    listTeamUsers.mockResolvedValue({ data: { users: [] }, errors: undefined });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    expect(await screen.findByText("No users found.")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("shows the error — not the empty message, and not a stuck loader", async () => {
    // client.queries.* reports failure by *resolving* with an errors array, not
    // by rejecting, which is why Team unwraps inside the fetcher. That is the
    // failure mode this screen actually sees, so it is the one exercised here.
    listTeamUsers.mockResolvedValue({
      data: null,
      errors: [{ message: "listTeamUsers is unavailable" }],
    });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    expect(
      await screen.findByText(/listTeamUsers is unavailable/)
    ).toBeInTheDocument();
    // The regression: before the error branch existed, this fell through to the
    // empty case and reported an outage as an empty team.
    expect(screen.queryByText("No users found.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("reports a read failure once, and not beside the invite button", async () => {
    listTeamUsers.mockResolvedValue({
      data: null,
      errors: [{ message: "listTeamUsers is unavailable" }],
    });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    const shown = await screen.findAllByText(/listTeamUsers is unavailable/);
    expect(shown).toHaveLength(1);

    // It belongs to the roster card, not the invite form's action row — so the
    // send-invite button must not be its sibling.
    const actions = screen
      .getByRole("button", { name: /send invite/i })
      .closest(".form-actions");
    expect(actions).not.toBeNull();
    expect(actions).not.toHaveTextContent(/listTeamUsers is unavailable/);
  });

  it("renders rows when the read succeeds", async () => {
    listTeamUsers.mockResolvedValue({
      data: {
        users: [
          {
            userId: "u-1",
            email: "producer@getgim.com",
            createdAt: "2026-01-15T09:30:00.000Z",
            groups: ["PRODUCER"],
          },
        ],
      },
      errors: undefined,
    });
    UserProfile.list.mockResolvedValue({ data: [] });
    renderPage();

    expect(await screen.findByText("producer@getgim.com")).toBeInTheDocument();
    expect(screen.getByText("PRODUCER")).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("No users found.")).not.toBeInTheDocument();
  });
});
