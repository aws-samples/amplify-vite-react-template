import ComingSoon from "./ComingSoon";
import SEO, { buildBreadcrumbSchema } from "../components/SEO";

export default function Careers() {
  return (
    <>
      <SEO
        title="Careers at BuzzKill Pest Control"
        description="Join the BuzzKill Pest Control team. Explore careers building New England's most trusted pest control and property protection company across Massachusetts and Rhode Island."
        jsonLd={buildBreadcrumbSchema([
          { name: "Home", url: "/" },
          { name: "Careers", url: "/careers" },
        ])}
      />
      <ComingSoon
        title="Join the BuzzKill Team"
        subtitle="We're building New England's most trusted property protection company. Come build it with us."
      />
    </>
  );
}
