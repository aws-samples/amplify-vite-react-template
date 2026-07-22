import { useEffect } from "react";
import { trackButtonClick } from "../lib/analytics";

/**
 * Tracks every button/link click site-wide via one delegated listener,
 * instead of wiring `onClick` into every page — that approach reliably
 * misses buttons as new pages get added. Opt a specific element out with
 * `data-no-track` (e.g. a noisy UI toggle that isn't a marketing signal).
 *
 * `button_id` prefers an explicit `data-track-id` (set on the high-value
 * conversion buttons) and falls back to a slug of the visible text, so
 * every click is still identifiable even on elements nobody tagged by hand.
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

export default function ClickTracker() {
  useEffect(() => {
    function onClick(e: MouseEvent) {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("a, button");
      if (!el || el.closest("[data-no-track]")) return;

      const text = (el.innerText || el.getAttribute("aria-label") || "").trim();
      const explicitId = el.getAttribute("data-track-id");
      const buttonId = explicitId || slugify(text) || el.tagName.toLowerCase();

      let destination = "action";
      if (el.tagName === "A") {
        destination = el.getAttribute("href") || "action";
      } else if (el.getAttribute("type") === "submit") {
        destination = "form_submit";
      }

      trackButtonClick(buttonId, text, destination);
    }

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
