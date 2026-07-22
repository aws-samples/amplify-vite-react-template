import type { ReactNode } from "react";

function GoogleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" className="bk-google-logo">
      <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v9h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11C42.73 37.24 45.12 31.36 45.12 24.5z"/>
      <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.34l-7.11-5.52c-1.97 1.32-4.49 2.11-7.45 2.11-5.73 0-10.58-3.87-12.32-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/>
      <path fill="#FBBC05" d="M11.68 28.18C11.24 26.86 11 25.45 11 24s.24-2.86.68-4.18v-5.7H4.34C3.12 16.7 2.4 20.24 2.4 24s.72 7.3 1.94 9.88l7.34-5.7z"/>
      <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.34 5.7c1.74-5.2 6.59-9.07 12.32-9.07z"/>
    </svg>
  );
}

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
  const trackId = variant === "primary" ? "hero_primary" : "hero_secondary";
  if (cta.href) {
    return (
      <a className={className} href={cta.href} onClick={cta.onClick} data-track-id={trackId}>
        {cta.label}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={cta.onClick} data-track-id={trackId}>
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
              <span className="bk-announce-stars" aria-label="5 star rating">★★★★★</span>
              <span className="bk-announce-google-rating">
                5.0 <GoogleLogo /> Rating
              </span>
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
