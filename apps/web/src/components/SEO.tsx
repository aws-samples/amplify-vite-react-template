import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const SITE_URL = "https://www.pestbuzzkill.com";
const SITE_NAME = "BuzzKill Pest Control";
const DEFAULT_TITLE =
  "BuzzKill Pest Control | HOA & Condo Pest Control in Massachusetts";
const DEFAULT_DESCRIPTION =
  "Professional pest control for condominiums, HOAs, and shared living communities across Massachusetts and Rhode Island. Common-area pest management and optional in-unit service.";
const DEFAULT_IMAGE = `${SITE_URL}/images/hero-home-1.jpg`;

interface SEOProps {
  title?: string;
  description?: string;
  image?: string;
  type?: string;
  noindex?: boolean;
  jsonLd?: Record<string, unknown> | Record<string, unknown>[];
}

function setMeta(attr: string, key: string, content: string) {
  let el = document.querySelector(`meta[${attr}="${key}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function setLink(rel: string, href: string) {
  let el = document.querySelector(
    `link[rel="${rel}"]`,
  ) as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", rel);
    document.head.appendChild(el);
  }
  el.href = href;
}

const JSON_LD_ID = "bk-jsonld";

export default function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  image = DEFAULT_IMAGE,
  type = "website",
  noindex = false,
  jsonLd,
}: SEOProps) {
  const { pathname } = useLocation();
  const fullTitle = title ? `${title} | ${SITE_NAME}` : DEFAULT_TITLE;
  const canonicalUrl = `${SITE_URL}${pathname === "/" ? "" : pathname}`;
  const fullImage = image.startsWith("http") ? image : `${SITE_URL}${image}`;

  useEffect(() => {
    // Title
    document.title = fullTitle;

    // Core meta
    setMeta("name", "description", description);
    setMeta(
      "name",
      "robots",
      noindex ? "noindex, nofollow" : "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1",
    );

    // Canonical
    setLink("canonical", canonicalUrl);

    // Open Graph
    setMeta("property", "og:type", type);
    setMeta("property", "og:title", fullTitle);
    setMeta("property", "og:description", description);
    setMeta("property", "og:url", canonicalUrl);
    setMeta("property", "og:image", fullImage);
    setMeta("property", "og:image:width", "1200");
    setMeta("property", "og:image:height", "630");
    setMeta("property", "og:site_name", SITE_NAME);
    setMeta("property", "og:locale", "en_US");

    // Twitter Card
    setMeta("name", "twitter:card", "summary_large_image");
    setMeta("name", "twitter:title", fullTitle);
    setMeta("name", "twitter:description", description);
    setMeta("name", "twitter:image", fullImage);

    // Geo meta (local SEO)
    setMeta("name", "geo.region", "US-MA");
    setMeta("name", "geo.placename", "Marlborough, Massachusetts");

    // JSON-LD
    let scriptEl = document.getElementById(JSON_LD_ID) as HTMLScriptElement | null;
    if (jsonLd) {
      const ldArray = Array.isArray(jsonLd) ? jsonLd : [jsonLd];
      const payload = JSON.stringify(
        ldArray.length === 1 ? ldArray[0] : ldArray,
      );
      if (!scriptEl) {
        scriptEl = document.createElement("script");
        scriptEl.id = JSON_LD_ID;
        scriptEl.type = "application/ld+json";
        document.head.appendChild(scriptEl);
      }
      scriptEl.textContent = payload;
    } else if (scriptEl) {
      scriptEl.remove();
    }
  }, [fullTitle, description, canonicalUrl, fullImage, type, noindex, jsonLd]);

  return null;
}

// ── Reusable JSON-LD builders ────────────────────────────────────────

export const ORG_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}/#organization`,
  name: SITE_NAME,
  url: SITE_URL,
  logo: {
    "@type": "ImageObject",
    url: `${SITE_URL}/images/logo.png`,
    width: 184,
    height: 84,
  },
  image: `${SITE_URL}/images/hero-home-1.jpg`,
  description: DEFAULT_DESCRIPTION,
  telephone: "+1-508-258-9294",
  email: "info@pestbuzzkill.com",
  address: {
    "@type": "PostalAddress",
    streetAddress: "420 Lakeside Ave, Suite 104",
    addressLocality: "Marlborough",
    addressRegion: "MA",
    postalCode: "01752",
    addressCountry: "US",
  },
  sameAs: [
    "https://www.instagram.com/buzzkill_pestcontrol/",
    "https://www.facebook.com/people/BuzzKill-Pest-Control/61584954290487/",
    "https://www.linkedin.com/company/buzzkill-pest-control/",
  ],
};

export const LOCAL_BUSINESS_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "PestControlService",
  "@id": `${SITE_URL}/#localbusiness`,
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/images/logo.png`,
  image: `${SITE_URL}/images/hero-home-1.jpg`,
  description:
    "Professional pest control for condominiums, HOAs, and shared living communities. Common-area pest management for boards and property managers with optional discounted in-unit service.",
  telephone: "+1-508-258-9294",
  email: "info@pestbuzzkill.com",
  priceRange: "$$",
  address: {
    "@type": "PostalAddress",
    streetAddress: "420 Lakeside Ave, Suite 104",
    addressLocality: "Marlborough",
    addressRegion: "MA",
    postalCode: "01752",
    addressCountry: "US",
  },
  geo: {
    "@type": "GeoCoordinates",
    latitude: 42.3459,
    longitude: -71.5523,
  },
  areaServed: [
    { "@type": "State", name: "Massachusetts" },
    { "@type": "State", name: "Rhode Island" },
  ],
  openingHoursSpecification: {
    "@type": "OpeningHoursSpecification",
    dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    opens: "07:00",
    closes: "18:00",
  },
  aggregateRating: undefined, // Add when reviews are collected
};

export const WEBSITE_SCHEMA = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${SITE_URL}/#website`,
  url: SITE_URL,
  name: SITE_NAME,
  publisher: { "@id": `${SITE_URL}/#organization` },
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/pest-control/{search_term}`,
    },
    "query-input": "required name=search_term",
  },
};

export function buildFAQSchema(
  items: { q: string; a: string }[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

export function buildServiceSchema(
  name: string,
  description: string,
  url: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    name,
    description,
    url: `${SITE_URL}${url}`,
    provider: { "@id": `${SITE_URL}/#organization` },
    areaServed: [
      { "@type": "State", name: "Massachusetts" },
      { "@type": "State", name: "Rhode Island" },
    ],
    serviceType: "Pest Control",
  };
}

export function buildBreadcrumbSchema(
  items: { name: string; url: string }[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.url}`,
    })),
  };
}

export function buildCitySchema(
  city: string,
  stateAbbr: string,
  state: string,
  slug: string,
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "PestControlService",
    name: `BuzzKill Pest Control - ${city}, ${stateAbbr}`,
    url: `${SITE_URL}/pest-control/${slug}`,
    description: `Professional HOA and condo pest control in ${city}, ${stateAbbr}. Common-area pest management and optional in-unit service for ${city} communities.`,
    telephone: "+1-508-258-9294",
    email: "info@pestbuzzkill.com",
    address: {
      "@type": "PostalAddress",
      streetAddress: "420 Lakeside Ave, Suite 104",
      addressLocality: "Marlborough",
      addressRegion: "MA",
      postalCode: "01752",
      addressCountry: "US",
    },
    areaServed: {
      "@type": "City",
      name: city,
      containedInPlace: {
        "@type": "State",
        name: state,
      },
    },
    parentOrganization: { "@id": `${SITE_URL}/#organization` },
  };
}
