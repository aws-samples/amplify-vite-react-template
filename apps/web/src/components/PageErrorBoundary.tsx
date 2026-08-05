import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError } from "../lib/lazyPage";

/**
 * The last thing between a failed page and a blank screen.
 *
 * React unmounts the entire tree when a render throws with no boundary above
 * it, so before this existed a route chunk that failed to load took the header
 * and footer down with it and left the customer looking at nothing — no
 * message, no retry, no phone number. lazyPage() already recovers from the
 * common cause (a stale deploy's 404'd chunk) by reloading once; this catches
 * everything it deliberately does not retry: the second failure, an offline
 * device, and any page that throws while rendering.
 *
 * Deliberately plain. It has to render when a chunk could not be fetched, so
 * it depends on nothing that is itself code-split.
 */
export default class PageErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean; offline: boolean }
> {
  state = { failed: false, offline: false };

  static getDerivedStateFromError(error: unknown) {
    return {
      failed: true,
      // A chunk that won't fetch is usually the network, not us — and saying
      // "check your connection" to someone who is offline is more useful than
      // an apology.
      offline: isChunkLoadError(error) && !navigator.onLine,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surfaces in the same console/session tooling as any other page error.
    console.error("Page failed to render", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow" style={{ textAlign: "center" }}>
          <div className="bk-eyebrow">Something went wrong</div>
          <h1 className="bk-h2">This page didn&rsquo;t load.</h1>
          <p className="bk-body-lead">
            {this.state.offline
              ? "You appear to be offline. Reconnect and try again."
              : "That’s on us, not you. Reloading usually fixes it."}
          </p>
          <div style={{ marginTop: 20 }}>
            <button
              type="button"
              className="bk-btn bk-btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
          </div>
          {/* Never a dead end: a customer mid-checkout can still reach a human. */}
          <p className="bk-body" style={{ marginTop: 20 }}>
            Still stuck? Call <a href="tel:+15082589294">(508) 258-9294</a> or
            email <a href="mailto:info@pestbuzzkill.com">info@pestbuzzkill.com</a>.
          </p>
        </div>
      </section>
    );
  }
}
