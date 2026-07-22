import { useEffect, useState } from "react";
import { Button, Sheet } from "../ui/kit";
import { useInstallState } from "../lib/installPrompt";

const DISMISS_KEY = "bk-install-dismissed-at";
const DISMISS_DAYS = 21;

/* localStorage can throw (private mode, storage policies) — never let that
   take the app down. */
function recentlyDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - at < DISMISS_DAYS * 86400_000;
  } catch {
    return false;
  }
}

function recordDismissal() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* banner will re-show next session; harmless */
  }
}

function ShareGlyph() {
  return (
    <svg
      className="install-glyph"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-label="Share icon"
    >
      <path d="M12 3v12" />
      <path d="m8 6 4-3 4 3" />
      <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
    </svg>
  );
}

/**
 * "Get the app" banner for staff (office + technicians). Detects whether the
 * CRM is already installed as an app; when it isn't, offers a one-tap
 * install on Android/desktop (native prompt) or step-by-step instructions on
 * iOS, where browsers have no install API.
 */
export default function InstallBanner() {
  const install = useInstallState();
  const [dismissed, setDismissed] = useState(recentlyDismissed);
  const [iosSheet, setIosSheet] = useState(false);

  const show =
    !install.installed &&
    !dismissed &&
    (install.canPromptInstall || install.needsIosInstructions);

  // Reserve scroll room so the fixed banner never hides the last row.
  useEffect(() => {
    document.body.classList.toggle("has-install-banner", show);
    return () => document.body.classList.remove("has-install-banner");
  }, [show]);

  if (!show) return null;

  const dismiss = () => {
    recordDismissal();
    setDismissed(true);
  };

  return (
    <>
      <div className="install-banner" role="region" aria-label="Install the app">
        <img src="/icons/icon-192.png" alt="" className="install-banner-icon" />
        <div className="install-banner-text">
          <strong>Get the BuzzKill app</strong>
          <span>
            {install.canPromptInstall
              ? "One tap installs it on this device — faster access, full screen."
              : "Add it to your home screen for faster access."}
          </span>
        </div>
        <Button
          small
          onClick={() => {
            if (install.canPromptInstall) {
              void install.promptInstall().then((res) => {
                if (res === "accepted") dismiss();
              });
            } else {
              setIosSheet(true);
            }
          }}
        >
          Install
        </Button>
        <button
          type="button"
          className="install-banner-close"
          aria-label="Dismiss"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            // The banner sits above the persistent navigation. Consume the
            // gesture before unmounting so a dismissal can never become a tap
            // on the More tab underneath it.
            e.preventDefault();
            e.stopPropagation();
            dismiss();
          }}
        >
          ✕
        </button>
      </div>

      <Sheet
        open={iosSheet}
        onClose={() => setIosSheet(false)}
        title="Add BuzzKill to your home screen"
      >
        <ol className="install-steps">
          <li>
            Tap the <strong>Share</strong> button <ShareGlyph /> in your
            browser's toolbar (in Safari it's at the bottom; in Chrome it's by
            the address bar)
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>
          </li>
          <li>
            Tap <strong>Add</strong> — the BuzzKill app appears on your home
            screen
          </li>
        </ol>
        <p className="muted small">
          It opens full-screen like a regular app and keeps you signed in.
        </p>
        <Button
          block
          onClick={() => {
            // Assume they followed the steps; don't nag every visit. The
            // banner re-offers after the dismissal window if they didn't.
            dismiss();
            setIosSheet(false);
          }}
        >
          Done
        </Button>
      </Sheet>
    </>
  );
}
