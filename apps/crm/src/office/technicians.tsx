import { useCallback, useEffect, useState } from "react";
import {
  api,
  listAll,
  opResult,
  saveTechnicianLicense,
  setLicenseStatus,
  STAFF_OFFBOARD_REASONS,
  unwrap,
  type Technician,
  type TechnicianLicenseRecord,
} from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRoles } from "../lib/auth";
import { fmtDate, todayEastern } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Sheet,
  Spinner,
} from "../ui/kit";

/**
 * Technician records and their applicator licences — the office-side profiles
 * that drive routing and compliance. Managed from the owner-only Staff area
 * (their CRM logins live in the staff roster on the same page); the Schedule
 * board only reads these to build routes, it no longer edits them.
 */

/** Why a technician can't be dispatched on `workDate`, or null when compliant. */
export function technicianComplianceIssue(
  technician: Technician,
  workDate: string
): string | null {
  if (!technician.licenseNumber?.trim()) return "license number missing";
  if (!technician.licenseExpiresOn) return "license expiration missing";
  if (technician.licenseExpiresOn < workDate) {
    return `license expired ${fmtDate(technician.licenseExpiresOn, true)}`;
  }
  return null;
}

/**
 * The owner-only technician list: add a technician, edit one, and reach its
 * licence history and offboarding. Rendered inside the Staff page so every
 * staff-facing profile — logins above, field technicians here — lives in one
 * place.
 */
