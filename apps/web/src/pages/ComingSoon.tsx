import { Link } from "react-router-dom";

type Props = {
  title: string;
  subtitle?: string;
};

export default function ComingSoon({ title, subtitle }: Props) {
  return (
    <section className="bk-coming-soon">
      <div className="bk-coming-soon-inner">
        <p className="bk-coming-soon-eyebrow">Coming Soon</p>
        <h1 className="bk-coming-soon-title">{title}</h1>
        {subtitle && <p className="bk-coming-soon-sub">{subtitle}</p>}
        <div className="bk-coming-soon-actions">
          <Link to="/quote" className="bk-btn bk-btn-primary">Get Instant Quote</Link>
          <a href="tel:+15082589294" className="bk-btn bk-btn-outline-light">Call (508) 258-9294</a>
        </div>
        <p className="bk-coming-soon-tagline">BuzzKill Protects More Than Property</p>
      </div>
    </section>
  );
}
