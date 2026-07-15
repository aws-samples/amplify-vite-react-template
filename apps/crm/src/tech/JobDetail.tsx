import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  unwrap,
  type Customer,
  type Job,
  type Product as CatalogProduct,
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

type ProductRow = {
  name: string;
  epaNumber: string;
  quantity: string;
  targetPest: string;
  /** UI-only: row is being typed manually instead of picked from the log. */
  custom?: boolean;
  /** UI-only: the tech typed this field, so a re-pick must not overwrite it. */
  quantityTouched?: boolean;
  pestTouched?: boolean;
};
type Geo = { lat: number; lng: number; accuracyM: number; capturedAt: string };

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
  const roles = useRoles();
  const [job, setJob] = useState<Job | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [report, setReport] = useState<ServiceReport | null>(null);
  const [techRecord, setTechRecord] = useState<Technician | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
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
      const [c, reps, techs, prods] = await Promise.all([
        api().models.Customer.get({ id: j.customerId }),
        api().models.ServiceReport.listServiceReportByJobId({ jobId }),
        api().models.Technician.list({ limit: 200 }),
        // The catalog is optional (rows have a manual fallback) and the
        // Product model may not exist on the deployed backend yet — never
        // let it break the job screen.
        (async (): Promise<CatalogProduct[]> => {
          try {
            return unwrap(await api().models.Product.list({ limit: 500 }));
          } catch {
            return [];
          }
        })(),
      ]);
      setCustomer(unwrap(c));
      setReport(unwrap(reps)[0] ?? null);
      setCatalog(
        prods
          .filter((pr) => pr.active)
          .sort(
            (a, b) =>
              (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
              a.name.localeCompare(b.name)
          )
      );
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
          catalog={catalog}
          onCatalogAdd={(pr) =>
            setCatalog((list) =>
              [...list, pr].sort(
                (a, b) =>
                  (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
                  a.name.localeCompare(b.name)
              )
            )
          }
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
  catalog,
  onCatalogAdd,
  onChanged,
}: {
  job: Job;
  customer: Customer;
  technician: Technician | null;
  existing: ServiceReport | null;
  catalog: CatalogProduct[];
  onCatalogAdd: (p: CatalogProduct) => void;
  onChanged: () => Promise<void>;
}) {
  const [servicesPerformed, setServicesPerformed] = useState(existing?.servicesPerformed ?? "");
  const [targetPests, setTargetPests] = useState(existing?.targetPests ?? "");
  const [areasTreated, setAreasTreated] = useState(existing?.areasTreated ?? "");
  const [recommendations, setRecommendations] = useState(existing?.recommendations ?? "");
  const [techNotes, setTechNotes] = useState(existing?.techNotes ?? "");
  // Reloaded rows lost their UI-only flags — a named row that isn't in the
  // catalog must come back in manual mode or its inputs vanish mid-edit.
  const [products, setProducts] = useState<ProductRow[]>(() =>
    parseProducts(existing?.productsUsed).map((p) => ({
      ...p,
      custom: !!p.name && !catalog.some((c) => c.name === p.name),
    }))
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
      productsUsed: JSON.stringify(
        products
          .filter((p) => p.name.trim())
          .map(({ custom, quantityTouched: _q, pestTouched: _p, ...keep }) => {
            // Picker-mode rows display the catalog's EPA # — save that same
            // value so the PDF matches what the tech saw on screen.
            const m = !custom ? catalog.find((c) => c.name === keep.name) : null;
            return m ? { ...keep, epaNumber: m.epaNumber ?? "" } : keep;
          })
      ),
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

  const setProduct = (i: number, k: "name" | "epaNumber" | "quantity" | "targetPest", v: string) =>
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

        <Field group label="Products applied" hint="Pick from the product log — ask the office to add anything missing">
          <div className="form-grid">
            {products.map((p, i) => (
              <ProductRowEditor
                key={i}
                row={p}
                catalog={catalog}
                onChange={(k, v) => setProduct(i, k, v)}
                onPick={(picked) =>
                  setProducts((list) =>
                    list.map((row, idx) =>
                      idx === i
                        ? {
                            ...row,
                            name: picked.name,
                            epaNumber: picked.epaNumber ?? "",
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
                  )
                }
                onCustom={() =>
                  setProducts((list) =>
                    list.map((row, idx) =>
                      idx === i ? { ...row, custom: true } : row
                    )
                  )
                }
                onSavedToLog={(created) => {
                  onCatalogAdd(created);
                  setProducts((list) =>
                    list.map((row, idx) => (idx === i ? { ...row, custom: false } : row))
                  );
                }}
                onRemove={() => setProducts((l) => l.filter((_, idx) => idx !== i))}
              />
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
  onSavedToLog,
  onRemove,
}: {
  row: ProductRow;
  catalog: CatalogProduct[];
  onChange: (k: "name" | "epaNumber" | "quantity" | "targetPest", v: string) => void;
  onPick: (p: CatalogProduct) => void;
  onCustom: () => void;
  onSavedToLog: (created: CatalogProduct) => void;
  onRemove: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const saveToLog = async () => {
    if (!row.name.trim()) {
      setError("Enter the product name first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const created = unwrap(
        await api().models.Product.create({
          name: row.name.trim(),
          epaNumber: row.epaNumber.trim() || null,
          defaultQuantity: row.quantity.trim() || null,
          targetPests: row.targetPest.trim() || null,
          active: true,
        })
      );
      if (!created) throw new Error("Could not save to the product log");
      onSavedToLog(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save product");
    } finally {
      setSaving(false);
    }
  };

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
            <div className="form-row-2">
              <input
                placeholder="EPA #"
                value={row.epaNumber}
                onChange={(e) => onChange("epaNumber", e.target.value)}
              />
              <Button small variant="subtle" loading={saving} onClick={() => void saveToLog()}>
                Save to log
              </Button>
            </div>
          </>
        ) : matched?.epaNumber ? (
          <p className="muted small" style={{ margin: 0 }}>
            EPA #{matched.epaNumber}
            {matched.activeIngredient ? ` · ${matched.activeIngredient}` : ""}
          </p>
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
        <ErrorNote error={error} />
        <Button small variant="ghost" onClick={onRemove}>
          ✕ Remove product
        </Button>
      </div>
    </div>
  );
}
