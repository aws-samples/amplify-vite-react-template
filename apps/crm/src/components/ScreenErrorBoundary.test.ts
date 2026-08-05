import { describe, expect, it } from "vitest";
import ScreenErrorBoundary from "./ScreenErrorBoundary";

/**
 * The boundary's state machine, exercised through its two static hooks — no
 * DOM needed, because the part worth testing is when it clears itself.
 *
 * A boundary that never resets is the classic version of this bug: one screen
 * throws, and from then on every screen you navigate to shows that same error
 * even though nothing is wrong with it. That turns a one-screen outage into
 * the whole-CRM outage the boundary was added to prevent.
 */

type State = { failed: boolean; message: string | null; shownFor: string };

const fromError = ScreenErrorBoundary.getDerivedStateFromError;
const fromProps = ScreenErrorBoundary.getDerivedStateFromProps as (
  props: { resetKey: string },
  state: State
) => Partial<State> | null;

const healthy = (path: string): State => ({
  failed: false,
  message: null,
  shownFor: path,
});

describe("ScreenErrorBoundary", () => {
  it("records the failure and the message it will show", () => {
    expect(fromError(new Error("x.localeCompare is not a function"))).toEqual({
      failed: true,
      message: "x.localeCompare is not a function",
    });
  });

  it("survives something thrown that isn't an Error", () => {
    expect(fromError("boom")).toEqual({ failed: true, message: "boom" });
  });

  it("clears the failure when you navigate to another screen", () => {
    const broken: State = { failed: true, message: "boom", shownFor: "/customers" };
    expect(fromProps({ resetKey: "/schedule" }, broken)).toEqual({
      failed: false,
      message: null,
      shownFor: "/schedule",
    });
  });

  it("keeps showing the error while you stay on the screen that threw", () => {
    // Re-rendering the broken route must not silently retry: React would throw
    // again immediately and the screen would flicker between the two.
    const broken: State = { failed: true, message: "boom", shownFor: "/customers" };
    expect(fromProps({ resetKey: "/customers" }, broken)).toBeNull();
  });

  it("does nothing on a healthy re-render of the same screen", () => {
    expect(fromProps({ resetKey: "/customers" }, healthy("/customers"))).toBeNull();
  });

  it("tracks the current screen even when nothing has failed", () => {
    // Otherwise `shownFor` would still name the first route ever rendered, and
    // the first real failure elsewhere would be cleared the moment it appeared.
    expect(fromProps({ resetKey: "/schedule" }, healthy("/customers"))).toEqual({
      failed: false,
      message: null,
      shownFor: "/schedule",
    });
  });
});
