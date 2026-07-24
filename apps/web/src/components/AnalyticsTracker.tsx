import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageview } from "../lib/analytics";

/**
 * Fires one GA4 page_view per route. The page_path is always correct
 * immediately, but the page title is set by each page's <SEO> component
 * after it renders — and with code-splitting a page's chunk may still be
 * loading when the route changes. So we wait for the <title> element to
 * update before sending, with a timeout fallback for pages that don't
 * change the title (e.g. Home, which keeps the default title). This keeps
 * GA4's "Page title" dimension accurate without coupling to the SEO component.
 */
export default function AnalyticsTracker() {
  const { pathname, search } = useLocation();

  useEffect(() => {
    // Report the homepage to GA as "/home" (its real URL stays "/") so it
    // reads like every other page (/quote, /residential, ...) in path reports.
    // page_location still carries the true "/" URL, so SEO/ads are unaffected.
    const path = (pathname === "/" ? "/home" : pathname) + search;
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      trackPageview(path);
    };

    const titleEl = document.querySelector("title");
    const observer = titleEl
      ? new MutationObserver(() => {
          fire();
          observer?.disconnect();
        })
      : undefined;
    observer?.observe(titleEl!, { childList: true, subtree: true });

    // Fallback: send anyway if the title hasn't changed shortly after navigation.
    const timer = window.setTimeout(() => {
      fire();
      observer?.disconnect();
    }, 1000);

    return () => {
      observer?.disconnect();
      window.clearTimeout(timer);
    };
  }, [pathname, search]);

  return null;
}
