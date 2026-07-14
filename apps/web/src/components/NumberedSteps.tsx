import type { ReactNode } from "react";

export type Step = {
  title: string;
  body: ReactNode;
};

type NumberedStepsProps = {
  eyebrow?: string;
  title: ReactNode;
  steps: Step[];
  variant?: "light" | "cream";
};

export default function NumberedSteps({
  eyebrow,
  title,
  steps,
  variant = "light",
}: NumberedStepsProps) {
  return (
    <section className={`bk-section bk-section-${variant}`}>
      <div className="bk-container">
        {eyebrow && <div className="bk-eyebrow bk-center">{eyebrow}</div>}
        <h2 className="bk-h2 bk-center">{title}</h2>
        <div className="bk-steps">
          {steps.map((s, i) => (
            <div className="bk-step" key={i}>
              <div className="bk-step-num">{i + 1}</div>
              <h3 className="bk-h3">{s.title}</h3>
              <p className="bk-p">{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
