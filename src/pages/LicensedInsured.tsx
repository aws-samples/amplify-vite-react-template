import { Link } from "react-router-dom";
import SEO, { buildBreadcrumbSchema } from "../components/SEO";

const VERIFY_MA =
  "https://www.mass.gov/how-to/look-up-and-confirm-a-massachusetts-pesticide-license";
const VERIFY_RI = "https://demri.my.site.com/agr/s/";

const ShieldIcon = () => (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

const DocIcon = () => (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <path d="M9 15l2 2 4-4" />
  </svg>
);

const InsuranceIcon = () => (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M12 12m-3 0a3 3 0 106 0 3 3 0 10-6 0" />
    <path d="M2 10h2M20 10h2" />
  </svg>
);

type CredentialCardProps = {
  icon: React.ReactNode;
  title: string;
  details: { label: string; value: React.ReactNode }[];
  verifyUrl?: string;
  verifyLabel?: string;
  accent?: boolean;
};

function CredentialCard({
  icon,
  title,
  details,
  verifyUrl,
  verifyLabel = "Verify Credential",
  accent,
}: CredentialCardProps) {
  return (
    <div className={`bk-credential-card${accent ? " bk-credential-card--accent" : ""}`}>
      <div className="bk-credential-head">
        {icon}
        <h3 className="bk-credential-title">{title}</h3>
      </div>

      <dl className="bk-credential-dl">
        {details.map((d, i) => (
          <div key={i} className="bk-credential-row">
            <dt className="bk-credential-dt">{d.label}</dt>
            <dd className="bk-credential-dd">{d.value}</dd>
          </div>
        ))}
      </dl>

      {verifyUrl && (
        <div className="bk-credential-verify">
          <a
            href={verifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bk-btn bk-btn-outline"
          >
            {verifyLabel} &rarr;
          </a>
        </div>
      )}
    </div>
  );
}

export default function LicensedInsured() {
  return (
    <>
      <SEO
        title="Licensed & Insured"
        description="BuzzKill Pest Control is fully licensed and registered in Massachusetts and Rhode Island. View our state credentials and request our Certificate of Insurance."
        jsonLd={buildBreadcrumbSchema([
          { name: "Home", url: "/" },
          { name: "Licensed & Insured", url: "/licensed-insured" },
        ])}
      />

      {/* Hero */}
      <section className="bk-section bk-section-light">
        <div className="bk-container bk-narrow">
          <div className="bk-eyebrow">Credentials</div>
          <h1 className="bk-h1-lower">Licensed &amp; Insured</h1>
          <p className="bk-body-lead">
            BuzzKill Pest Control operates under full state licensure and
            registration in every jurisdiction we serve. Our credentials are
            verifiable through the official state agency portals linked below.
          </p>
        </div>
      </section>

      {/* Credentials grid */}
      <section className="bk-section bk-section-cream">
        <div className="bk-container" style={{ maxWidth: 880 }}>
          <h2 className="bk-h2">State Credentials</h2>
          <div className="bk-credential-grid">
            <CredentialCard
              icon={<ShieldIcon />}
              title="Rhode Island Pesticide Company Registration"
              accent
              details={[
                { label: "Registration #", value: "CP-PCR-000045" },
                {
                  label: "Agency",
                  value:
                    "Rhode Island Department of Environmental Management (RIDEM), Division of Agriculture and Forest Environment",
                },
                {
                  label: "Status",
                  value: <span className="bk-credential-status">Active</span>,
                },
              ]}
              verifyUrl={VERIFY_RI}
              verifyLabel="Verify on RIDEM Portal"
            />

            <CredentialCard
              icon={<DocIcon />}
              title="Massachusetts Pesticide Commercial Certification"
              accent
              details={[
                { label: "License #", value: "CC-0060592" },
                {
                  label: "Category",
                  value: "41 — General Pest Control",
                },
                {
                  label: "Agency",
                  value:
                    "Massachusetts Department of Agricultural Resources (MDAR), Pesticide Program",
                },
                {
                  label: "Status",
                  value: <span className="bk-credential-status">Active</span>,
                },
              ]}
              verifyUrl={VERIFY_MA}
              verifyLabel="Look Up on Mass.gov"
            />

            <CredentialCard
              icon={<DocIcon />}
              title="Massachusetts Applicator (Core) License"
              details={[
                { label: "License #", value: "AL-0060551" },
                {
                  label: "Agency",
                  value:
                    "Massachusetts Department of Agricultural Resources (MDAR), Pesticide Program",
                },
                {
                  label: "Status",
                  value: <span className="bk-credential-status">Active</span>,
                },
              ]}
              verifyUrl={VERIFY_MA}
              verifyLabel="Look Up on Mass.gov"
            />

            <CredentialCard
              icon={<InsuranceIcon />}
              title="Insurance"
              details={[
                {
                  label: "Coverage",
                  value:
                    "General liability and pesticide/herbicide coverage",
                },
                {
                  label: "COI",
                  value:
                    "Certificate of Insurance available on request for HOA boards and property managers",
                },
              ]}
            />
          </div>
        </div>
      </section>

      {/* Schedule Inspection CTA */}
      <section className="bk-schedule-section">
        <div className="bk-schedule-inner">
          <div className="bk-schedule-card">
            <div className="bk-schedule-brand">
              <div className="bk-schedule-logo-badge">
                <Link to="/"><img src="/images/logo.png" alt="BuzzKill Pest Control" /></Link>
              </div>
              <p className="bk-schedule-tagline">Licensed &amp; Insured</p>
            </div>
            <div className="bk-schedule-content">
              <p className="bk-schedule-eyebrow">Need a Certificate of Insurance?</p>
              <h2 className="bk-schedule-title">We'll Have It To You Within One Business Day</h2>
              <p className="bk-schedule-sub">HOA boards and property managers can request our COI at any time.</p>
              <div className="bk-com-cta-row">
                <a
                  href="mailto:info@pestbuzzkill.com?subject=COI%20Request&body=Hi%20BuzzKill%2C%0A%0AI%20would%20like%20to%20request%20a%20Certificate%20of%20Insurance%20for%20our%20property.%0A%0AProperty%20Name%3A%20%0AProperty%20Address%3A%20%0AContact%20Name%3A%20%0APhone%3A%20%0A%0AThank%20you!"
                  className="bk-btn bk-schedule-cta"
                >
                  Request Certificate of Insurance
                </a>
                <a href="tel:508-258-9294" className="bk-btn bk-btn-outline-light bk-com-talk-btn">
                  Call 508-258-9294
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
