import {
  OFFICE_EMAIL,
  OFFICE_MAILTO,
  OFFICE_PHONE_PRETTY,
  OFFICE_TEL,
} from "../lib/contactInfo";

/**
 * The reach-us-directly line that closes every public form. Both channels are
 * live links, so a phone opens the dialer and the address opens a compose
 * window instead of asking the visitor to retype either one.
 */
export default function FormContactFooter({
  className = "",
  lead = "Prefer to reach us directly?",
}: {
  className?: string;
  lead?: string;
}) {
  return (
    <p className={`bk-form-contacts ${className}`.trim()}>
      {lead}{" "}
      <a href={OFFICE_TEL}>{OFFICE_PHONE_PRETTY}</a>
      <span className="bk-form-contacts__sep" aria-hidden="true">
        ·
      </span>
      <a href={OFFICE_MAILTO}>{OFFICE_EMAIL}</a>
    </p>
  );
}
