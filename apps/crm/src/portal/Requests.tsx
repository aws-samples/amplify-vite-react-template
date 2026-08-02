import { useCallback, useEffect, useState } from "react";
import {
  api,
  listAll,
  opResult,
  type CallbackRequest,
  type Customer,
  type Job,
  type PortalRequest,
} from "../lib/api";
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
  Page,
  SegControl,
  Spinner,
} from "../ui/kit";
import { DateField } from "../components/DateTimeFields";
import { loadMyCustomers } from "./portalData";

/**
 * GL-11 — the portal's request center. A customer (or a group manager, for
 * any customer in their group — loadMyCustomers already spans the group's
 * dynamic access) can:
 *  - request a RESCHEDULE of an upcoming visit,
 *  - request a guarantee CALLBACK on a completed plan visit (photo
 *    REQUIRED; the server enforces every locked eligibility rule and
 *    returns the reference + 7-business-day promise),
 *  - ask for general HELP.
 * Every submission is a durable case shown right here with its status and
 * the office's recorded answer — a failed submission errors visibly to
 * retry; nothing falls back to an untracked phone call.
 */

type Mode = "RESCHEDULE" | "CALLBACK" | "HELP";

export default function PortalRequests() {
  const roles = useRoles();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [requests, setRequests] = useState<PortalRequest[]>([]);
  const [callbacks, setCallbacks] = useState<CallbackRequest[]>([]);
  const [mode, setMode] = useState<Mode>("RESCHEDULE");
  const [customerId, setCustomerId] = useState("");
  const [jobId, setJobId] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [message, setMessage] = useState("");
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (roles.loading) return;
    try {
      const mine = await loadMyCustomers(roles);
      setCustomers(mine);
      if (mine.length && !customerId) setCustomerId(mine[0].id);
      const jobLists = await Promise.all(
        mine.map((c) =>
          listAll((t) =>
            api().models.Job.list({
              filter: { customerId: { eq: c.id } },
              limit: 200,
              nextToken: t,
            })
          )
        )
      );
      setJobs(jobLists.flat());
      const models = api().models as unknown as {
        PortalRequest?: {
          listPortalRequestByCustomerId: (a: {
            customerId: string;
            limit?: number;
            nextToken?: string | null;
          }) => Promise<{ data: PortalRequest[]; nextToken?: string | null }>;
        };
        CallbackRequest?: {
          listCallbackRequestByCustomerId: (a: {
            customerId: string;
            limit?: number;
            nextToken?: string | null;
          }) => Promise<{ data: CallbackRequest[]; nextToken?: string | null }>;
        };
      };
      if (models.PortalRequest) {
        const portalRequests = models.PortalRequest;
        const lists = await Promise.all(
          mine.map((c) =>
            listAll((t) =>
              portalRequests.listPortalRequestByCustomerId({
                customerId: c.id,
                limit: 50,
                nextToken: t,
              })
            )
          )
        );
        setRequests(lists.flat());
      }
      if (models.CallbackRequest) {
        const callbackRequests = models.CallbackRequest;
        const lists = await Promise.all(
          mine.map((c) =>
            listAll((t) =>
              callbackRequests.listCallbackRequestByCustomerId({
                customerId: c.id,
                limit: 50,
                nextToken: t,
              })
            )
          )
        );
        setCallbacks(lists.flat());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roles]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!customers) {
    return (
      <Page title="Requests" back="/portal">
        <ErrorNote error={error} />
        <Spinner />
      </Page>
    );
  }

  const today = todayEastern();
  const upcoming = jobs.filter(
    (j) =>
      j.customerId === customerId &&
      (j.status === "UNSCHEDULED" ||
        (j.status === "SCHEDULED" && (j.scheduledDate ?? "") >= today))
  );
  const completedPlanVisits = jobs.filter(
    (j) =>
      j.customerId === customerId &&
      j.status === "COMPLETED" &&
      j.servicePlanId &&
      !callbacks.some((cb) => cb.originalJobId === j.id)
  );

  const uploadPhoto = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const res = opResult<{ uploadUrl: string; key: string }>(
        await api().mutations.getCallbackPhotoUploadUrl({
          customerId,
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
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      if (mode === "CALLBACK") {
        if (!jobId) throw new Error("Pick the visit the problem relates to");
        if (!photoKey) {
          throw new Error(
            "A photo of what you're seeing is required for a callback"
          );
        }
        const res = opResult<{
          reference: string;
          promisedBy: string;
          status: string;
        }>(
          await api().mutations.requestCallback({
            customerId,
            originalJobId: jobId,
            photoKey,
            note: message.trim() || undefined,
          })
        );
        setConfirmation(
          res?.status === "ALREADY_REQUESTED"
            ? `That visit already has a callback (${res.reference}) — we'll return by ${res.promisedBy}.`
            : `Callback received — reference ${res?.reference}. We'll respond within one business day and return no later than ${res?.promisedBy}.`
        );
      } else {
        const res = opResult<{ reference: string }>(
          await api().mutations.submitPortalRequest({
            customerId,
            kind: mode,
            jobId: mode === "RESCHEDULE" ? jobId : undefined,
            preferredDate:
              mode === "RESCHEDULE" && preferredDate ? preferredDate : undefined,
            message: message.trim() || undefined,
          })
        );
        setConfirmation(
          `Request received — reference ${res?.reference}. We'll respond within one business day; you can watch it below.`
        );
      }
      setJobId("");
      setPreferredDate("");
      setMessage("");
      setPhotoKey(null);
      await load();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "The request didn't go through — nothing was saved. Please try again."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Requests" back="/portal">
      <Card>
        {customers.length > 1 ? (
          <Field label="For">
            <select
              value={customerId}
              onChange={(e) => {
                setCustomerId(e.target.value);
                setJobId("");
              }}
            >
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <SegControl
          options={[
            { value: "RESCHEDULE" as Mode, label: "Reschedule" },
            { value: "CALLBACK" as Mode, label: "Callback" },
            { value: "HELP" as Mode, label: "Help" },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setJobId("");
            setPhotoKey(null);
            setConfirmation(null);
            setError(null);
          }}
        />
        {mode === "RESCHEDULE" ? (
          <>
            <Field label="Which visit?">
              <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">Pick a visit…</option>
                {upcoming.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.serviceType} —{" "}
                    {j.scheduledDate ? fmtDate(j.scheduledDate, true) : "unscheduled"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Preferred day (optional)">
              <DateField value={preferredDate} onChange={setPreferredDate} />
            </Field>
          </>
        ) : null}
        {mode === "CALLBACK" ? (
          <>
            <p className="muted small" style={{ margin: "8px 0 0" }}>
              The guarantee covers completed visits on an active service plan.
              A photo of what you&rsquo;re seeing is required, and each visit
              can have one callback — we&rsquo;ll return within 7 business
              days at no charge if it&rsquo;s covered.
            </p>
            <Field label="Which completed visit?">
              <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">Pick a visit…</option>
                {completedPlanVisits.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.serviceType} —{" "}
                    {j.scheduledDate ? fmtDate(j.scheduledDate, true) : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Photo of what you're seeing (required)">
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadPhoto(f);
                }}
              />
            </Field>
            {photoKey ? <Badge tone="ok">photo attached</Badge> : null}
          </>
        ) : null}
        <Field
          label={
            mode === "HELP"
              ? "What do you need help with?"
              : "Anything we should know? (optional)"
          }
        >
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              mode === "HELP" ? "e.g. a question about your plan or a visit" : ""
            }
          />
        </Field>
        {confirmation ? (
          <p className="small" role="status">
            {confirmation}
          </p>
        ) : null}
        <ErrorNote error={error} />
        <Button block loading={busy} onClick={() => void submit()}>
          {mode === "RESCHEDULE"
            ? "Request the reschedule"
            : mode === "CALLBACK"
              ? "Request the callback"
              : "Send the request"}
        </Button>
      </Card>

      <Card title="Your requests">
        {requests.length === 0 && callbacks.length === 0 ? (
          <EmptyState
            title="No requests yet"
            body="Anything you submit shows here with its status and our answer."
          />
        ) : (
          <>
            {callbacks.map((cb) => (
              <ListRow
                key={cb.id}
                title={`Callback ${cb.id}`}
                subtitle={
                  cb.status === "GUARANTEE_ENDED"
                    ? `The technician's finding concluded the guarantee${cb.findingNote ? `: ${cb.findingNote}` : ""}`
                    : cb.scheduledDate
                      ? `Scheduled ${fmtDate(cb.scheduledDate, true)} — no charge`
                      : `We'll return no later than ${cb.promisedBy ?? "—"}`
                }
                meta={
                  <Badge
                    tone={
                      cb.status === "GUARANTEE_ENDED"
                        ? "muted"
                        : cb.status === "REQUESTED"
                          ? "info"
                          : "ok"
                    }
                  >
                    {cb.status.replace(/_/g, " ").toLowerCase()}
                  </Badge>
                }
              />
            ))}
            {requests
              .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
              .map((r) => (
                <ListRow
                  key={r.id}
                  title={r.kind === "RESCHEDULE" ? "Reschedule request" : "Help request"}
                  subtitle={
                    r.status === "RESOLVED"
                      ? `Answered: ${r.resolutionNote ?? ""}`
                      : `${r.message ?? r.preferredDate ?? ""} — we'll respond within one business day`
                  }
                  meta={
                    <Badge tone={r.status === "RESOLVED" ? "ok" : "info"}>
                      {r.status === "RESOLVED" ? "answered" : "with our office"}
                    </Badge>
                  }
                />
              ))}
          </>
        )}
      </Card>
    </Page>
  );
}
