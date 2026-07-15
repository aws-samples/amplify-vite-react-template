/**
 * Default agreement text for new plan templates, and the placeholder
 * substitution used when a quote turns a template's agreement into the
 * customer-specific document that gets sent for signature.
 */

export const DEFAULT_AGREEMENT_BODY = `SERVICE AGREEMENT

This agreement is between BuzzKill Pest Control ("BuzzKill") and {{customerName}} ("Customer").

1. SERVICES. BuzzKill will provide {{planName}} service at {{address}} with visits {{frequency}}, as quoted at {{price}} per month.

2. TERM & BILLING. Recurring plans are billed monthly to the payment method on file until canceled with 30 days' notice.

3. ACCESS. Customer will provide reasonable access to the service areas on scheduled service dates.

4. RE-TREATMENT GUARANTEE. If covered pests return between scheduled visits, BuzzKill will re-treat at no additional charge.

5. CANCELLATION. Either party may cancel with written notice. Charges for services already performed remain due.

By signing below, the Customer agrees to these terms and consents to transact electronically.`;

export type AgreementVars = {
  customerName: string;
  planName: string;
  price: string;
  frequency: string;
  address: string;
};

export function fillAgreementTemplate(
  body: string,
  vars: AgreementVars
): string {
  return body.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const v = vars[key as keyof AgreementVars];
    return v != null && v !== "" ? v : whole;
  });
}

export const FREQUENCY_LABEL: Record<string, string> = {
  MONTHLY: "monthly",
  BIMONTHLY: "every 2 months",
  QUARTERLY: "every 3 months",
};
