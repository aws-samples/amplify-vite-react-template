import { useState } from "react";

export type FAQItem = {
  q: string;
  a: string;
};

type FAQProps = {
  items: FAQItem[];
  eyebrow?: string;
  title?: string;
};

export default function FAQ({
  items,
  eyebrow = "Frequently Asked",
  title = "BuzzKill FAQs",
}: FAQProps) {
  const [open, setOpen] = useState<number>(0);
  return (
    <section className="bk-section bk-section-light">
      <div className="bk-container bk-narrow">
        <div className="bk-eyebrow">{eyebrow}</div>
        <h2 className="bk-h2">{title}</h2>
        <ul className="bk-faq">
          {items.map((it, i) => {
            const isOpen = open === i;
            return (
              <li
                className={`bk-faq-item ${isOpen ? "is-open" : ""}`}
                key={i}
              >
                <button
                  type="button"
                  className="bk-faq-q"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? -1 : i)}
                >
                  <span>{it.q}</span>
                  <span className="bk-faq-icon" aria-hidden="true">
                    {isOpen ? "–" : "+"}
                  </span>
                </button>
                {isOpen && (
                  <div className="bk-faq-a">
                    <p className="bk-p">{it.a}</p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
