import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  unwrap,
  type Customer,
  type Job,
  type ServiceReport,
  type Technician,
} from "../lib/api";
import { customerAccessGroups } from "../lib/accessGroups";
import { useRoles } from "../lib/auth";
import { fmtDate } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  ErrorNote,
  Field,
  Page,
  Spinner,
  StatusBadge,
} from "../ui/kit";
import DocButton from "../components/DocButton";
import ReportPhotos from "../components/ReportPhotos";

type Product = { name: string; epaNumber: string; quantity: string; targetPest: string };
type Geo = { lat: number; lng: number; accuracyM: number; capturedAt: string };

/** productsUsed is an AWSJSON field — arrives as a JSON string or value. */
function parseProducts(raw: unknown): Product[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? (v as Product[]) : [];
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
  const roles = useRoles();
  const [job, setJob] = useState<Job | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [report, setReport] = useState<ServiceReport | null>(null);
  const [techRecord, setTechRecord] = useState<Technician | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      const j = unwrap(await api().models.Job.get({ id: jobId }));
      if (!j) {
        setError("Job not found");
        return;
      }
      setJob(j);
      const [c, reps, techs] = await Promise.all([
        api().models.Customer.get({ id: j.customerId }),
        api().models.ServiceReport.list({
          filter: { jobId: { eq: jobId } },
          limit: 10,
        }),
        api().models.Technician.list({ limit: 200 }),
      ]);
      setCustomer(unwrap(c));
      setReport(unwrap(reps)[0] ?? null);
      const allTechs = unwrap(techs);
      setTechRecord(
        allTechs.find((t) => t.userSub === roles.sub) ??
          allTechs.find((t) => t.id === j.technicianId) ??
          null
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load job");
    }
  }, [jobId, roles.sub]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!job || !customer) {
    return (
      <Page title="Job" back="/tech">
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
      <ErrorNote error={error} />
      <Card>
        <div className="row-split" style={{ marginBottom: 8 }}>
          <strong>{job.serviceType}</strong>
          <StatusBadge status={job.status} />
        </div>
        <dl className="kv">
          <dt>Date</dt>
          <dd>{fmtDate(job.scheduledDate, true)}{job.timeWindow ? ` · ${job.timeWindow}` : ""}</dd>
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
          {job.notes ? (
            <>
              <dt>Notes</dt>
              <dd>{job.notes}</dd>
            </>
          ) : null}
        </dl>
      </Card>

      {job.status === "SCHEDULED" ? (
        <Button
          block
          onClick={() =>
            api()
              .models.Job.update({ id: job.id, status: "IN_PROGRESS" })
              .then(() => load())
          }
        >
          Start job
        </Button>
      ) : null}

      {report?.status === "FINALIZED" ? (
        <Card title="Service report">
          <div className="row-split">
            <Badge tone="ok">completed &amp; sent</Badge>
            {report.pdfKey ? <DocButton docKey={report.pdfKey} /> : null}
          </div>
          <ReportPhotos report={report} readOnly onChanged={load} />
        </Card>
      ) : job.status === "IN_PROGRESS" || job.status === "COMPLETED" || report ? (
        <ReportForm
          job={job}
          customer={customer}
          technician={techRecord}
          existing={report}
          onChanged={load}
        />
      ) : null}
    </Page>
  );
}

