import { useState } from "react";
import type { Customer } from "../lib/api";
import { AddressAutocompleteInput } from "../lib/addressAutocomplete";
import { Button, ErrorNote, Field } from "../ui/kit";

export type CustomerFormValues = {
  displayName: string;
  contactName: string;
  email: string;
  phone: string;
  serviceStreet: string;
  serviceUnit: string;
  serviceCity: string;
  serviceState: string;
  serviceZip: string;
  propertyClass: string;
  leadSource: string;
  notes: string;
  emailPermission: boolean;
  callPermission: boolean;
  consentEvidence: string;
};

export function customerToForm(c?: Customer | null): CustomerFormValues {
  return {
    displayName: c?.displayName ?? "",
    contactName: c?.contactName ?? "",
    email: c?.email ?? "",
    phone: c?.phone ?? "",
    serviceStreet: c?.serviceStreet ?? "",
    serviceUnit: c?.serviceUnit ?? "",
    serviceCity: c?.serviceCity ?? "",
    serviceState: c?.serviceState ?? "MA",
    serviceZip: c?.serviceZip ?? "",
    propertyClass: c?.propertyClass ?? "",
    leadSource: c?.leadSource ?? "",
    notes: c?.notes ?? "",
    emailPermission: (c?.contactConsentChannels ?? []).includes("EMAIL"),
    callPermission: (c?.contactConsentChannels ?? []).includes("CALL"),
    consentEvidence: c?.contactConsentText ?? "",
  };
}

/** Shared create/edit form for leads and customers. */
export default function CustomerForm({
  initial,
  submitLabel,
  showLeadSource,
  showLeadConsent,
  onSubmit,
}: {
  initial: CustomerFormValues;
  submitLabel: string;
  showLeadSource?: boolean;
  showLeadConsent?: boolean;
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
    if (
      showLeadConsent &&
      (values.emailPermission || values.callPermission) &&
      !values.consentEvidence.trim()
    ) {
      setError("Record the exact evidence authorizing each selected contact channel. Contact details alone are not permission.");
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
        <AddressAutocompleteInput
          value={values.serviceStreet}
          autoComplete="street-address"
          onChangeText={(text) =>
            setValues((v) => ({ ...v, serviceStreet: text }))
          }
          onResolved={(a) =>
            setValues((v) => ({
              ...v,
              serviceStreet: a.street,
              serviceCity: a.city || v.serviceCity,
              serviceState: a.state || v.serviceState,
              serviceZip: a.zip || v.serviceZip,
            }))
          }
        />
      </Field>
      {/* Its own field on purpose: a unit is not geocodable, so typing it into
          the street line ("290 Eliot St, Unit 289") makes the address
          unresolvable to Google Routes — which silently makes the technician's
          whole day unbookable. Routing uses street/city/state/zip only. */}
      <Field label="Unit / apt / suite (optional)" hint="Kept out of routing — the technician still sees it.">
        <input
          value={values.serviceUnit}
          autoComplete="address-line2"
          onChange={set("serviceUnit")}
          placeholder="289"
        />
      </Field>
      <div className="form-row-3">
        <Field label="City">
          <input value={values.serviceCity} onChange={set("serviceCity")} />
        </Field>
        <Field label="State">
          <input
            value={values.serviceState}
            onChange={set("serviceState")}
            maxLength={2}
            style={{ textTransform: "uppercase" }}
          />
        </Field>
        <Field label="ZIP">
          <input inputMode="numeric" value={values.serviceZip} onChange={set("serviceZip")} />
        </Field>
      </div>
      <Field
        label="Property type"
        hint="Sets on-site time, capacity, and pricing. New visits inherit this."
      >
        <select
          value={values.propertyClass}
          onChange={(e) =>
            setValues((v) => ({ ...v, propertyClass: e.target.value }))
          }
        >
          <option value="">Not set</option>
          <option value="RESIDENTIAL">Residential</option>
          <option value="COMMERCIAL">Commercial</option>
          <option value="COMMUNITY">Community (HOA / multi-unit)</option>
        </select>
      </Field>
      {showLeadSource ? (
        <Field label="Lead source">
          <input value={values.leadSource} onChange={set("leadSource")} placeholder="Website, referral, Thumbtack…" />
        </Field>
      ) : null}
      {showLeadConsent ? (
        <>
          <label className="inline-check small">
            <input
              type="checkbox"
              checked={values.emailPermission}
              onChange={(e) =>
                setValues((v) => ({ ...v, emailPermission: e.target.checked }))
              }
            />{" "}
            Customer authorized a non-essential email response
          </label>
          <label className="inline-check small">
            <input
              type="checkbox"
              checked={values.callPermission}
              onChange={(e) =>
                setValues((v) => ({ ...v, callPermission: e.target.checked }))
              }
            />{" "}
            Customer authorized a phone call
          </label>
          {values.emailPermission || values.callPermission ? (
            <Field
              label="Contact-permission evidence"
              hint="Exact retained permission and source for the selected channels. This never authorizes text messages."
            >
              <textarea value={values.consentEvidence} onChange={set("consentEvidence")} />
            </Field>
          ) : (
            <p className="muted small">Non-essential email, call, and text actions stay disabled until exact permission is retained.</p>
          )}
        </>
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
