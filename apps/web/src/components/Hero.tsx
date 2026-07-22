import type { ReactNode } from "react";

type HeroProps = {
  image: string;
  video?: string;
  eyebrow?: string;
  headline: ReactNode;
  subtitle?: ReactNode;
  sub?: ReactNode;
  body?: ReactNode;
  primaryCta?: { label: string; onClick?: () => void; href?: string };
  secondaryCta?: { label: string; onClick?: () => void; href?: string };
  announceBanner?: boolean;
  className?: string;
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
  subtitle,
  sub,
  body,
  primaryCta,
  secondaryCta,
  announceBanner,
  className,
}: HeroProps) {
  return (
    <section
      className={`bk-hero${video ? " bk-hero--video" : ""}${announceBanner ? " bk-hero--announce" : ""}${className ? ` ${className}` : ""}`}
    >
      {announceBanner && (
        <div className="bk-announce" aria-label="Trust signals">
          <div className="bk-announce-inner">
            <div className="bk-announce-trust">
              <span className="bk-announce-stars" aria-label="4.9 star rating">★★★★★</span>
              <span>4.9 Google Rating</span>
              <span className="bk-announce-sep" aria-hidden="true">|</span>
              <span>Licensed &amp; Insured</span>
              <span className="bk-announce-sep" aria-hidden="true">|</span>
              <span>Family Owned &amp; Operated</span>
              <span className="bk-announce-sep" aria-hidden="true">|</span>
              <span>Serving MA &amp; RI</span>
            </div>
          </div>
        </div>
      )}
      {!video && (
        <img
          src={image}
          alt=""
          aria-hidden="true"
          className="bk-hero-bg-img"
        />
      )}
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
        {eyebrow && <p className="hero-eyebrow">{eyebrow}</p>}
        <h1 className="bk-hero-headline">{headline}</h1>
        {subtitle && <p className="hero-subtitle">{subtitle}</p>}
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
