import { AGENCY, AGENCY_FMT } from "../../shared/agency";

export const PHONE = AGENCY.phone;
export const PHONE_HREF = AGENCY_FMT.phoneHref;
export const EMAIL = AGENCY.email;
export const EMAIL_HREF = AGENCY_FMT.emailHref;
export const ADDRESS_LINE1 = AGENCY.addressLine1;
export const ADDRESS_LINE2 = AGENCY_FMT.addressLine2;
export const QUOTE_URL = "/quote";
export const FORMSUBMIT_URL = AGENCY_FMT.formsubmitUrl;

export const SOCIAL = {
  instagram: "https://www.instagram.com/hoainsuranceagency",
  facebook: "https://www.facebook.com/people/HOA-Insurance-Agency/61575377498498/",
  linkedin: "https://www.linkedin.com/company/hoa-insurance-agency",
};

export const NAV_LINKS = [
  { label: "Home", path: "/" },
  { label: "About Us", path: "/about-us" },
  { label: "HOA Insurance", path: "/what-we-do" },
  { label: "Why Choose Us", path: "/why-choose-us" },
  { label: "Contact", path: "/#contact" },
];
