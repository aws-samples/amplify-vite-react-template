import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState } from "../ui/kit";

/**
 * Keeps one broken screen from taking the whole CRM with it.
 *
 * React unmounts the entire tree when a render throws with no boundary above
 * it, and this app had none anywhere. A single unexpected row was enough: the
 * Customers screen sorted rows of the wrong shape, `undefined.localeCompare`
 * threw inside Array.sort, and the office was left staring at a white page with
 * no message, no navigation, and nothing to click. The bug was a one-line type
 * confusion; the outage was total because nothing caught it.
 *
 * Mounted INSIDE the app frame and around the routes only, so the tab bar
 * survives — the screen you asked for is broken, the rest of the CRM is not.
 *
 * `resetKey` is the current path: without it a boundary latches, and every
 * screen you navigated to afterwards would keep showing this error even though
 * nothing was wrong with it. Changing the key clears the failure and lets the
 * next screen render normally.
 */
export default class ScreenErrorBoundary extends Component<
  { children: ReactNode; resetKey: string },
  { failed: boolean; message: string | null; shownFor: string }
> {
  state = {
    failed: false,
    message: null as string | null,
    shownFor: this.props.resetKey,
  };

  static getDerivedStateFromError(error: unknown) {
    return {
      failed: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  /** Derived rather than done in an effect, so navigating away clears the
   *  failure in the SAME render that shows the new screen — never a flash of
   *  the old error over the new route. */
  static getDerivedStateFromProps(
    props: { resetKey: string },
    state: { failed: boolean; message: string | null; shownFor: string }
  ) {
    if (props.resetKey !== state.shownFor) {
      return { failed: false, message: null, shownFor: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The office reports these by screenshot, so the console is where the
    // detail has to live.
    console.error("CRM screen failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <EmptyState
          title="This screen didn't load."
          body="Something on this page hit an error, so the rest of the CRM stayed up. Use the tabs below to carry on, or reload to try this screen again."
          action={
            <Button onClick={() => window.location.reload()}>Reload</Button>
          }
        />
        {/* The message, not a stack: enough for the office to quote when they
            report it, without dressing the screen up as a crash dump. */}
        {this.state.message ? (
          <p className="muted small" style={{ textAlign: "center" }}>
            {this.state.message}
          </p>
        ) : null}
      </div>
    );
  }
}
