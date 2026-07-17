import { describe, expect, it } from "vitest";
import {
  BOOKING_LINK_TOKEN_RE,
  bookingLinkUrl,
  ensureBookingLinkToken,
  mintBookingLinkToken,
} from "./bookingLink";

/**
 * The booking-link identity token — minted once per lead, carried as
 * ?lead=<token>, resolved server-side so a paid booking converts exactly
 * the record the link was sent to.
 */

type Update = Record<string, unknown>;

const fakeClient = (behavior: "ok" | "refuse" | "throw", updates: Update[]) => ({
  models: {
    Customer: {
      update: async (patch: Update) => {
        if (behavior === "throw") throw new Error("network down");
        updates.push(patch);
        return { data: behavior === "ok" ? { id: String(patch.id) } : null };
      },
    },
  },
});

describe("minting", () => {
  it("produces URL-safe, unguessable, distinct tokens that pass the shape gate", () => {
    const a = mintBookingLinkToken();
    const b = mintBookingLinkToken();
    expect(a).toMatch(BOOKING_LINK_TOKEN_RE);
    expect(b).toMatch(BOOKING_LINK_TOKEN_RE);
    expect(a).not.toBe(b);
  });

  it("builds the tokenized URL, or the bare funnel when there is no token", () => {
    expect(bookingLinkUrl("https://x.example/quote", "tok-abcdef0123456789")).toBe(
      "https://x.example/quote?lead=tok-abcdef0123456789"
    );
    expect(bookingLinkUrl("https://x.example/quote", null)).toBe(
      "https://x.example/quote"
    );
  });
});

describe("ensureBookingLinkToken", () => {
  it("returns the existing token without writing", async () => {
    const updates: Update[] = [];
    const token = await ensureBookingLinkToken(fakeClient("ok", updates), {
      id: "c1",
      bookingLinkToken: "tok-existing-0123456789",
    });
    expect(token).toBe("tok-existing-0123456789");
    expect(updates).toHaveLength(0);
  });

  it("mints and persists on first use", async () => {
    const updates: Update[] = [];
    const token = await ensureBookingLinkToken(fakeClient("ok", updates), {
      id: "c1",
    });
    expect(token).toMatch(BOOKING_LINK_TOKEN_RE);
    expect(updates[0]).toMatchObject({ id: "c1", bookingLinkToken: token });
  });

  it("a refused or failed write yields null — the caller sends the bare link", async () => {
    const updates: Update[] = [];
    expect(
      await ensureBookingLinkToken(fakeClient("refuse", updates), { id: "c1" })
    ).toBeNull();
    expect(
      await ensureBookingLinkToken(fakeClient("throw", updates), { id: "c1" })
    ).toBeNull();
  });
});
