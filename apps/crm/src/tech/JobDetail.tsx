import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  opResult,
  technicianJob,
  unwrap,
  type Customer,
  type Job,
  type Product as CatalogProduct,
  type ServiceReport,
  type Technician,
  type TechnicianJobDetail,
} from "../lib/api";
import { fmtDate } from "../lib/format";
import {
  clearDraft,
  isConnectivityError,
  loadDraft,
  saveDraft,
  syncBadge,
} from "../lib/reportDraft";
import {
  Badge,
  Button,
  Card,
  DeliveryBadge,
  ErrorNote,
  Field,
  Page,
  Spinner,
  StatusBadge,
} from "../ui/kit";
import DocButton from "../components/DocButton";
import ReportPhotos from "../components/ReportPhotos";

type ProductRow = {
  name: string;
  epaNumber: string;
  quantity: string;
  rate?: string;
  targetPest: string;
  /** UI-only: row is being typed manually instead of picked from the log. */
  custom?: boolean;
  /** UI-only: the tech typed this field, so a re-pick must not overwrite it. */
  quantityTouched?: boolean;
  pestTouched?: boolean;
};
type Geo = { lat: number; lng: number; accuracyM: number; capturedAt: string };

/**
 * What this phone keeps if the battery dies mid-report (R12) — the exact UI
 * state of the form, so a restore puts the tech back where they were.
 */
type DraftFields = {
  servicesPerformed: string;
  targetPests: string;
  areasTreated: string;
  recommendations: string;
  techNotes: string;
  inspectionOnly: boolean;
  reEntry: string;
  products: ProductRow[];
  geo: Geo | null;
};

/** Live navigator.onLine, for the offline banner and the sync words. */
function useOnline(): boolean {
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

/** productsUsed is an AWSJSON field — arrives as a JSON string or value. */
function parseProducts(raw: unknown): ProductRow[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as ProductRow[]) : [];
  } catch {
    return [];
  }
}

/**
 * Technician job screen: job context + the mobile service report form.
 * Finalizing requires a captured GPS stamp — that's the on-site proof that
 * goes on the PDF.
 */
