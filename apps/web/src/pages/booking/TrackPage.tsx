import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import SEO from "../../components/SEO";
import { checkTrack, type TrackResponse } from "../../lib/bookingApi";

/** The number customers should call if the link can't help. */
const SUPPORT_PHONE = "(508) 258-9294";
/** How often the page asks the server for the technician's new position. */
const POLL_MS = 15000;
/** Optional static-map key (same public key the site already ships). */
const MAPS_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

type Phase =
  | { kind: "loading" }
  | { kind: "en-route"; data: Extract<TrackResponse, { status: "EN_ROUTE" }> }
  | { kind: "arrived" }
  | { kind: "ended" }
  | { kind: "error"; message: string };

/** "3 minutes ago" from an ISO timestamp, for the freshness line. */
function agoLabel(iso: string | null): string | null {
  if (!iso) return null;
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 20) return "just now";
  if (secs < 60) return `${secs} seconds ago`;
  const mins = Math.round(secs / 60);
  return `${mins} minute${mins === 1 ? "" : "s"} ago`;
}

/** A best-effort static map of the technician's current point. Returns null
 *  when no key is configured; the caller then shows the Google Maps link only.
 *  onError hides a broken image (e.g. the key isn't enabled for Static Maps),
 *  so the page degrades to the always-works link rather than a broken tile. */
function StaticMap({ lat, lng }: { lat: number; lng: number }) {
  const [broken, setBroken] = useState(false);
  if (!MAPS_KEY || broken) return null;
  const c = `${lat},${lng}`;
  const src =
    `https://maps.googleapis.com/maps/api/staticmap?center=${c}` +
    `&zoom=14&size=640x360&scale=2&markers=color:0x176b2c%7C${c}&key=${MAPS_KEY}`;
  return (
    <img
      src={src}
      alt="Your technician's current location"
      onError={() => setBroken(true)}
      style={{
        width: "100%",
        height: "auto",
        borderRadius: 14,
        border: "1px solid var(--border, #e2e2e2)",
        display: "block",
      }}
    />
  );
}

/**
 * The customer's "On My Way" live-tracking page: /track/:token
 *
 * The emailed link lands here. It polls the public tracking endpoint every few
 * seconds and shows the technician's live position + ETA while they drive, then
 * "arrived" the moment the visit starts. The token stops resolving once the
 * technician arrives or the safety window closes, so this page never exposes a
 * location beyond the drive itself.
 */
export default function TrackPage() {
  const { token } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // Re-render the "updated N ago" line on a timer without a new network call.
  const [, setTick] = useState(0);
  const firstName = useRef<string | null>(null);

  useEffect(() => {
    if (!token) {
      setPhase({ kind: "error", message: "This tracking link is incomplete." });
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const res = await checkTrack(token);
      if (stopped) return;
      if (!res.ok) {
        setPhase({
          kind: "error",
          message:
            res.body.error ??
            "We couldn't reach the tracking service — please try again.",
        });
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      const body = res.body;
      if (body.status === "EN_ROUTE") {
        if (body.techFirstName) firstName.current = body.techFirstName;
        setPhase({ kind: "en-route", data: body });
        timer = setTimeout(poll, POLL_MS);
      } else if (body.status === "ARRIVED") {
        setPhase({ kind: "arrived" });
        // Stop polling — the drive is over.
      } else {
        // UNKNOWN or ENDED — the link is no longer active.
        setPhase({ kind: "ended" });
      }
    };

    void poll();
    // Keep the freshness label ticking between polls.
    const ticker = setInterval(() => setTick((n) => n + 1), 5000);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(ticker);
    };
  }, [token]);

  const who = firstName.current ?? "Your technician";

  return (
    <>
      <SEO title="Track your technician" noindex />
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">BuzzKill Pest Control</div>

          {phase.kind === "loading" && (
            <h1 className="bk-h2">Finding your technician…</h1>
          )}

          {phase.kind === "en-route" && (
            <>
              <h1 className="bk-h2" style={{ marginBottom: 6 }}>
                {who} is on the way
              </h1>
              {phase.data.etaMinutes != null ? (
                <p className="bk-body-lead" style={{ marginTop: 0 }}>
                  About{" "}
                  <strong>
                    {phase.data.etaMinutes} minute
                    {phase.data.etaMinutes === 1 ? "" : "s"}
                  </strong>{" "}
                  away.
                </p>
              ) : (
                <p className="bk-body-lead" style={{ marginTop: 0 }}>
                  Heading to your address now.
                </p>
              )}

              {phase.data.lat != null && phase.data.lng != null ? (
                <div style={{ margin: "18px 0" }}>
                  <StaticMap lat={phase.data.lat} lng={phase.data.lng} />
                  <p style={{ marginTop: 10 }}>
                    <a
                      className="bk-btn bk-btn-dark"
                      href={`https://www.google.com/maps?q=${phase.data.lat},${phase.data.lng}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open live location in Google Maps
                    </a>
                  </p>
                </div>
              ) : (
                <p className="bk-notice">
                  Waiting for a location signal from your technician's phone…
                </p>
              )}

              {agoLabel(phase.data.updatedAt) ? (
                <p className="bk-summary-val" style={{ color: "var(--fg2)" }}>
                  Location updated {agoLabel(phase.data.updatedAt)}. This page
                  refreshes on its own.
                </p>
              ) : null}
            </>
          )}

          {phase.kind === "arrived" && (
            <>
              <h1 className="bk-h2">{who} has arrived</h1>
              <p className="bk-body-lead">
                Your technician is at your address. Thanks for choosing BuzzKill!
              </p>
            </>
          )}

          {phase.kind === "ended" && (
            <>
              <h1 className="bk-h2">This tracking link is no longer active</h1>
              <p className="bk-body-lead">
                Your technician has either arrived or finished the visit. If you
                need anything, give us a call at{" "}
                <a href={`tel:${SUPPORT_PHONE.replace(/[^0-9]/g, "")}`}>
                  {SUPPORT_PHONE}
                </a>
                .
              </p>
            </>
          )}

          {phase.kind === "error" && (
            <>
              <h1 className="bk-h2">We hit a snag</h1>
              <p className="bk-form-error">{phase.message}</p>
              <p className="bk-body-lead">
                Please call us at{" "}
                <a href={`tel:${SUPPORT_PHONE.replace(/[^0-9]/g, "")}`}>
                  {SUPPORT_PHONE}
                </a>{" "}
                and we'll let you know where your technician is.
              </p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
