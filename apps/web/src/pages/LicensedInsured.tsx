import SEO, { buildBreadcrumbSchema } from "../components/SEO";

const VERIFY_MA =
  "https://www.mass.gov/how-to/look-up-and-confirm-a-massachusetts-pesticide-license";
const VERIFY_RI = "https://demri.my.site.com/agr/s/";

const ShieldIcon = () => (
  <svg
    width="28"
    height="28"
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
    width="28"
    height="28"
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
    width="28"
    height="28"
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
    <div
      className="bk-credential"
      style={{
        background: "var(--bk-white)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-lg)",
        padding: "28px 28px 24px",
        borderTop: accent
          ? "4px solid var(--bk-green)"
          : "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          color: accent ? "var(--bk-green-deep)" : "var(--fg1)",
        }}
      >
        {icon}
        <h3
          className="bk-h4"
          style={{ margin: 0, textTransform: "none", letterSpacing: 0 }}
        >
          {title}
        </h3>
      </div>

      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "6px 16px",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {details.map((d, i) => (
          <div key={i} style={{ display: "contents" }}>
            <dt
              style={{
                fontWeight: 700,
                color: "var(--fg2)",
                fontSize: 12,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                paddingTop: 2,
              }}
            >
              {d.label}
            </dt>
            <dd style={{ margin: 0, color: "var(--fg1)" }}>{d.value}</dd>
          </div>
        ))}
      </dl>

      {verifyUrl && (
        <div style={{ marginTop: 20 }}>
          <a
            href={verifyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bk-btn bk-btn-outline"
            style={{ fontSize: 13, padding: "8px 18px" }}
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
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
              gap: 24,
              marginTop: 32,
            }}
          >
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
                  value: (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>
                      Active
                    </span>
                  ),
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
                  value: (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>
                      Active
                    </span>
                  ),
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
                  value: (
                    <span style={{ color: "var(--success)", fontWeight: 700 }}>
                      Active
                    </span>
                  ),
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

      {/* COI CTA */}
      <section className="bk-section bk-section-dark">
        <div className="bk-container bk-narrow bk-center">
          <h2 className="bk-h2 bk-on-dark">
            Need a Certificate of Insurance?
          </h2>
          <p className="bk-body-lead bk-on-dark-soft">
            HOA boards and property managers can request our COI at any time.
            We&rsquo;ll have it to you within one business day.
          </p>
          <div
            style={{
              display: "flex",
              gap: 14,
              justifyContent: "center",
              flexWrap: "wrap",
              marginTop: 24,
            }}
          >
            <a
              href="mailto:info@pestbuzzkill.com?subject=COI%20Request&body=Hi%20BuzzKill%2C%0A%0AI%20would%20like%20to%20request%20a%20Certificate%20of%20Insurance%20for%20our%20property.%0A%0AProperty%20Name%3A%20%0AProperty%20Address%3A%20%0AContact%20Name%3A%20%0APhone%3A%20%0A%0AThank%20you!"
              className="bk-btn bk-btn-primary"
            >
              Request Certificate of Insurance
            </a>
            <a href="tel:508-258-9294" className="bk-btn bk-btn-outline-light">
              Call 508-258-9294
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
