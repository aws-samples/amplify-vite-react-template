import { useState } from "react";
import type { Customer } from "../lib/api";
import { Button, ErrorNote, Field } from "../ui/kit";

export type CustomerFormValues = {
  displayName: string;
  contactName: string;
  email: string;
  phone: string;
  serviceStreet: string;
  serviceCity: string;
  serviceState: string;
  serviceZip: string;
  leadSource: string;
  notes: string;
};

export function customerToForm(c?: Customer | null): CustomerFormValues {
  return {
    displayName: c?.displayName ?? "",
    contactName: c?.contactName ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    serviceStreet: c?.serviceStreet ?? "",
    serviceCity: c?.serviceCity ?? "",
    serviceState: c?.serviceState ?? "MA",
    serviceZip: c?.serviceZip ?? "",
    leadSource: c?.leadSource ?? "",
    notes: c?.notes ?? "",
  };
}

/** Shared create/edit form for leads and customers. */
export default function CustomerForm({
  initial,
  submitLabel,
  showLeadSource,
  onSubmit,
}: {
  initial: CustomerFormValues;
  submitLabel: string;
  showLeadSource?: boolean;
  onSubmit: (values: CustomerFormValues) => Promise<void>;
}) {
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof CustomerFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setValues((v) => ({ ...v, [k]: e.target.value }));

  const submit = async () => {
    if (!values.displayName.trim()) {
      setError("Name is required");
      return;
    }
    if (values.email && !/^\S+@\S+\.\S+$/.test(values.email)) {
      setError("Email doesn't look valid");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <Field label="Name (person or company)">
        <input value={values.displayName} onChange={set("displayName")} placeholder="Maple Ridge Condominiums" />
      </Field>
      <Field label="Contact person" hint="If the name above is a company">
        <input value={values.contactName} onChange={set("contactName")} placeholder="Jane Smith" />
      </Field>
      <div className="form-row-2">
        <Field label="Email">
          <input type="email" inputMode="email" value={values.email} onChange={set("email")} />
        </Field>
        <Field label="Phone">
          <input type="tel" inputMode="tel" value={values.phone} onChange={set("phone")} placeholder="+14135551234" />
        </Field>
      </div>
      <Field label="Service street address">
        <input value={values.serviceStreet} onChange={set("serviceStreet")} />
      </Field>
      <div className="form-row-2">
        <Field label="City">
          <input value={values.serviceCity} onChange={set("serviceCity")} />
        </Field>
        <Field label="ZIP">
          <input inputMode="numeric" value={values.serviceZip} onChange={set("serviceZip")} />
        </Field>
      </div>
      {showLeadSource ? (
        <Field label="Lead source">
          <input value={values.leadSource} onChange={set("leadSource")} placeholder="Website, referral, Thumbtack…" />
        </Field>
      ) : null}
      <Field label="Notes">
        <textarea value={values.notes} onChange={set("notes")} />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void submit()}>
        {submitLabel}
      </Button>
    </div>
  );
}
