import { useEffect, useMemo, useState } from "react";
import {
  client,
  fmtDate,
  friendlyError,
  type License,
  type ProducerLicense,
  type UserProfile,
} from "../../lib/client";
import { SaveStatus, useSaveStatus } from "../SaveStatus";

/**
 * One-time migration of the deprecated ProducerLicense rows (captured at
 * onboarding before this system existed) into the unified License table.
 *
 * Idempotent: a legacy row is skipped when a License already exists for the
 * same holder + state + number, so re-running can't create duplicates. The
 * card hides itself entirely once there's nothing left to migrate, and the
 * legacy rows are left in place rather than deleted — nothing is destroyed.
 */
export default function LegacyBackfill({
  licenses,
  profiles,
  onMigrated,
}: {
  licenses: License[];
  profiles: UserProfile[];
  onMigrated: (created: License[]) => void;
}) {
  const [legacy, setLegacy] = useState<ProducerLicense[] | null>(null);
  // `result` was one severity-free string printed green in the all-done card
  // and red in the form actions, with each site guessing severity from
  // `pending.length` — so a clean import could render red and the failed half
  // of a partial one could render green. The state now carries its own
  // severity and both sites render the same value the same way.
  const importStatus = useSaveStatus();
  const [error, setError] = useState("");

  useEffect(() => {
    client.models.ProducerLicense.list()
      .then(({ data }) => setLegacy(data))
      .catch((e) => {
        // An empty list hides this card, so a failed read would look exactly
        // like "nothing left to migrate" — and the import never gets offered.
        setLegacy([]);
        setError(friendlyError(e, "Failed to load legacy licenses"));
      });
  }, []);

  const key = (userProfileId: unknown, state: unknown, num: unknown) =>
    `${userProfileId ?? ""}|${state ?? ""}|${String(num ?? "").trim().toUpperCase()}`;

  const pending = useMemo(() => {
    if (!legacy) return [];
    const have = new Set(
      licenses
        .filter((l) => l.holderType === "PRODUCER")
        .map((l) => key(l.userProfileId, l.state, l.licenseNumber))
    );
    return legacy.filter(
      (l) => !have.has(key(l.userProfileId, l.state, l.licenseNumber))
    );
  }, [legacy, licenses]);

  const attempted = pending.length;

  async function run() {
    setError("");
    await importStatus.run(
      async () => {
        const created: License[] = [];
        let failed = 0;
        for (const l of pending) {
          const holder = profiles.find((p) => p.id === l.userProfileId);
          try {
            const { data, errors } = await client.models.License.create({
              holderType: "PRODUCER",
              userProfileId: l.userProfileId,
              holderName: holder ? `${holder.firstName} ${holder.lastName}` : null,
              state: l.state,
              licenseNumber: l.licenseNumber,
              npn: holder?.npn ?? null,
              licenseClass: "PRODUCER",
              // Unknowable from the legacy row — left blank rather than guessed.
              residency: null,
              status: "ACTIVE",
              expirationDate: l.expirationDate ?? null,
              linesOfAuthority: (l.linesOfAuthority ?? []).filter(
                (x): x is string => !!x
              ),
              notes: "Migrated from the original onboarding license record.",
            });
            if (errors?.length || !data) failed++;
            else created.push(data);
          } catch {
            failed++;
          }
        }
        onMigrated(created);
        // Some rows failed ⇒ partial success ⇒ amber, carrying both halves of
        // the sentence. None failed ⇒ clean success ⇒ green `savedMessage`.
        return failed
          ? `Migrated ${created.length} license${created.length === 1 ? "" : "s"}.` +
              ` ${failed} failed — re-run to retry just those.`
          : "";
      },
      {
        // Every attempted row landed, so `attempted` is the count migrated.
        savedMessage: `Migrated ${attempted} license${attempted === 1 ? "" : "s"}.`,
        errorMessage: "Import failed",
      }
    );
  }

  if (legacy === null) return null; // still loading
  if (pending.length === 0) {
    if (error) {
      return (
        <div className="card">
          <p className="error-text" style={{ margin: 0 }}>
            Couldn't check onboarding for licenses to import: {error}
          </p>
        </div>
      );
    }
    // Nothing outstanding: show the confirmation once, then stay hidden.
    // Reaching zero pending means every attempted row landed, so this branch
    // can only ever be the "saved" state — the green rule is now a fact about
    // the state, not a guess made from `pending.length`.
    return importStatus.status.state !== "idle" ? (
      <div className="card" style={{ borderLeft: "4px solid var(--green)" }}>
        <p className="small" style={{ margin: 0 }}>
          <SaveStatus {...importStatus.status} /> Legacy records were left
          untouched as a backup.
        </p>
      </div>
    ) : null;
  }

  return (
    <div className="card" style={{ borderLeft: "4px solid var(--accent-dark)" }}>
      <h2 style={{ marginTop: 0 }}>Import licenses from onboarding</h2>
      <p className="muted small">
        {pending.length} license{pending.length === 1 ? "" : "s"} captured
        during onboarding {pending.length === 1 ? "hasn't" : "haven't"} been
        brought into licensing yet. Importing copies{" "}
        {pending.length === 1 ? "it" : "them"} over — the original record
        {pending.length === 1 ? " is" : "s are"} left in place, and running
        this twice can't create duplicates.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Holder</th>
              <th>State</th>
              <th>License #</th>
              <th>Expires</th>
            </tr>
          </thead>
          <tbody>
            {pending.map((l) => {
              const holder = profiles.find((p) => p.id === l.userProfileId);
              return (
                <tr key={l.id}>
                  <td>
                    {holder ? `${holder.firstName} ${holder.lastName}` : "(unknown)"}
                  </td>
                  <td>{l.state}</td>
                  <td style={{ fontVariantNumeric: "tabular-nums" }}>
                    {l.licenseNumber}
                  </td>
                  <td className="small">{fmtDate(l.expirationDate)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={importStatus.busy} onClick={run}>
          {importStatus.busy
            ? "Importing…"
            : `Import ${pending.length} license${pending.length === 1 ? "" : "s"}`}
        </button>
        {/* Partial failures leave rows pending, so surface the outcome here
            too — not only in the all-done state above. Same value, same
            severity, both places. */}
        <SaveStatus {...importStatus.status} />
        {error && <span className="error-text">{error}</span>}
      </div>
      <p className="muted small">
        Residency isn't recorded on the old rows, so it's left blank — set it
        on each license afterward.
      </p>
    </div>
  );
}