function ReportForm({
  job,
  customer,
  technician,
  existing,
  onChanged,
}: {
  job: Job;
  customer: Customer;
  technician: Technician | null;
  existing: ServiceReport | null;
  onChanged: () => Promise<void>;
}) {
  const [servicesPerformed, setServicesPerformed] = useState(existing?.servicesPerformed ?? "");
  const [targetPests, setTargetPests] = useState(existing?.targetPests ?? "");
  const [areasTreated, setAreasTreated] = useState(existing?.areasTreated ?? "");
  const [recommendations, setRecommendations] = useState(existing?.recommendations ?? "");
  const [techNotes, setTechNotes] = useState(existing?.techNotes ?? "");
  const [products, setProducts] = useState<Product[]>(
    parseProducts(existing?.productsUsed)
  );
  const [geo, setGeo] = useState<Geo | null>(
    existing?.geoLat != null && existing?.geoLng != null
      ? {
          lat: existing.geoLat,
          lng: existing.geoLng,
          accuracyM: existing.geoAccuracyM ?? 0,
          capturedAt: existing.geoCapturedAt ?? new Date().toISOString(),
        }
      : null
  );
  const [geoBusy, setGeoBusy] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "finalize">(null);
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState(existing?.id ?? null);

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
      productsUsed: JSON.stringify(products.filter((p) => p.name.trim())),
      targetPests: targetPests.trim() || undefined,
      areasTreated: areasTreated.trim() || undefined,
      recommendations: recommendations.trim() || undefined,
      techNotes: techNotes.trim() || undefined,
      ...(geo
        ? {
            geoLat: geo.lat,
            geoLng: geo.lng,
            geoAccuracyM: geo.accuracyM,
            geoCapturedAt: geo.capturedAt,
          }
        : {}),
    };
    if (reportId) {
      unwrap(await api().models.ServiceReport.update({ id: reportId, ...fields }));
      return reportId;
    }
    const created = unwrap(
      await api().models.ServiceReport.create({
        jobId: job.id,
        customerId: customer.id,
        technicianId: technician.id,
        serviceDate: new Date().toISOString(),
        status: "DRAFT",
        accessGroups: customerAccessGroups(customer.id, customer.groupId),
        ...fields,
      })
    );
    if (!created) throw new Error("Could not save report");
    setReportId(created.id);
    return created.id;
  };

  const setProduct = (i: number, k: keyof Product, v: string) =>
    setProducts((list) => list.map((p, idx) => (idx === i ? { ...p, [k]: v } : p)));

  return (
    <Card title="Service report">
      <div className="form-grid">
        <Field label="Services performed">
          <textarea
            value={servicesPerformed}
            onChange={(e) => setServicesPerformed(e.target.value)}
            placeholder="Inspected and treated baseboards, applied exterior barrier…"
          />
        </Field>

        <Field label="Products applied">
          <div className="form-grid">
            {products.map((p, i) => (
              <div key={i} className="card" style={{ padding: 10 }}>
                <div className="form-grid" style={{ gap: 8 }}>
                  <input placeholder="Product name" value={p.name} onChange={(e) => setProduct(i, "name", e.target.value)} />
                  <div className="form-row-2">
                    <input placeholder="EPA #" value={p.epaNumber} onChange={(e) => setProduct(i, "epaNumber", e.target.value)} />
                    <input placeholder="Amount" value={p.quantity} onChange={(e) => setProduct(i, "quantity", e.target.value)} />
                  </div>
                  <div className="row-split">
                    <input placeholder="Target pest" value={p.targetPest} onChange={(e) => setProduct(i, "targetPest", e.target.value)} />
                    <Button small variant="ghost" onClick={() => setProducts((l) => l.filter((_, idx) => idx !== i))}>
                      ✕
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            <Button
              small
              variant="ghost"
              onClick={() =>
                setProducts((l) => [...l, { name: "", epaNumber: "", quantity: "", targetPest: "" }])
              }
            >
              + Add product
            </Button>
          </div>
        </Field>

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
        <Field label="Internal notes (not shown to customer)">
          <textarea value={techNotes} onChange={(e) => setTechNotes(e.target.value)} />
        </Field>

        <Field label="Job-site photos">
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

        <ErrorNote error={error} />
        <div className="form-row-2">
          <Button
            variant="ghost"
            loading={busy === "save"}
            onClick={() => {
              setBusy("save");
              setError(null);
              save()
                .then(() => onChanged())
                .catch((err) => setError(err.message))
                .finally(() => setBusy(null));
            }}
          >
            Save draft
          </Button>
          <Button
            loading={busy === "finalize"}
            onClick={() => {
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
              save()
                .then((id) =>
                  api().mutations.finalizeServiceReport({ reportId: id })
                )
                .then((res) => {
                  if (res.errors?.length) throw new Error(res.errors[0].message);
                  return onChanged();
                })
                .catch((err) => setError(err.message))
                .finally(() => setBusy(null));
            }}
          >
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
