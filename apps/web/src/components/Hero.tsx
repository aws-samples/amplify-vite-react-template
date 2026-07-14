import type { ReactNode } from "react";

type HeroProps = {
  image: string;
  video?: string;
  eyebrow?: string;
  headline: ReactNode;
  sub?: ReactNode;
  body?: ReactNode;
  primaryCta?: { label: string; onClick?: () => void; href?: string };
  secondaryCta?: { label: string; onClick?: () => void; href?: string };
};

function CtaButton({
  cta,
  variant,
}: {
  cta: { label: string; onClick?: () => void; href?: string };
  variant: "primary" | "outline-light";
}) {
  const className = `bk-btn bk-btn-${variant}`;
  if (cta.href) {
    return (
      <a className={className} href={cta.href} onClick={cta.onClick}>
        {cta.label}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={cta.onClick}>
      {cta.label}
    </button>
  );
}

export default function Hero({
  image,
  video,
  eyebrow,
  headline,
  sub,
  body,
  primaryCta,
  secondaryCta,
}: HeroProps) {
  return (
    <section
      className={`bk-hero${video ? " bk-hero--video" : ""}`}
      style={video ? undefined : { backgroundImage: `url(${image})` }}
      role="img"
      aria-label="BuzzKill Pest Control — professional pest management for condos and HOAs"
    >
      {video && (
        <video
          className="bk-hero-video"
          autoPlay
          muted
          loop
          playsInline
          poster={image}
        >
          <source src={video} type="video/mp4" />
        </video>
      )}
      <div className="bk-hero-overlay" aria-hidden="true" />
      <div className="bk-hero-inner">
        {eyebrow && <div className="bk-hero-eyebrow">{eyebrow}</div>}
        <h1 className="bk-hero-headline">{headline}</h1>
        {sub && <p className="bk-hero-sub">{sub}</p>}
        {body && <p className="bk-hero-sub">{body}</p>}
        {(primaryCta || secondaryCta) && (
          <div className="bk-hero-ctas">
            {primaryCta && <CtaButton cta={primaryCta} variant="primary" />}
            {secondaryCta && (
              <CtaButton cta={secondaryCta} variant="outline-light" />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
