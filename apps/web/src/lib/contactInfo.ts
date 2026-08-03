/**
 * The office's public contact details, in one place.
 *
 * Every public form ends with these two, clickable: a form is the slow path,
 * and someone who does not want to fill one in should never have to hunt for
 * the phone number or the inbox. The address is the same one the footer, the
 * schema.org markup, and the legal pages publish, so a visitor is never given
 * two different "real" addresses for the same company.
 */
export const OFFICE_PHONE = "508-258-9294";
export const OFFICE_PHONE_PRETTY = "(508) 258-9294";
export const OFFICE_TEL = `tel:+1${OFFICE_PHONE.replace(/\D/g, "")}`;
export const OFFICE_EMAIL = "info@pestbuzzkill.com";
export const OFFICE_MAILTO = `mailto:${OFFICE_EMAIL}`;
