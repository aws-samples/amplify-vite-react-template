import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

export default function ScrollProgress() {
  const [progress, setProgress] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [sectionCount, setSectionCount] = useState(0);
  const sectionsRef = useRef<Element[]>([]);
  const location = useLocation();

  useEffect(() => {
    setProgress(0);
    setActiveIdx(0);
    let observer: IntersectionObserver | null = null;

    const onScroll = () => {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(docHeight > 0 ? (scrollTop / docHeight) * 100 : 0);
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    const timer = setTimeout(() => {
      const els = Array.from(document.querySelectorAll("section.bk-section"));
      sectionsRef.current = els;
      setSectionCount(els.length);

      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              const idx = sectionsRef.current.indexOf(entry.target);
              if (idx !== -1) setActiveIdx(idx);
            }
          });
        },
        { rootMargin: "-40% 0px -40% 0px" }
      );
      els.forEach((el) => observer!.observe(el));
    }, 120);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      if (observer) observer.disconnect();
    };
  }, [location.pathname]);

  const scrollToSection = (idx: number) => {
    sectionsRef.current[idx]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <>
      <div className="bk-scroll-bar" style={{ width: `${progress}%` }} aria-hidden="true" />
      {sectionCount > 1 && (
    <nav className="bk-scroll-dots-nav" aria-hidden="true">
      {Array.from({ length: sectionCount }, (_, i) => (
        <button
          key={i}
          className={`bk-scroll-dot${activeIdx === i ? " is-active" : ""}`}
          onClick={() => scrollToSection(i)}
        />
      ))}
    </nav>
      )}
    </>
  );
}
