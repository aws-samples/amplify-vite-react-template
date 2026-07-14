import type { ReactNode } from "react";

type ServiceSectionProps = {
  image: string;
  eyebrow?: string;
  title: ReactNode;
  body?: ReactNode;
  bullets?: string[];
  cta?: { label: string; onClick?: () => void; href?: string };
  reversed?: boolean;
};

export default function ServiceSection({
  image,
  eyebrow,
  title,
  body,
  bullets,
  cta,
  reversed,
}: ServiceSectionProps) {
  return (
    <section className={`bk-service ${reversed ? "is-reversed" : ""}`}>
      <div
        className="bk-service-img"
        style={{ backgroundImage: `url(${image})` }}
        role="img"
      />
      <div className="bk-service-text">
        {eyebrow && <div className="bk-eyebrow">{eyebrow}</div>}
        <h2 className="bk-h2">{title}</h2>
        {body && <p className="bk-body-lead">{body}</p>}
        {bullets && bullets.length > 0 && (
          <ul className="bk-bullets">
            {bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}
        {cta &&
          (cta.href ? (
            <a className="bk-btn bk-btn-dark" href={cta.href} onClick={cta.onClick}>
              {cta.label}
            </a>
          ) : (
            <button type="button" className="bk-btn bk-btn-dark" onClick={cta.onClick}>
              {cta.label}
            </button>
          ))}
      </div>
    </section>
  );
}
