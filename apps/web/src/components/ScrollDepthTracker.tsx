import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { trackScrollDepth } from "../lib/analytics";

const THRESHOLDS = [25, 50, 75, 90, 100] as const;

/** Fires `scroll_depth` once per threshold per page view, reset on every route change. */
export default function ScrollDepthTracker() {
  const { pathname } = useLocation();
  const fired = useRef<Set<number>>(new Set());
  const ticking = useRef(false);

  useEffect(() => {
    fired.current = new Set();

    function checkDepth() {
      ticking.current = false;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      const percent = scrollable <= 0 ? 100 : Math.round((window.scrollY / scrollable) * 100);

      for (const threshold of THRESHOLDS) {
        if (percent >= threshold && !fired.current.has(threshold)) {
          fired.current.add(threshold);
          trackScrollDepth(threshold);
        }
      }
    }

    function onScroll() {
      if (ticking.current) return;
      ticking.current = true;
      requestAnimationFrame(checkDepth);
    }

    checkDepth();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [pathname]);

  return null;
}
