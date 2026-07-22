import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { trackPageview } from "../lib/analytics";

export default function AnalyticsTracker() {
  const { pathname, search } = useLocation();

  useEffect(() => {
    trackPageview(pathname + search);
  }, [pathname, search]);

  return null;
}
