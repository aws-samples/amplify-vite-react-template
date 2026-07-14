import type { ReactNode } from "react";

export type WhyItem = {
  title: string;
  body: ReactNode;
};

type WhyUsProps = {
  title: ReactNode;
  items: WhyItem[];
};

export default function WhyUs({ title, items }: WhyUsProps) {
  return (
    <section className="bk-section bk-section-dark">
      <div className="bk-container">
        <h2 className="bk-h2 bk-center bk-on-dark">{title}</h2>
        <div className="bk-why-grid">
          {items.map((it, i) => (
            <div className="bk-why-item" key={i}>
              <h3 className="bk-h4 bk-on-dark">{it.title}</h3>
              <p className="bk-p bk-on-dark-soft">{it.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