export function TechnicianRoster() {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Technician | null>(null);

  const { data, error, reload } = useAsync<Technician[]>(
    async () => {
      const all = await listAll((t) =>
        api().models.Technician.list({ limit: 200, nextToken: t })
      );
      // Active first, then by name — the same order the Schedule board reads
      // them in, so the two lists never feel like different rosters.
      return [...all].sort(
        (a, b) =>
          Number(!!b.active) - Number(!!a.active) ||
          (a.name ?? "").localeCompare(b.name ?? "")
      );
    },
    [],
    "Could not load technicians"
  );
  // A failed load used to fall through to the empty state beside its error,
  // rather than spinning forever — keep that.
  const techs = data ?? (error ? [] : null);

  return (
    <Card
      title="Technicians"
      actions={
        <Button small variant="ghost" onClick={() => setAdding(true)}>
          + Tech
        </Button>
      }
    >
      <p className="muted small" style={{ marginBottom: 6 }}>
        Field technicians and their applicator licences. A technician needs a
        current licence before they can be activated or assigned; invite their
        CRM login from the staff roster above.
      </p>
      <ErrorNote error={error} />
      {techs === null ? (
        <Spinner label="Loading technicians…" />
      ) : techs.length === 0 ? (
        <EmptyState
          title="No technicians yet"
          body="Add your first technician to start building routes on the Schedule."
          action={<Button onClick={() => setAdding(true)}>Add technician</Button>}
        />
      ) : (
        techs.map((tech) => {
          const issue = technicianComplianceIssue(tech, todayEastern());
          return (
            <ListRow
              key={tech.id}
              title={
                <span>
                  {tech.name}{" "}
                  {!tech.active ? <Badge tone="danger">inactive</Badge> : null}
                </span>
              }
              subtitle={
                [tech.email, tech.phone].filter(Boolean).join(" · ") || undefined
              }
              meta={
                <>
                  {issue ? (
                    <Badge tone="warn">{issue}</Badge>
                  ) : (
                    <Badge tone="ok">licence current</Badge>
                  )}
                  <Button small variant="ghost" onClick={() => setEditing(tech)}>
                    Edit
                  </Button>
                </>
              }
              onClick={() => setEditing(tech)}
            />
          );
        })
      )}

      <Sheet open={adding} onClose={() => setAdding(false)} title="New technician">
        {adding ? (
          <TechForm
            onDone={async () => {
              setAdding(false);
              reload();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit technician"
      >
        {editing ? (
          <TechForm
            existing={editing}
            onDone={async () => {
              setEditing(null);
              reload();
            }}
          />
        ) : null}
      </Sheet>
    </Card>
  );
}

/**
 * GL-17 — a technician's one-to-many licence records: full history always
 * visible, office adds renewals with evidence, and only an owner (the
 * Compliance seat) flips a record's status. The single legacy licence fields
 * remain the fallback until a technician has records.
 */
function LicenseRecords({ technicianId }: { technicianId: string }) {
  const roles = useRoles();
  const [records, setRecords] = useState<TechnicianLicenseRecord[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [number, setNumber] = useState("");
  const [licenseType, setLicenseType] = useState("");
  const [issuer, setIssuer] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await (
        api().models as unknown as {
          TechnicianLicense: {
            listTechnicianLicenseByTechnicianId: (
              q: { technicianId: string },
              o: { limit: number }
            ) => Promise<{ data: TechnicianLicenseRecord[] }>;
          };
        }
      ).TechnicianLicense.listTechnicianLicenseByTechnicianId(
        { technicianId },
        { limit: 100 }
      );
      setRecords(res.data ?? []);
    } catch {
      setRecords([]);
    }
  }, [technicianId]);

  useEffect(() => {
    void load();
  }, [load]);

  const addRecord = async () => {
    if (!number.trim()) {
      setError("The licence number is required");
      return;
    }
    setBusy("add");
    setError(null);
    try {
      const res = await saveTechnicianLicense({
        technicianId,
        number: number.trim(),
        licenseType: licenseType.trim() || undefined,
        issuer: issuer.trim() || undefined,
        expiresOn: expiresOn || undefined,
        evidenceNote: evidenceNote.trim() || undefined,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      setNumber("");
      setLicenseType("");
      setIssuer("");
      setExpiresOn("");
      setEvidenceNote("");
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the licence");
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async (rec: TechnicianLicenseRecord, status: string) => {
    const reason = window.prompt(
      `Set licence ${rec.number} to ${status.toLowerCase()} — why? (recorded)`
    );
    if (!reason?.trim()) return;
    setBusy(rec.id);
    setError(null);
    try {
      const res = await setLicenseStatus({
        licenseId: rec.id,
        status,
        reason: reason.trim(),
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the status");
    } finally {
      setBusy(null);
    }
  };

  const statusTone = (s: string): "ok" | "warn" | "danger" | "muted" =>
    s === "CURRENT" ? "ok" : s === "PENDING" ? "warn" : "danger";

  return (
    <Field
      group
      label="Licence records"
      hint="Full history stays visible. New records start pending until an owner marks them current — that is what makes the technician dispatchable."
    >
      {records === null ? (
        <Spinner />
      ) : records.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          No licence records yet — the single licence fields above still apply
          until the first record is added.
        </p>
      ) : (
        records.map((r) => (
          <ListRow
            key={r.id}
            title={`${r.number}${r.licenseType ? ` · ${r.licenseType}` : ""}`}
            subtitle={[
              r.issuer,
              r.expiresOn ? `expires ${r.expiresOn}` : null,
              r.evidenceNote ? `evidence: ${r.evidenceNote}` : null,
              r.statusSetBy ? `status by ${r.statusSetBy}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            meta={
              <>
                <Badge tone={statusTone(r.status)}>{r.status.toLowerCase()}</Badge>
                {roles.owner && r.status !== "CURRENT" ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busy === r.id}
                    onClick={() => void changeStatus(r, "CURRENT")}
                  >
                    Mark current
                  </Button>
                ) : null}
                {roles.owner && r.status === "CURRENT" ? (
                  <Button
                    small
                    variant="ghost"
                    loading={busy === r.id}
                    onClick={() => void changeStatus(r, "REVOKED")}
                  >
                    Revoke
                  </Button>
                ) : null}
              </>
            }
          />
        ))
      )}
      {!adding ? (
        <Button small variant="ghost" onClick={() => setAdding(true)}>
          + Add licence / renewal
        </Button>
      ) : (
        <>
          <div className="form-row-2">
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="Licence number"
            />
            <input
              value={licenseType}
              onChange={(e) => setLicenseType(e.target.value)}
              placeholder="Type (e.g. applicator)"
            />
          </div>
          <div className="form-row-2">
            <input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="Issuer (MA / RI)"
            />
            <input
              type="date"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </div>
          <input
            value={evidenceNote}
            onChange={(e) => setEvidenceNote(e.target.value)}
            placeholder="Evidence (document ref, where it's filed)"
          />
          <Button small loading={busy === "add"} onClick={() => void addRecord()}>
            Save licence record
          </Button>
        </>
      )}
      <ErrorNote error={error} />
    </Field>
  );
}

function TechForm({
  existing,
  onDone,
}: {
  existing?: Technician | null;
  onDone: () => Promise<void>;
}) {
  const roles = useRoles();
  const [name, setName] = useState(existing?.name ?? "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [phone, setPhone] = useState(existing?.phone ?? "");
  const [licenseNumber, setLicenseNumber] = useState(
    existing?.licenseNumber ?? ""
  );
  const [licenseExpiresOn, setLicenseExpiresOn] = useState(
    existing?.licenseExpiresOn ?? ""
  );
  // GL-04: the technician's PRIVATE travel base (office-only; the field app
  // never sees it). Empty = routes from HQ.
  const [baseStreet, setBaseStreet] = useState(
    (existing as { baseStreet?: string | null } | null | undefined)?.baseStreet ?? ""
  );
  const [baseCity, setBaseCity] = useState(
    (existing as { baseCity?: string | null } | null | undefined)?.baseCity ?? ""
  );
  const [baseState, setBaseState] = useState(
    (existing as { baseState?: string | null } | null | undefined)?.baseState ?? ""
  );
  const [baseZip, setBaseZip] = useState(
    (existing as { baseZip?: string | null } | null | undefined)?.baseZip ?? ""
  );
  const [invite, setInvite] = useState(!existing);
  // A technician saved on an earlier attempt whose invite then failed — reused
  // on retry so every attempt doesn't leave another Technician record behind.
  const [createdTechId, setCreatedTechId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // GL-14: the Schedule entrance to offboarding carries the same controlled
  // reason and stable idempotency key the Staff entrance does, and shows the
  // PERSISTED outcome — never an assumed success.
  const [offboardOpen, setOffboardOpen] = useState(false);
  const [offboardReason, setOffboardReason] = useState<string>(
    STAFF_OFFBOARD_REASONS[0]
  );
  const [offboardNote, setOffboardNote] = useState("");
  const [offboardKey, setOffboardKey] = useState<string>(() =>
    globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}`
  );
  const [offboardOutcome, setOffboardOutcome] = useState<{
    outcome?: string;
    effects?: string | null;
    nextStep?: string | null;
    inProgress?: boolean;
  } | null>(null);
  // adminCreateUser is OWNER-only server-side (deliberately — invites are what
  // keep the role split real). Offering the checkbox to office staff meant the
  // record saved, the invite errored, and the error taught them errors are normal.
  const sendInvite = !existing && roles.owner && invite;

  const runOffboard = async () => {
    if (!existing) return;
    if (offboardReason === "OTHER" && !offboardNote.trim()) {
      setError("Choosing 'Other' needs a short note saying why.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api().mutations.deactivateTechnician({
        technicianId: existing.id,
        reasonCode: offboardReason,
        note: offboardNote.trim() || undefined,
        idempotencyKey: offboardKey,
      });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      const data = opResult<{
        outcome?: string;
        effects?: string | null;
        nextStep?: string | null;
        inProgress?: boolean;
        jobsUnassigned?: number;
      }>(res);
      if (data && (data.inProgress || data.outcome !== "COMPLETE")) {
        // The persisted partial/in-progress outcome, with its one next step —
        // the same key resumes it.
        setOffboardOutcome(data);
        setBusy(false);
        return;
      }
      await onDone();
      const n = data?.jobsUnassigned ?? 0;
      window.alert(
        `${existing.name} offboarded.${
          n > 0
            ? ` ${n} job${n === 1 ? " is" : "s are"} back in the scheduling pool and need${n === 1 ? "s" : ""} reassigning on the Schedule board.`
            : ""
        }`
      );
    } catch (err) {
      // A refusal changed nothing; a fresh key lets a corrected request start
      // clean.
      setOffboardKey(globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}`);
      setError(err instanceof Error ? err.message : "Could not offboard technician");
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email" hint="Needed for their CRM login">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Field label="Phone">
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <div className="form-row-2">
        <Field
          label="Applicator license #"
          hint="Required before this technician can be active or assigned"
        >
          <input
            value={licenseNumber}
            onChange={(e) => setLicenseNumber(e.target.value)}
            placeholder="MA-12345"
          />
        </Field>
        <Field label="License expires">
          <input
            type="date"
            value={licenseExpiresOn}
            onChange={(e) => setLicenseExpiresOn(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Travel base (private)"
        hint="Where their day starts and ends — drives capacity and routing. Office-only; blank = HQ."
      >
        <div className="form-row-2">
          <input
            placeholder="Street"
            value={baseStreet}
            onChange={(e) => setBaseStreet(e.target.value)}
          />
          <input
            placeholder="City"
            value={baseCity}
            onChange={(e) => setBaseCity(e.target.value)}
          />
        </div>
        <div className="form-row-2">
          <input
            placeholder="State (MA/RI)"
            value={baseState}
            onChange={(e) => setBaseState(e.target.value)}
          />
          <input
            placeholder="ZIP"
            value={baseZip}
            onChange={(e) => setBaseZip(e.target.value)}
          />
        </div>
      </Field>
      {!existing ? (
        roles.owner ? (
          <label className="row-split" style={{ fontSize: 14 }}>
            <span>Email them a CRM login invite</span>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={invite}
              onChange={(e) => setInvite(e.target.checked)}
            />
          </label>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Ask the owner to send their CRM login invite — staff invites are
            owner-only.
          </p>
        )
      ) : null}
      <ErrorNote error={error} />
      <Button
        block
        loading={busy}
        onClick={() => {
          if (!name.trim()) {
            setError("Name is required");
            return;
          }
          if (sendInvite && !email.trim()) {
            setError("Email is required to send a login invite");
            return;
          }
          if (!licenseNumber.trim() || !licenseExpiresOn) {
            setError(
              "Applicator license number and expiration date are required before activation"
            );
            return;
          }
          setBusy(true);
          (async () => {
            if (existing) {
              opResult(
                await api().mutations.saveTechnician({
                  technicianId: existing.id,
                  name: name.trim(),
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  active: true,
                  licenseNumber: licenseNumber.trim(),
                  licenseExpiresOn,
                  baseStreet: baseStreet.trim() || undefined,
                  baseCity: baseCity.trim() || undefined,
                  baseState: baseState.trim() || undefined,
                  baseZip: baseZip.trim() || undefined,
                })
              );
              await onDone();
              return;
            }
            // Retry after a failed invite updates the already-saved record
            // instead of creating a duplicate technician per attempt.
            let technicianId = createdTechId;
            if (technicianId) {
              opResult(
                await api().mutations.saveTechnician({
                  technicianId,
                  name: name.trim(),
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  active: true,
                  licenseNumber: licenseNumber.trim(),
                  licenseExpiresOn,
                  baseStreet: baseStreet.trim() || undefined,
                  baseCity: baseCity.trim() || undefined,
                  baseState: baseState.trim() || undefined,
                  baseZip: baseZip.trim() || undefined,
                })
              );
            } else {
              const saved = opResult<{ technicianId?: string }>(
                await api().mutations.saveTechnician({
                  name: name.trim(),
                  email: email.trim() || undefined,
                  phone: phone.trim() || undefined,
                  active: true,
                  licenseNumber: licenseNumber.trim(),
                  licenseExpiresOn,
                  baseStreet: baseStreet.trim() || undefined,
                  baseCity: baseCity.trim() || undefined,
                  baseState: baseState.trim() || undefined,
                  baseZip: baseZip.trim() || undefined,
                })
              );
              technicianId = saved?.technicianId ?? null;
              if (!technicianId) throw new Error("Could not save technician");
              setCreatedTechId(technicianId);
            }
            if (sendInvite && technicianId) {
              try {
                unwrap(
                  await api().mutations.adminCreateUser({
                    email: email.trim(),
                    name: name.trim(),
                    roles: ["TECH"],
                    technicianId,
                  })
                );
              } catch (err) {
                // The technician exists; only the login invite failed. Say
                // exactly that, so retrying (which reuses the record) is the
                // obvious move.
                throw new Error(
                  `Technician saved, but the login invite failed: ${err instanceof Error ? err.message : String(err)}`
                );
              }
            }
            await onDone();
          })().catch((err) => {
            setError(err.message ?? "Could not save technician");
            setBusy(false);
          });
        }}
      >
        {existing ? "Save technician" : "Add technician"}
      </Button>
      {existing ? <LicenseRecords technicianId={existing.id} /> : null}
      {existing ? (
        roles.owner ? (
          offboardOutcome ? (
            <Card>
              <p style={{ margin: 0 }}>
                <Badge tone="warn">
                  {offboardOutcome.inProgress
                    ? "already in progress"
                    : "did not fully finish"}
                </Badge>
              </p>
              <p className="small" style={{ marginTop: 8 }}>
                {offboardOutcome.effects ??
                  "The offboarding did not fully finish."}
              </p>
              {offboardOutcome.nextStep ? (
                <p className="small" style={{ marginTop: 4 }}>
                  {offboardOutcome.nextStep}
                </p>
              ) : null}
              {!offboardOutcome.inProgress ? (
                <Button block loading={busy} onClick={() => void runOffboard()}>
                  Resume offboarding
                </Button>
              ) : null}
            </Card>
          ) : !offboardOpen ? (
            <Button block variant="ghost" onClick={() => setOffboardOpen(true)}>
              Offboard {existing.name}
            </Button>
          ) : (
            <div className="form-grid">
              <p className="muted small" style={{ margin: 0 }}>
                Their future assigned jobs go back to the scheduling pool, and
                their login (if any) is disabled and signed out immediately.
                Their history stays.
              </p>
              <Field
                label="Reason for offboarding"
                hint="A controlled reason is recorded in the staff-access ledger with your name and the time."
              >
                <select
                  value={offboardReason}
                  onChange={(e) => setOffboardReason(e.target.value)}
                >
                  {STAFF_OFFBOARD_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, " ").toLowerCase()}
                    </option>
                  ))}
                </select>
              </Field>
              {offboardReason === "OTHER" ? (
                <Field label="Note" hint="Required when the reason is 'Other'.">
                  <input
                    value={offboardNote}
                    onChange={(e) => setOffboardNote(e.target.value)}
                    placeholder="Say why in a few words"
                  />
                </Field>
              ) : null}
              <Button
                block
                variant="danger"
                loading={busy}
                onClick={() => void runOffboard()}
              >
                Yes, offboard now
              </Button>
              <Button
                block
                variant="ghost"
                onClick={() => setOffboardOpen(false)}
              >
                Cancel
              </Button>
            </div>
          )
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            Ask the owner to offboard this technician — it disables their login,
            so it is owner-only.
          </p>
        )
      ) : null}
    </div>
  );
}