export default function TechJob() {
  const { jobId } = useParams<{ jobId: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [report, setReport] = useState<ServiceReport | null>(null);
  const [techRecord, setTechRecord] = useState<Technician | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [priorVisits, setPriorVisits] = useState<
    TechnicianJobDetail["priorVisits"]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [packetChanged, setPacketChanged] = useState(false);
  const [onsiteMinutes, setOnsiteMinutes] = useState<number | null>(null);
  const [lineage, setLineage] = useState<
    NonNullable<TechnicianJobDetail["lineage"]>
  >([]);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      // GL-13 row-scoping: one server-scoped read. The Lambda proves this job is
      // the caller's (or office), returns the job, its customer (visit fields
      // only), its reports, the catalog, prior-visit context, and the caller's
      // OWN technician record — identity for the report is the signed-in user,
      // never the job's assigned tech. A job that is not the caller's rejects
      // with the same opaque error as a missing one.
      const d = await technicianJob(jobId);
      setJob(d.job);
      setPacketChanged(Boolean(d.packetChanged));
      setOnsiteMinutes(d.onsiteMinutes ?? null);
      setLineage(d.lineage ?? []);
      setCustomer(d.customer);
      setReport(d.reports[0] ?? null);
      setTechRecord(d.technician as Technician | null);
      // GL-12: the last few relevant outcomes at this address (didn't happen /
      // did). The query already excludes the current job.
      setPriorVisits(
        d.priorVisits
          .filter(
            (h) =>
              h.status === "NO_ACCESS" ||
              h.status === "CANCELED" ||
              h.status === "COMPLETED"
          )
          .sort((a, b) =>
            (b.scheduledDate ?? "0").localeCompare(a.scheduledDate ?? "0")
          )
          .slice(0, 4)
      );
      // The query already restricts the catalog to active, label-approved rows;
      // sort for stable field ordering.
      setCatalog(
        d.catalog
          .slice()
          .sort(
            (a, b) =>
              (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
              a.name.localeCompare(b.name)
          )
      );
      setError(null);
    } catch (err) {
      // GL-13: the server refusing this job (reassignment, deactivation, or a
      // lapsed licence) makes the locally cached draft unreadable on this very
      // interaction — the device does not keep another assignee's customer data.
      if (
        !isConnectivityError(err) &&
        err instanceof Error &&
        /not authorized/i.test(err.message)
      ) {
        clearDraft(jobId);
      }
      setError(
        isConnectivityError(err)
          ? "No connection — couldn't load this job. It will load when signal returns."
          : err instanceof Error
            ? err.message
            : "Could not load job"
      );
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Regained signal reloads the job — the offline error clears itself instead
  // of asking the tech to know that pull-to-refresh exists.
  useEffect(() => {
    const onOnline = () => void load();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [load]);

  const online = useOnline();
  const offlineBanner = !online ? (
    <Card>
      <Badge tone="warn">offline</Badge>
      <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
        No connection. Anything you type in the report is saved to this phone
        and can be sent when signal returns.
      </p>
    </Card>
  ) : null;

  if (!job || !customer) {
    return (
      <Page title="Job" back="/tech">
        {offlineBanner}
        <ErrorNote error={error} />
        {!error ? <Spinner /> : null}
      </Page>
    );
  }

  const address = [
    customer.serviceStreet,
    customer.serviceCity,
    customer.serviceState,
    customer.serviceZip,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <Page title={customer.displayName} back="/tech">
      {offlineBanner}
      <ErrorNote error={error} />
      {/* GL-12 dispatch packet: everything needed to arrive safely, do the
          right service, and say the right thing about money — in one place. */}
      <Card>
        <div className="row-split" style={{ marginBottom: 8 }}>
          <strong>{job.serviceType}</strong>
          <StatusBadge status={job.status} />
        </div>
        {job.hazardNotes ? (
          <div
            role="alert"
            style={{
              border: "1px solid var(--danger, #c0392b)",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 10,
            }}
          >
            <Badge tone="danger">safety</Badge>
            <p style={{ margin: "6px 0 0", fontWeight: 600 }}>{job.hazardNotes}</p>
          </div>
        ) : null}
        <dl className="kv">
          <dt>Contact</dt>
          <dd>{customer.contactName?.trim() || customer.displayName}</dd>
          <dt>Date</dt>
          <dd>{fmtDate(job.scheduledDate, true)}</dd>
          <dt>Address</dt>
          <dd>
            {address ? (
              <a
                href={`https://maps.apple.com/?daddr=${encodeURIComponent(address)}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--brand)" }}
              >
                {address}
              </a>
            ) : (
              "—"
            )}
          </dd>
          <dt>Phone</dt>
          <dd>
            {customer.phone ? <a href={`tel:${customer.phone}`} style={{ color: "var(--brand)" }}>{customer.phone}</a> : "—"}
          </dd>
          {job.accessInstructions ? (
            <>
              <dt>Getting in</dt>
              <dd>{job.accessInstructions}</dd>
            </>
          ) : null}
          {job.description ? (
            <>
              <dt>Scope</dt>
              <dd>{job.description}</dd>
            </>
          ) : null}
          {job.prepInstructions ? (
            <>
              <dt>Prep</dt>
              <dd>
                {job.prepInstructions}{" "}
                <Badge tone={job.prepConfirmed ? "ok" : "warn"}>
                  {job.prepConfirmed ? "confirmed" : "not confirmed"}
                </Badge>
              </dd>
            </>
          ) : null}
          {onsiteMinutes != null ? (
            <>
              <dt>On-site time</dt>
              <dd>
                {onsiteMinutes} minutes (
                {job.propertyClass
                  ? String(job.propertyClass).toLowerCase()
                  : "residential"}
                )
              </dd>
            </>
          ) : null}
          <dt>Payment</dt>
          <dd>{paymentExpectationLabel(job)}</dd>
          {job.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{job.notes}</dd>
            </>
          ) : null}
        </dl>
      </Card>

      {lineage.length ? (
        <Card>
          <Badge tone="info">attempt {lineage.length + 1} of this visit</Badge>
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            {lineage
              .map(
                (a) =>
                  `${fmtDate(a.scheduledDate ?? null, true)}: ${String(a.status).replace(/_/g, " ").toLowerCase()}`
              )
              .join(" · ")}
          </p>
        </Card>
      ) : null}

      {priorVisits.length ? (
        <Card title="Before this visit">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {priorVisits.map((v) => (
              <li key={v.id}>
                <StatusBadge status={v.status} />{" "}
                <span className="muted small">
                  {fmtDate(v.scheduledDate, true)} · {v.serviceType}
                  {v.status === "NO_ACCESS" && v.noAccessReason
                    ? ` — ${NO_ACCESS_LABEL[v.noAccessReason] ?? "couldn't access"}`
                    : ""}
                </span>
                {v.findings ? (
                  <div className="muted small" style={{ marginLeft: 24 }}>
                    {[
                      v.findings.servicesPerformed
                        ? `did: ${v.findings.servicesPerformed}`
                        : null,
                      v.findings.areasTreated
                        ? `areas: ${v.findings.areasTreated}`
                        : null,
                      v.findings.targetPests
                        ? `pests: ${v.findings.targetPests}`
                        : null,
                      v.findings.recommendations
                        ? `recommended: ${v.findings.recommendations}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {job.status === "SCOPE_MISMATCH" || job.status === "PREP_MISSING" ? (
        <Card>
          <Badge tone="warn">
            {job.status === "SCOPE_MISMATCH"
              ? "scope doesn't match"
              : "required prep missing"}
          </Badge>
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            {job.notPerformedNote ? `${job.notPerformedNote} — ` : ""}
            The office has been told and will contact the customer within one
            business day. Nothing was started, charged, or reported.
          </p>
        </Card>
      ) : null}

      {job.status === "NO_ACCESS" ? (
        <Card>
          <Badge tone="warn">couldn't access</Badge>
          <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
            {NO_ACCESS_LABEL[job.noAccessReason ?? ""] ?? "Couldn't do the job"}
            {job.noAccessNote ? ` — ${job.noAccessNote}` : ""}
          </p>
          <p className="muted small" style={{ margin: "8px 0 0" }}>
            The office has been told. Nothing was charged and no report was
            filed.
          </p>
        </Card>
      ) : null}

      {/* GL-10: a guarantee-callback visit asks the technician for ONE
          controlled, evidenced finding — it decides whether the guarantee
          continues or ends. */}
      {job.id.startsWith("cbjob-") &&
      (job.status === "SCHEDULED" ||
        job.status === "IN_PROGRESS" ||
        job.status === "COMPLETED") ? (
        <CallbackFindingCard job={job} onDone={load} />
      ) : null}

      {packetChanged ? (
        <Card>
          <Badge tone="warn">the packet changed</Badge>
          <p className="muted small" style={{ marginTop: 8 }}>
            The office changed this visit's access, safety, prep, or scope
            details since it was assigned. Re-read the packet above, then
            acknowledge — starting is blocked until you do.
          </p>
          <Button
            block
            onClick={() =>
              api()
                .mutations.acknowledgePacket({
                  jobId: job.id,
                  version: job.packetVersion ?? 1,
                })
                .then((res) => {
                  if (res.errors?.length) throw new Error(res.errors[0].message);
                  return load();
                })
                .catch((err) =>
                  setError(
                    err instanceof Error ? err.message : "Could not acknowledge"
                  )
                )
            }
          >
            I've read the change — acknowledge
          </Button>
        </Card>
      ) : null}

      {job.status === "SCHEDULED" ? (
        <Button
          block
          onClick={() =>
            // The application's start time on the pesticide record — stamped
            // by the server's clock. The Job model is read-only for techs, so
            // there is no browser-supplied timestamp to rewrite.
            api()
              .mutations.startJob({ jobId: job.id })
              .then((res) => {
                if (res.errors?.length) throw new Error(res.errors[0].message);
                return load();
              })
              .catch((err) =>
                // Honest failure words (R12): a dropped connection is not the
                // same as the server saying no, and the tech needs to know
                // the start time was NOT stamped.
                setError(
                  isConnectivityError(err)
                    ? "No connection — the job didn't start. The start time is stamped by the office clock, so try again when you have signal."
                    : err instanceof Error
                      ? err.message
                      : "Could not start the job"
                )
              )
          }
        >
          Start job
        </Button>
      ) : null}

      {/* The honest exit. Without it, the only way to clear this screen was to
          file a report for a visit that never happened — which emails the
          customer a pesticide record, arms the charge, and advances the plan.
          The tech was never being dishonest; the app routed them there. */}
      {job.status === "SCHEDULED" || job.status === "IN_PROGRESS" ? (
        <>
          <NoAccessCard
            job={job}
            ownerSub={techRecord?.userSub ?? null}
            onDone={load}
          />
          <ScopePrepExits job={job} onDone={load} />
        </>
      ) : null}

      {report?.status === "FINALIZED" ? (
        <Card title="Service report">
          <div className="row-split">
            <Badge tone="ok">completed</Badge>
            <DeliveryBadge
              status={report.deliveryStatus}
              emailedAt={report.emailedAt}
            />
            {report.pdfKey ? <DocButton docKey={report.pdfKey} /> : null}
          </div>
          <ReportPhotos report={report} readOnly onChanged={load} />
        </Card>
      ) : job.status === "IN_PROGRESS" || job.status === "COMPLETED" || report ? (
        <ReportForm
          job={job}
          technician={techRecord}
          existing={report}
          catalog={catalog}
          onChanged={load}
        />
      ) : null}
    </Page>
  );
}

/**
 * GL-12: the one line the technician says about money at the door. A blank or
 * unknown value reads as "office bills" — never as "collect on site", because
 * the field never takes payment.
 */
function paymentExpectationLabel(job: Job): string {
  if (job.paidAt) return "Already paid — collect nothing";
  // GL-06: the bank debit is clearing — the visit proceeds; the technician
  // never collects or discusses payment state at the door.
  if (job.paymentPendingIntentId) {
    return "Payment processing online — collect nothing";
  }
  return job.paymentExpectation === "COLLECT_NOTHING"
    ? "Collect nothing"
    : "Collect nothing — office bills afterward";
}

const NO_ACCESS_LABEL: Record<string, string> = {
  NOBODY_HOME: "Nobody home",
  LOCKED_OUT: "Couldn't get in",
  DOG_LOOSE: "Dog loose",
  REFUSED_ENTRY: "Customer refused entry",
  UNSAFE_CONDITIONS: "Unsafe on site",
  WRONG_ADDRESS: "Address is wrong",
};

/**
 * "I went and couldn't do it."
 *
 * Reason chips rather than a text box: this gets tapped in a driveway, one
 * handed, in the rain. The photo is optional — requiring it would be one more
 * way to trap someone who is already stuck — but it is what an office
 * no-access billing decision turns on, and what protects the technician from
 * being told they never went.
 */
/**
 * GL-12 — the other two honest exits: "scope doesn't match" and "required
 * prep missing". One tap each: pick what you found, add a note, done. Neither
 * starts or completes service; the office owns the follow-up (the customer is
 * told we'll be in touch within one business day), and the money facts are
 * preserved for their decision.
 */
const SCOPE_EXIT_OPTIONS: { value: string; label: string }[] = [
  { value: "DIFFERENT_PEST", label: "Different pest than the work order" },
  { value: "DIFFERENT_PROPERTY", label: "Property/structure doesn't match" },
  { value: "WRONG_SERVICE_SOLD", label: "Sold service can't address the site" },
  { value: "OUT_OF_SCOPE_AREA", label: "Needed area isn't in the sold scope" },
];
const PREP_EXIT_OPTIONS: { value: string; label: string }[] = [
  { value: "AREAS_NOT_CLEARED", label: "Areas not cleared / prepared" },
  { value: "PETS_NOT_SECURED", label: "Pets not secured" },
  { value: "OCCUPANTS_PRESENT", label: "Occupants present who must vacate" },
  { value: "PREP_NOT_DONE", label: "Required prep visibly not done" },
];

function ScopePrepExits({ job, onDone }: { job: Job; onDone: () => Promise<void> }) {
  const [mode, setMode] = useState<null | "scope" | "prep">(null);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!reason || !mode) return;
    setBusy(true);
    setError(null);
    try {
      const mutations = api().mutations as unknown as {
        reportScopeMismatch: (i: {
          jobId: string;
          reason: string;
          note?: string;
        }) => Promise<{ errors?: { message: string }[] }>;
        reportPrepMissing: (i: {
          jobId: string;
          reason: string;
          note?: string;
        }) => Promise<{ errors?: { message: string }[] }>;
      };
      const res =
        mode === "scope"
          ? await mutations.reportScopeMismatch({
              jobId: job.id,
              reason,
              note: note.trim() || undefined,
            })
          : await mutations.reportPrepMissing({
              jobId: job.id,
              reason,
              note: note.trim() || undefined,
            });
      if (res.errors?.length) throw new Error(res.errors[0].message);
      await onDone();
    } catch (err) {
      setError(
        isConnectivityError(err)
          ? "No connection — nothing was recorded. Try again with signal."
          : err instanceof Error
            ? err.message
            : "Could not record the outcome"
      );
      setBusy(false);
    }
  };

  const options = mode === "scope" ? SCOPE_EXIT_OPTIONS : PREP_EXIT_OPTIONS;

  return (
    <Card>
      {mode === null ? (
        <div className="form-grid" style={{ gap: 8 }}>
          <Button block variant="ghost" onClick={() => setMode("scope")}>
            The work doesn't match the site
          </Button>
          <Button block variant="ghost" onClick={() => setMode("prep")}>
            The required prep isn't done
          </Button>
        </div>
      ) : (
        <div className="form-grid" style={{ gap: 8 }}>
          <p className="muted small" style={{ margin: 0 }}>
            {mode === "scope"
              ? "Nothing starts and nothing is charged. The office corrects the service with the customer — we tell them we'll be in touch within one business day."
              : "Nothing starts and nothing is charged. The office reschedules once the customer is ready — we tell them we'll be in touch within one business day."}
          </p>
          {options.map((o) => (
            <Button
              key={o.value}
              block
              variant={reason === o.value ? "primary" : "ghost"}
              onClick={() => setReason(o.value)}
            >
              {o.label}
            </Button>
          ))}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything the office should know (optional)"
          />
          <Button block loading={busy} disabled={!reason} onClick={() => void submit()}>
            Record it — the office takes it from here
          </Button>
          <Button block variant="ghost" onClick={() => { setMode(null); setReason(null); }}>
            Back
          </Button>
        </div>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

/**
 * GL-10 — the callback technician's finding. Three controlled choices, an
 * evidence note, an optional photo. TREATABLE continues the guarantee
 * (treat and complete as normal); the other two END it — the customer gets
 * one final notice and the CRM promises no appeal, so the words here say
 * exactly what each tap means.
 */
const CALLBACK_FINDING_OPTIONS: { value: string; label: string; hint: string }[] = [
  {
    value: "TREATABLE_UNEXPECTED",
    label: "Treatable, unexpected activity",
    hint: "Covered — treat it and complete the visit as normal.",
  },
  {
    value: "UNTREATABLE_CONDITION",
    label: "Untreatable condition",
    hint: "Ends the guarantee — the customer gets a final notice with your evidence.",
  },
  {
    value: "EXPECTED_BEHAVIOR",
    label: "Expected pest behavior",
    hint: "Ends the guarantee — normal activity, not a treatable infestation.",
  },
];

function CallbackFindingCard({
  job,
  onDone,
}: {
  job: Job;
  onDone: () => Promise<void>;
}) {
  const [finding, setFinding] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const callbackRequestId = job.id.replace(/^cbjob-/, "");

  const uploadPhoto = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const res = opResult<{ uploadUrl: string; key: string }>(
        await api().mutations.getNoAccessPhotoUploadUrl({
          jobId: job.id,
          contentType: file.type,
        })
      );
      if (!res?.uploadUrl) throw new Error("Could not start the upload");
      const put = await fetch(res.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      setPhotoKey(res.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setBusy(false);
      if (photoInput.current) photoInput.current.value = "";
    }
  };

  const submit = async () => {
    if (!finding || !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = opResult<{ status: string }>(
        await api().mutations.recordCallbackFinding({
          callbackRequestId,
          finding,
          note: note.trim(),
          photoKey: photoKey ?? undefined,
        })
      );
      setDone(res?.status ?? "recorded");
      await onDone();
    } catch (err) {
      setError(
        isConnectivityError(err)
          ? "No connection — nothing was recorded. Try again with signal."
          : err instanceof Error
            ? err.message
            : "Could not record the finding"
      );
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card>
        <Badge tone={done === "COMPLETED" ? "ok" : "warn"}>
          finding recorded
        </Badge>
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
          {done === "COMPLETED"
            ? "Covered — treat it and complete the visit as normal."
            : "The guarantee is ended. The customer receives the final notice — nothing else for you to say at the door."}
        </p>
      </Card>
    );
  }

  return (
    <Card title="Guarantee callback — what did you find?">
      <div className="form-grid" style={{ gap: 8 }}>
        {CALLBACK_FINDING_OPTIONS.map((o) => (
          <div key={o.value}>
            <Button
              block
              variant={finding === o.value ? "primary" : "ghost"}
              onClick={() => setFinding(o.value)}
            >
              {o.label}
            </Button>
            {finding === o.value ? (
              <p className="muted small" style={{ margin: "4px 0 0" }}>
                {o.hint}
              </p>
            ) : null}
          </div>
        ))}
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What you found, in plain words (required — it's the evidence)"
        />
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPhoto(f);
          }}
        />
        {photoKey ? <Badge tone="ok">photo attached</Badge> : null}
        <Button
          block
          loading={busy}
          disabled={!finding || !note.trim()}
          onClick={() => void submit()}
        >
          Record the finding
        </Button>
        <ErrorNote error={error} />
      </div>
    </Card>
  );
}

function NoAccessCard({
  job,
  ownerSub,
  onDone,
}: {
  job: Job;
  ownerSub: string | null;
  onDone: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);

  const uploadPhoto = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const res = opResult<{ uploadUrl: string; key: string }>(
        await api().mutations.getNoAccessPhotoUploadUrl({
          jobId: job.id,
          contentType: file.type,
        })
      );
      if (!res?.uploadUrl) throw new Error("Could not start the upload");
      const put = await fetch(res.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      setPhotoKey(res.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setBusy(false);
      if (photoInput.current) photoInput.current.value = "";
    }
  };

  const submit = async () => {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      unwrap(
        await api().mutations.reportNoAccess({
          jobId: job.id,
          reason,
          note: note.trim() || undefined,
          photoKey: photoKey ?? undefined,
        })
      );
      // The visit is over and no report will be filed for it — a lingering
      // draft would only restore stale words into a future rebooked visit.
      clearDraft(job.id, localStorage, ownerSub);
      await onDone();
    } catch (err) {
      setError(
        isConnectivityError(err)
          ? "No connection — this didn't go through. Tap Send it again when you have signal."
          : err instanceof Error
            ? err.message
            : "Could not report it"
      );
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button block variant="subtle" onClick={() => setOpen(true)}>
        Couldn't do this job
      </Button>
    );
  }

  return (
    <Card title="What happened?">
      <div className="form-grid">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(NO_ACCESS_LABEL).map(([value, label]) => (
            <Button
              key={value}
              small
              variant={reason === value ? undefined : "ghost"}
              onClick={() => setReason(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Field label="Anything to add? (optional)">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Gate padlocked, no answer on the phone"
          />
        </Field>
        <input
          ref={photoInput}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadPhoto(f);
          }}
        />
        <Button
          small
          variant="ghost"
          loading={busy}
          onClick={() => photoInput.current?.click()}
        >
          {photoKey ? "✓ Photo attached — retake" : "Take a photo (optional)"}
        </Button>
        <ErrorNote error={error} />
        <p className="muted small" style={{ margin: 0 }}>
          This ends the job for today and tells the office. Nothing is charged
          and no service report is filed.
        </p>
        <Button block disabled={!reason} loading={busy} onClick={() => void submit()}>
          Send it
        </Button>
        <Button block variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function ReportForm({
  job,
  technician,
  existing,
  catalog,
  onChanged,
}: {
  job: Job;
  technician: Technician | null;
  existing: ServiceReport | null;
  catalog: CatalogProduct[];
  onChanged: () => Promise<void>;
}) {
  // R12: if this phone holds typing the office never got — battery died,
  // signal dropped, tab evicted — put the tech back exactly where they were.
  // Content is the arbiter, not clocks: a save that lands after the tech kept
  // typing gives the server the newer timestamp while the phone holds the
  // newer words. A draft is discarded only when it says nothing the office
  // copy doesn't already say.
  const serverCopyFields = (): DraftFields => ({
    servicesPerformed: existing?.servicesPerformed ?? "",
    targetPests: existing?.targetPests ?? "",
    areasTreated: existing?.areasTreated ?? "",
    recommendations: existing?.recommendations ?? "",
    techNotes: existing?.techNotes ?? "",
    inspectionOnly: existing?.inspectionOnly ?? false,
    reEntry:
      existing?.reEntryIntervalHours != null
        ? String(existing.reEntryIntervalHours)
        : "",
    products: parseProducts(existing?.productsUsed).map((p) => ({
      ...p,
      custom: !!p.name && !catalog.some((c) => c.name === p.name),
    })),
    geo:
      existing?.geoLat != null && existing?.geoLng != null
        ? {
            lat: existing.geoLat,
            lng: existing.geoLng,
            accuracyM: existing.geoAccuracyM ?? 0,
            capturedAt: existing.geoCapturedAt ?? "",
          }
        : null,
  });
  // GL-13: drafts are bound to the signed-in identity (the caller's own
  // technician record), so another login on this device can never restore them.
  const ownerSub = technician?.userSub ?? null;
  const [restored] = useState(() => {
    const d = loadDraft<DraftFields>(job.id, localStorage, ownerSub);
    if (!d) return null;
    if (JSON.stringify(d.fields) === JSON.stringify(serverCopyFields())) {
      clearDraft(job.id, localStorage, ownerSub);
      return null;
    }
    return d;
  });
  const [servicesPerformed, setServicesPerformed] = useState(
    restored?.fields.servicesPerformed ?? existing?.servicesPerformed ?? ""
  );
  const [targetPests, setTargetPests] = useState(
    restored?.fields.targetPests ?? existing?.targetPests ?? ""
  );
  const [areasTreated, setAreasTreated] = useState(
    restored?.fields.areasTreated ?? existing?.areasTreated ?? ""
  );
  const [recommendations, setRecommendations] = useState(
    restored?.fields.recommendations ?? existing?.recommendations ?? ""
  );
  const [techNotes, setTechNotes] = useState(
    restored?.fields.techNotes ?? existing?.techNotes ?? ""
  );
  const [inspectionOnly, setInspectionOnly] = useState(
    restored?.fields.inspectionOnly ?? existing?.inspectionOnly ?? false
  );
  const [reEntry, setReEntry] = useState(
    restored?.fields.reEntry ??
      (existing?.reEntryIntervalHours != null
        ? String(existing.reEntryIntervalHours)
        : "")
  );
  // Reloaded rows lost their UI-only flags — a named row that isn't in the
  // catalog must come back in manual mode or its inputs vanish mid-edit.
  // (A restored draft kept its flags: it is the exact UI state as typed.)
  const [products, setProducts] = useState<ProductRow[]>(
    () =>
      restored?.fields.products ??
      parseProducts(existing?.productsUsed).map((p) => ({
        ...p,
        custom: !!p.name && !catalog.some((c) => c.name === p.name),
      }))
  );
  const [geo, setGeo] = useState<Geo | null>(
    () =>
      restored?.fields.geo ??
      (existing?.geoLat != null && existing?.geoLng != null
        ? {
            lat: existing.geoLat,
            lng: existing.geoLng,
            accuracyM: existing.geoAccuracyM ?? 0,
            capturedAt: existing.geoCapturedAt ?? new Date().toISOString(),
          }
        : null)
  );
  const [geoBusy, setGeoBusy] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "finalize">(null);
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState(existing?.id ?? null);

  // The sync truth (R12): dirty = the office doesn't have the latest words;
  // persisted = this phone does. The badge below the form says exactly which.
  const online = useOnline();
  const [dirty, setDirty] = useState(!!restored);
  const [persisted, setPersisted] = useState(true);
  const [sendFailed, setSendFailed] = useState(false);
  const [restoredNote, setRestoredNote] = useState(restored?.savedAt ?? null);
  const editGen = useRef(0);
  const lastMirrored = useRef<string | null>(null);
  const retryRef = useRef<(() => void) | null>(null);

  // Every edit is mirrored to this phone before it goes anywhere else. The
  // snapshot comparison makes mounting (and StrictMode's double-mount) a
  // display, not an edit — only real typing marks the form dirty.
  useEffect(() => {
    const fields: DraftFields = {
      servicesPerformed,
      targetPests,
      areasTreated,
      recommendations,
      techNotes,
      inspectionOnly,
      reEntry,
      products,
      geo,
    };
    const snapshot = JSON.stringify(fields);
    if (lastMirrored.current === null) {
      lastMirrored.current = snapshot;
      return;
    }
    if (snapshot === lastMirrored.current) return;
    lastMirrored.current = snapshot;
    editGen.current += 1;
    setDirty(true);
    setPersisted(saveDraft(job.id, fields, localStorage, ownerSub));
  }, [
    job.id,
    ownerSub,
    servicesPerformed,
    targetPests,
    areasTreated,
    recommendations,
    techNotes,
    inspectionOnly,
    reEntry,
    products,
    geo,
  ]);

  // Regained signal auto-retries the failed *draft* send — no retyping, no
  // extra tap. Finalize is never auto-retried: it emails the customer, so it
  // stays a deliberate button press.
  useEffect(() => {
    const onOnline = () => retryRef.current?.();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const captureGeo = () => {
    if (!navigator.geolocation) {
      setError("This device doesn't support geolocation");
      return;
    }
    setGeoBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          capturedAt: new Date().toISOString(),
        });
        setGeoBusy(false);
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied — allow location access to stamp the report"
            : "Could not get your location — try again outdoors"
        );
        setGeoBusy(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    );
  };

  const save = async (): Promise<string> => {
    if (!technician) {
      throw new Error("Your login isn't linked to a technician record — ask the office");
    }
    const fields = {
      servicesPerformed: servicesPerformed.trim() || undefined,
      // AWSJSON fields must be written as JSON strings.
      productsUsed: JSON.stringify(
        products
          .filter((p) => p.name.trim())
          .map(({ custom, quantityTouched: _q, pestTouched: _p, ...keep }) => {
            // Picker-mode rows display the catalog's EPA # — save that same
            // value so the PDF matches what the tech saw on screen.
            const m = !custom ? catalog.find((c) => c.name === keep.name) : null;
            return m
              ? {
                  ...keep,
                  epaNumber: m.epaNumber ?? "",
                  rate: keep.rate?.trim() || m.defaultRate || "",
                }
              : keep;
          })
      ),
      targetPests: targetPests.trim() || undefined,
      areasTreated: areasTreated.trim() || undefined,
      recommendations: recommendations.trim() || undefined,
      techNotes: techNotes.trim() || undefined,
      reEntryIntervalHours: inspectionOnly
        ? undefined
        : reEntry.trim() === ""
          ? undefined
          : Number(reEntry),
      inspectionOnly,
      ...(geo
        ? {
            geoLat: geo.lat,
            geoLng: geo.lng,
            geoAccuracyM: geo.accuracyM,
            geoCapturedAt: geo.capturedAt,
          }
        : {}),
    };
    // The ServiceReport model is read-only from a browser: a finalized report is
    // a pesticide record the customer holds a copy of, and it used to be
    // rewritable after issuance. The mutation creates or updates the draft and
    // refuses once it is FINALIZED.
    const saved = opResult<{ reportId?: string }>(
      await api().mutations.saveServiceReportDraft({
        jobId: job.id,
        reportId: reportId ?? undefined,
        ...fields,
      })
    );
    if (!saved?.reportId) throw new Error("Could not save the report");
    setReportId(saved.reportId);
    return saved.reportId;
  };

  /**
   * The office confirmed it holds everything typed up to `gen` — only then
   * may the phone's copy clear. Edits made while the save was in flight keep
   * the draft and the "saved to this phone" words (rule 2: no false "saved").
   */
  const markDelivered = (gen: number) => {
    setSendFailed(false);
    setRestoredNote(null);
    if (editGen.current === gen) {
      clearDraft(job.id, localStorage, ownerSub);
      setDirty(false);
    }
  };

  const runSave = () => {
    setBusy("save");
    setError(null);
    const gen = editGen.current;
    save()
      .then(() => {
        markDelivered(gen);
        return onChanged();
      })
      .catch((err) => {
        if (isConnectivityError(err)) {
          // The draft is already on this phone (mirrored on every edit) —
          // nothing is lost, and it re-sends by itself when signal returns.
          setSendFailed(true);
          setError(
            "Couldn't reach the office — your report is saved on this phone and will send when you're back online."
          );
        } else {
          setError(err.message);
        }
      })
      .finally(() => setBusy(null));
  };

  const runFinalize = () => {
    if (!geo) {
      setError("Capture your on-site location before completing the job");
      return;
    }
    if (!servicesPerformed.trim()) {
      setError("Describe the services performed");
      return;
    }
    setBusy("finalize");
    setError(null);
    const gen = editGen.current;
    save()
      .then(async (id) => {
        // Stop the application clock first, server-stamped. The
        // first stamp wins, so if finalize fails here and is
        // retried tomorrow morning, the record's end time is still
        // now — while the tech is on site — not whenever the retry
        // lands.
        const ended = await api().mutations.endApplication({
          jobId: job.id,
        });
        if (ended.errors?.length) {
          throw new Error(ended.errors[0].message);
        }
        return api().mutations.finalizeServiceReport({ reportId: id });
      })
      .then((res) => {
        if (res.errors?.length) throw new Error(res.errors[0].message);
        markDelivered(gen);
        return onChanged();
      })
      .catch((err) => {
        if (isConnectivityError(err)) {
          setSendFailed(true);
          setError(
            "Couldn't reach the office — the report is saved on this phone. Tap Complete & send again when you have signal."
          );
        } else {
          setError(err.message);
        }
      })
      .finally(() => setBusy(null));
  };

  // The auto-retry reads through a ref so the 'online' listener always sees
  // this render's state, not the state from when the listener was attached.
  // Any unsent words qualify, not just a failed send — the offline badge
  // promises "will send when signal returns", so signal returning must send.
  useEffect(() => {
    retryRef.current = dirty && busy === null ? runSave : null;
  });

  const setProduct = (
    i: number,
    k: "name" | "epaNumber" | "quantity" | "rate" | "targetPest",
    v: string
  ) =>
    setProducts((list) =>
      list.map((p, idx) =>
        idx === i
          ? {
              ...p,
              [k]: v,
              ...(k === "quantity" ? { quantityTouched: true } : {}),
              ...(k === "targetPest" ? { pestTouched: true } : {}),
            }
          : p
      )
    );

  const syncState = syncBadge({
    online,
    sending: busy !== null,
    dirty,
    persisted,
    sendFailed,
    hasServerCopy: !!(reportId ?? existing),
  });

  return (
    <Card title="Service report">
      <div className="form-grid">
        {restoredNote ? (
          <p className="muted small" style={{ margin: 0 }}>
            Restored the report you typed at{" "}
            {new Date(restoredNote).toLocaleString()} — it was saved on this
            phone.
          </p>
        ) : null}
        <Field label="Services performed">
          <textarea
            value={servicesPerformed}
            onChange={(e) => setServicesPerformed(e.target.value)}
            placeholder="Inspected and treated baseboards, applied exterior barrier…"
          />
        </Field>

        {/* Zero products used to finalize and email happily. A pesticide record
            with no pesticide on it is either an inspection or a false record,
            and the system should know which. */}
        <Field label="">
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={inspectionOnly}
              onChange={(e) => setInspectionOnly(e.target.checked)}
              style={{ width: "auto" }}
            />
            <span>Inspection only — I didn't apply any product</span>
          </label>
        </Field>

        {inspectionOnly ? null : (
        <Field group label="Products applied" hint="Pick from the product log — ask the office to add anything missing">
          <div className="form-grid">
            {products.map((p, i) => (
              <ProductRowEditor
                key={i}
                row={p}
                catalog={catalog}
                onChange={(k, v) => setProduct(i, k, v)}
                onPick={(picked) => {
                  setProducts((list) =>
                    list.map((row, idx) =>
                      idx === i
                        ? {
                            ...row,
                            name: picked.name,
                            epaNumber: picked.epaNumber ?? "",
                            rate: picked.defaultRate ?? "",
                            quantity:
                              row.quantityTouched && row.quantity
                                ? row.quantity
                                : (picked.defaultQuantity ?? ""),
                            targetPest:
                              row.pestTouched && row.targetPest
                                ? row.targetPest
                                : (picked.targetPests ?? ""),
                            custom: false,
                          }
                        : row
                      )
                  );
                  if (picked.reEntryHours != null) {
                    setReEntry((current) =>
                      current === ""
                        ? String(picked.reEntryHours)
                        : String(Math.max(Number(current), picked.reEntryHours!))
                    );
                  }
                }}
                onCustom={() =>
                  setProducts((list) =>
                    list.map((row, idx) =>
                      idx === i ? { ...row, custom: true } : row
                    )
                  )
                }
                onRemove={() => setProducts((l) => l.filter((_, idx) => idx !== i))}
              />
            ))}
            <Button
              small
              variant="ghost"
              onClick={() =>
                setProducts((l) => [
                  ...l,
                  {
                    name: "",
                    epaNumber: "",
                    quantity: "",
                    rate: "",
                    targetPest: "",
                  },
                ])
              }
            >
              + Add product
            </Button>
          </div>
        </Field>
        )}

        <div className="form-row-2">
          <Field label="Target pests">
            <input value={targetPests} onChange={(e) => setTargetPests(e.target.value)} placeholder="Ants, mice…" />
          </Field>
          <Field label="Areas treated">
            <input value={areasTreated} onChange={(e) => setAreasTreated(e.target.value)} placeholder="Kitchen, basement…" />
          </Field>
        </div>
        <Field label="Recommendations for customer">
          <textarea value={recommendations} onChange={(e) => setRecommendations(e.target.value)} />
        </Field>

        {/* The duty to warn. The occupant cannot be told when it is safe to go
            back in if nobody recorded it — and 0 is a real answer, distinct
            from nobody having said. */}
        {!inspectionOnly ? (
          <Field
            label="Safe to re-enter after (hours)"
            hint="Off the product label. 0 for baits or exterior-only work."
          >
            <input
              type="number"
              min="0"
              step="0.5"
              value={reEntry}
              onChange={(e) => setReEntry(e.target.value)}
              placeholder="Prefilled from the selected product label"
            />
          </Field>
        ) : null}
        <Field label="Internal notes (not shown to customer)">
          <textarea value={techNotes} onChange={(e) => setTechNotes(e.target.value)} />
        </Field>

        <Field group label="Job-site photos">
          {existing ? (
            <ReportPhotos report={existing} onChanged={onChanged} />
          ) : (
            <p className="muted small">
              Save the draft once, then you can attach photos.
            </p>
          )}
        </Field>

        <Card className="geo-card" title="On-site verification">
          {geo ? (
            <p className="small">
              📍 {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)} (±{Math.round(geo.accuracyM)} m)
              <br />
              <span className="muted">Captured {new Date(geo.capturedAt).toLocaleTimeString()}</span>
            </p>
          ) : (
            <p className="muted small">
              Capture your GPS location while on site — it's stamped on the
              customer's report as proof of service.
            </p>
          )}
          <Button small variant={geo ? "ghost" : "subtle"} loading={geoBusy} onClick={captureGeo}>
            {geo ? "Re-capture location" : "Capture location"}
          </Button>
        </Card>

        {/* The one honest sentence about where the report lives right now:
            this phone, the office, or in flight. It never says "saved" for
            words that only exist in React state. */}
        {syncState ? (
          <p className="small" style={{ margin: 0 }}>
            <Badge tone={syncState.tone}>{syncState.label}</Badge>
          </p>
        ) : null}
        <ErrorNote error={error} />
        <div className="form-row-2">
          <Button variant="ghost" loading={busy === "save"} onClick={runSave}>
            Save draft
          </Button>
          <Button loading={busy === "finalize"} onClick={runFinalize}>
            Complete &amp; send
          </Button>
        </div>
        <p className="muted small">
          Completing generates the PDF report, emails it to the customer, and
          marks the job done.
        </p>
      </div>
    </Card>
  );
}

/**
 * One "product applied" row: a picker over the master product log, with a
 * manual fallback that can save the new product back to the log.
 */
function ProductRowEditor({
  row,
  catalog,
  onChange,
  onPick,
  onCustom,
  onRemove,
}: {
  row: ProductRow;
  catalog: CatalogProduct[];
  onChange: (
    k: "name" | "epaNumber" | "quantity" | "rate" | "targetPest",
    v: string
  ) => void;
  onPick: (p: CatalogProduct) => void;
  onCustom: () => void;
  onRemove: () => void;
}) {
  const matched = !row.custom
    ? catalog.find((c) => c.name === row.name) ?? null
    : null;
  const selectValue = row.custom
    ? "__custom__"
    : matched
      ? matched.id
      : row.name
        ? "__custom__"
        : "";
  const manualMode = selectValue === "__custom__";

  return (
    <div className="card" style={{ padding: 10 }}>
      <div className="form-grid" style={{ gap: 8 }}>
        <select
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") {
              onCustom();
            } else {
              const picked = catalog.find((c) => c.id === v);
              if (picked) onPick(picked);
            }
          }}
        >
          <option value="">Choose from product log…</option>
          {catalog.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.epaNumber ? ` — EPA #${c.epaNumber}` : ""}
            </option>
          ))}
          <option value="__custom__">✏️ Not in the log — type it in</option>
        </select>
        {manualMode ? (
          <>
            <input
              placeholder="Product name"
              value={row.name}
              onChange={(e) => onChange("name", e.target.value)}
            />
            <input
              placeholder="EPA # — e.g. 432-1234"
              value={row.epaNumber}
              onChange={(e) => onChange("epaNumber", e.target.value)}
            />
            <input
              placeholder="Label rate / dilution — e.g. 1 oz / gal"
              value={row.rate ?? ""}
              onChange={(e) => onChange("rate", e.target.value)}
            />
            <p className="muted small" style={{ margin: 0 }}>
              Not in the log yet, so it can't be finalized on a report. The
              office has to review and add it to the product log first — ask
              them, then pick it here.
            </p>
          </>
        ) : matched?.epaNumber ? (
          <p className="muted small" style={{ margin: 0 }}>
            EPA #{matched.epaNumber}
            {matched.activeIngredient ? ` · ${matched.activeIngredient}` : ""}
            {matched.defaultRate ? ` · ${matched.defaultRate}` : ""}
            {matched.reEntryHours != null
              ? ` · re-entry ${matched.reEntryHours}h`
              : ""}
          </p>
        ) : null}
        {!manualMode ? (
          <input
            placeholder="Application rate / dilution"
            value={row.rate ?? ""}
            onChange={(e) => onChange("rate", e.target.value)}
          />
        ) : null}
        <div className="form-row-2">
          <input
            placeholder="Amount (e.g. 2 oz)"
            value={row.quantity}
            onChange={(e) => onChange("quantity", e.target.value)}
          />
          <input
            placeholder="Target pest"
            value={row.targetPest}
            onChange={(e) => onChange("targetPest", e.target.value)}
          />
        </div>
        <Button small variant="ghost" onClick={onRemove}>
          ✕ Remove product
        </Button>
      </div>
    </div>
  );
}
