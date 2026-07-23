import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageview } from "../lib/analytics";

export default function AnalyticsTracker() {
  const { pathname, search } = useLocation();

  useEffect(() => {
    // Defer one frame: SEO.tsx sets document.title in its own effect, which
    // runs in a different subtree. Firing on the next frame guarantees the
    // title is current before the page_view captures it.
    const id = requestAnimationFrame(() => trackPageview(pathname + search));
    return () => cancelAnimationFrame(id);
  }, [pathname, search]);

  return null;
}
