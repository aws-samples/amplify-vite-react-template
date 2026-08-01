import { useState } from "react";
import type { AuthUser } from "aws-amplify/auth";
import { client, US_STATES, type UserProfile } from "../lib/client";
import type { Role } from "../lib/auth";

const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Admin",
  PRODUCER: "Producer",
  STAFF: "Staff",
};

interface LicenseDraft {
  state: string;
  licenseNumber: string;
  expirationDate: string;
  residency: "RESIDENT" | "NON_RESIDENT";
}

const emptyLicense = (): LicenseDraft => ({
  state: "",
  licenseNumber: "",
  expirationDate: "",
  residency: "RESIDENT",
});

/**
 * First-login onboarding. Staff onboard with just their name; producers must
 * provide their NPN and at least one state license before entering the CRM.
 *
 * `role` comes from the Cognito group the inviting admin put the user in —
 * it isn't the user's to choose, so what's written to UserProfile.role is a
 * mirror of the real authority rather than a claim.
 */
export default function Onboarding({
  user,
  existing,
  role,
  onComplete,
}: {
  user: AuthUser;
  existing: UserProfile | null;
  role: Role;
  onComplete: (p: UserProfile) => void;
}) {
  const [firstName, setFirstName] = useState(existing?.firstName ?? "");
  const [lastName, setLastName] = useState(existing?.lastName ?? "");
  const [npn, setNpn] = useState(existing?.npn ?? "");
  const [licenses, setLicenses] = useState<LicenseDraft[]>([emptyLicense()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isProducer = role === "PRODUCER";
  const validLicenses = licenses.filter(
    (l) => l.state && l.licenseNumber.trim()
  );

  function setLicense(i: number, patch: Partial<LicenseDraft>) {
    setLicenses((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function submit() {
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are required.");
      return;
    }
    if (isProducer && !npn.trim()) {
      setError("Producers must provide their NPN.");
      return;
    }
    if (isProducer && validLicenses.length === 0) {
      setError("Producers must provide at least one state license.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const email =
        user.signInDetails?.loginId ?? existing?.email ?? "unknown@unknown";
      const payload = {
        userId: user.userId,
        email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role,
        npn: isProducer ? npn.trim() : undefined,
        onboardingComplete: true,
      };
      const { data: profile, errors } = existing
        ? await client.models.UserProfile.update({ id: existing.id, ...payload })
        : await client.models.UserProfile.create(payload);
      if (errors?.length || !profile) throw new Error(errors?.[0]?.message);

      if (isProducer) {
        for (const l of validLicenses) {
          await client.models.License.create({
            holderType: "PRODUCER",
            userProfileId: profile.id,
            holderName: `${firstName.trim()} ${lastName.trim()}`,
            state: l.state,
            licenseNumber: l.licenseNumber.trim(),
            npn: npn.trim() || undefined,
            licenseClass: "PRODUCER",
            residency: l.residency,
            status: "ACTIVE",
            expirationDate: l.expirationDate || undefined,
          });
        }
      }
      onComplete(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="main" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1>Welcome to HOA CRM</h1>
      <p className="sub">Set up your profile to get started.</p>

      <div className="card">
        <div className="form-grid">
          <div className="field">
            <label>First name *</label>
            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div className="field">
            <label>Last name *</label>
            <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </div>
          <div className="field">
            <label>Role</label>
            <input value={ROLE_LABELS[role]} disabled />
            <span className="muted small">
              Set by whoever invited you — ask an admin to change it.
            </span>
          </div>
          {isProducer && (
            <div className="field">
              <label>NPN (National Producer Number) *</label>
              <input value={npn} onChange={(e) => setNpn(e.target.value)} />
            </div>
          )}
        </div>

        {isProducer && (
          <>
            <h3>State licenses *</h3>
            {licenses.map((l, i) => (
              <div className="form-grid" key={i} style={{ marginBottom: 8 }}>
                <div className="field">
                  <label>State</label>
                  <select
                    value={l.state}
                    onChange={(e) => setLicense(i, { state: e.target.value })}
                  >
                    <option value="">—</option>
                    {US_STATES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>License number</label>
                  <input
                    value={l.licenseNumber}
                    onChange={(e) => setLicense(i, { licenseNumber: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label>Residency</label>
                  <select
                    value={l.residency}
                    onChange={(e) =>
                      setLicense(i, {
                        residency: e.target.value as LicenseDraft["residency"],
                      })
                    }
                  >
                    <option value="NON_RESIDENT">Non-resident</option>
                    <option value="RESIDENT">Resident</option>
                  </select>
                </div>
                <div className="field">
                  <label>Expiration</label>
                  <input
                    type="date"
                    value={l.expirationDate}
                    onChange={(e) => setLicense(i, { expirationDate: e.target.value })}
                  />
                </div>
              </div>
            ))}
            <button
              className="secondary"
              onClick={() =>
                setLicenses((ls) => [
                  ...ls,
                  // Additional licenses are non-resident by default — you only
                  // ever hold one resident license.
                  { ...emptyLicense(), residency: "NON_RESIDENT" },
                ])
              }
            >
              + Add another license
            </button>
          </>
        )}

        <div className="form-actions">
          <button className="primary" disabled={saving} onClick={submit}>
            {saving ? "Saving…" : "Complete setup"}
          </button>
          {error && <span className="error-text">{error}</span>}
        </div>
      </div>
    </div>
  );
}
