import { useEffect, useState } from "react";

/**
 * PWA install detection. Three states matter:
 *  - already installed (running standalone, or installed this session)
 *  - installable now (Chromium fired `beforeinstallprompt` — Android/desktop)
 *  - iOS Safari (no prompt API; we show Add-to-Home-Screen instructions)
 *
 * The beforeinstallprompt event fires before React mounts, so it's captured
 * at module load and stashed.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    listeners.forEach((l) => l());
  });
}

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari's non-standard flag
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIOS(): boolean {
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || iPadOS;
}

export function useInstallState() {
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    listeners.add(bump);
    // Re-read once after subscribing: beforeinstallprompt may have fired
    // between render and effect commit.
    bump();
    return () => {
      listeners.delete(bump);
    };
  }, []);

  const standalone = isStandalone();
  return {
    /** Already running as an installed app. */
    installed: standalone,
    /** One-tap native install available (Chromium: Android, Chrome/Edge desktop). */
    canPromptInstall: !standalone && deferredPrompt !== null,
    /** iOS: installable only via Share → Add to Home Screen. */
    needsIosInstructions: !standalone && deferredPrompt === null && isIOS(),
    /** Trigger the native install prompt. */
    promptInstall: async (): Promise<"accepted" | "dismissed" | "unavailable"> => {
      if (!deferredPrompt) return "unavailable";
      const p = deferredPrompt;
      // The event is single-use either way; Chromium re-fires
      // beforeinstallprompt later if the user stays eligible.
      deferredPrompt = null;
      try {
        await p.prompt();
        const { outcome } = await p.userChoice;
        return outcome;
      } catch {
        return "unavailable";
      } finally {
        listeners.forEach((l) => l());
      }
    },
  };
}
