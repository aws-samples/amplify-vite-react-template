import type { AppSyncIdentity } from "aws-lambda";
import { callerIsOffice } from "./authz";
import { hasCurrentLicense } from "./compliance";
import { dataClient } from "./dataClient";
import { assertCanReadJob, technicianForCaller } from "./jobAssignment";
import { openOwnedWork } from "./ownedWork";

/**
 * GL-13 row-scoping — the technician read surface.
 *
 * The Job, Customer, Route, Technician, and ServiceReport models no longer grant
 * TECH a model read: knowing a record id must not let one technician list, fetch,
 * or subscribe to another worker's rows through the raw model API. Instead the
 * field app reads its day and its jobs through these two server-scoped queries,
 * which authenticate as the caller and return only that caller's own authorized
 * work. Both run in the crm-docs Lambda under IAM (dataClient), so the removal of
 * the TECH grant does not affect them — the scoping is done here, in code.
 *
 * Office/owner callers are trusted (audited scheduling + emergency access) and may
 * view any technician's day and any job. A TECH caller is pinned to their own
 * linked Technician record; any technicianId they pass is ignored.
 */

// Customer is reduced to the visit fields a technician may see (GL-13 field
// least-privilege), enforced here as well as by field-level @auth on the model.
const CUSTOMER_VISIT_FIELDS = [
  "id",
  "displayName",
  "contactName",
  "email",
  "phone",
  "serviceStreet",
  "serviceCity",
  "serviceState",
  "serviceZip",
] as const;

type AnyRecord = Record<string, unknown>;

function pickCustomer(c: AnyRecord | null | undefined): AnyRecord | null {
  if (!c) return null;
  const out: AnyRecord = {};
  for (const f of CUSTOMER_VISIT_FIELDS) out[f] = c[f] ?? null;
  return out;
}

// The Job row a technician works from — everything on the dispatch packet EXCEPT
// the money fields, which the field never needs (mirrors the field-auth choice
// on Customer/plan pricing). The row itself is already scoped to the caller.
function pickJob(j: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...j };
  delete out.priceCents;
  delete out.paidPaymentIntentId;
  return out;
}

/** Page a dataClient list to exhaustion — a truck's stops, or the roster, must
 *  never silently truncate at one page. */
async function listAll<T>(
  fetchPage: (nextToken?: string) => Promise<{ data: T[]; nextToken?: string | null }>
): Promise<T[]> {
  const out: T[] = [];
  let token: string | null | undefined;
  do {
    const page = await fetchPage(token ?? undefined);
    out.push(...page.data);
    token = page.nextToken;
  } while (token);
  return out;
}

export type TechnicianDayResult = {
  /** A TECH login nobody linked to a Technician record — the client shows the
   *  "ask the office to link you" empty state instead of a broken day. */
  unlinked?: boolean;
  /** The caller's technician record is INACTIVE — access has ended. The client
   *  shows "access ended — talk to the office" and purges local drafts. */
  accessEnded?: boolean;
  /** Employed but no current licence: no current/future route or new customer
   *  context is served; completed personal history stays reviewable. */
  licenseLapsed?: boolean;
  technicianId: string | null;
  technicianName: string | null;
  /** Office may pick another technician's day; a TECH cannot. */
  canPickTechnician: boolean;
  /** Roster for the office picker; always empty for a TECH caller. */
  technicians: { id: string; name: string }[];
  route: {
    id: string;
    date: string | null;
    status: string | null;
    notes: string | null;
  } | null;
  jobs: AnyRecord[];
  customers: Record<string, AnyRecord>;
};

/**
 * The caller's route for `date`, its stops, and the customers on those stops —
 * scoped to the signed-in technician (office may target any technician).
 */
export async function buildTechnicianDay(
  identity: AppSyncIdentity | undefined | null,
  args: { date?: string | null; technicianId?: string | null }
): Promise<TechnicianDayResult> {
  const client = await dataClient();
  const office = callerIsOffice(identity);

  let technicianId: string | null = null;
  let technicianName: string | null = null;
  let technicians: { id: string; name: string }[] = [];

  if (office) {
    const roster = await listAll((nextToken) =>
      client.models.Technician.list({ limit: 200, nextToken })
    );
    technicians = (roster as AnyRecord[])
      .filter((t) => t.active)
      .map((t) => ({ id: String(t.id), name: String(t.name ?? "") }));
    technicianId = args.technicianId ?? technicians[0]?.id ?? null;
    technicianName =
      technicians.find((t) => t.id === technicianId)?.name ?? null;
  } else {
    // A TECH is pinned to their own record; any technicianId argument is ignored.
    const tech = await technicianForCaller(identity);
    if (!tech) return emptyDay({ unlinked: true, canPick: false });
    // GL-13: an inactive (offboarded/deactivated) technician receives no field
    // data at the code layer, even while a token is still unexpired — not
    // merely an empty route, an explicit access-ended state the client uses to
    // purge its local cache.
    if (!tech.active) {
      return emptyDay({ accessEnded: true, canPick: false });
    }
    // Employed but no current licence: no current/future route or new customer
    // context. Their own completed jobs stay reviewable via technicianJob.
    if (!hasCurrentLicense(tech)) {
      return emptyDay({
        licenseLapsed: true,
        technicianId: tech.id,
        technicianName: tech.name ?? null,
        canPick: false,
      });
    }
    technicianId = tech.id;
    technicianName = tech.name ?? null;
  }

  if (!technicianId || !args.date) {
    return emptyDay({ technicianId, technicianName, canPick: office, technicians });
  }

  const routes = await listAll((nextToken) =>
    client.models.Route.listRouteByTechnicianIdAndDate(
      { technicianId: technicianId!, date: { eq: args.date! } },
      { nextToken }
    )
  );
  const route = (routes as AnyRecord[])[0] ?? null;
  if (!route) {
    return emptyDay({ technicianId, technicianName, canPick: office, technicians });
  }

  // routeId has no index, so the filter runs post-scan; page to exhaustion or
  // stops silently fall off the day.
  const jobRows = await listAll((nextToken) =>
    client.models.Job.list({
      filter: { routeId: { eq: String(route.id) } },
      limit: 200,
      nextToken,
    })
  );

  // GL-13: the day is built from the route, but the route is not the authority
  // — the ASSIGNMENT is. Each stop gets the same per-job check a single job
  // read gets (job.technicianId === the day's technician). A mismatched job —
  // a partial or inconsistent reassignment — is WITHHELD from a technician
  // caller (it may be another technician's customer) and becomes owned
  // Operations work; office sees it flagged, since they own the fix.
  const matched: AnyRecord[] = [];
  const mismatched: AnyRecord[] = [];
  for (const j of jobRows as AnyRecord[]) {
    if (String(j.technicianId ?? "") === String(technicianId)) matched.push(j);
    else mismatched.push(j);
  }
  for (const j of mismatched) {
    await openOwnedWork({
      kind: "ROUTE_MISMATCH",
      dedupeKey: `route-mismatch:${String(j.id)}`,
      title: "A visit's route and assigned technician disagree",
      detail: `Job ${String(j.id)}${j.scheduledDate ? ` (${String(j.scheduledDate)})` : ""} sits on route ${String(route.id)} (${technicianName ?? technicianId}), but its assigned technician is ${j.technicianId ? String(j.technicianId) : "nobody"}. The stop was withheld from the technician's day until the route and assignment agree.`,
      relatedId: String(j.id),
      sourceUrl: "/schedule",
      resolutionAction:
        "On the Schedule board, re-assign the visit so its route and technician agree (or unassign it back to the pool), then confirm it appears on the right day.",
      ownerTeam: "OPS",
    });
  }
  const visible: AnyRecord[] = office
    ? [
        ...matched,
        ...mismatched.map((j): AnyRecord => ({ ...j, assignmentMismatch: true })),
      ]
    : matched;
  const jobs = visible
    .slice()
    .sort((a, b) => Number(a.routeOrder ?? 0) - Number(b.routeOrder ?? 0))
    .map(pickJob);

  const customers: Record<string, AnyRecord> = {};
  const ids = [...new Set(jobs.map((j) => String(j.customerId)))];
  const loaded = await Promise.all(
    ids.map((id) => client.models.Customer.get({ id }))
  );
  for (const res of loaded) {
    const c = pickCustomer((res as { data?: AnyRecord | null }).data);
    if (c) customers[String(c.id)] = c;
  }

  return {
    technicianId,
    technicianName,
    canPickTechnician: office,
    technicians,
    route: {
      id: String(route.id),
      date: (route.date as string) ?? null,
      status: (route.status as string) ?? null,
      notes: (route.notes as string) ?? null,
    },
    jobs,
    customers,
  };
}

function emptyDay(opts: {
  unlinked?: boolean;
  accessEnded?: boolean;
  licenseLapsed?: boolean;
  technicianId?: string | null;
  technicianName?: string | null;
  canPick: boolean;
  technicians?: { id: string; name: string }[];
}): TechnicianDayResult {
  return {
    unlinked: opts.unlinked,
    accessEnded: opts.accessEnded,
    licenseLapsed: opts.licenseLapsed,
    technicianId: opts.technicianId ?? null,
    technicianName: opts.technicianName ?? null,
    canPickTechnician: opts.canPick,
    technicians: opts.technicians ?? [],
    route: null,
    jobs: [],
    customers: {},
  };
}

export type TechnicianJobResult = {
  job: AnyRecord;
  customer: AnyRecord | null;
  reports: AnyRecord[];
  /** The caller's OWN technician record (null for an office viewer) — identity
   *  for the report is the signed-in user, never the job's assigned tech. */
  technician: {
    id: string;
    name: string | null;
    active: boolean | null;
    userSub: string | null;
  } | null;
  catalog: AnyRecord[];
  priorVisits: AnyRecord[];
};

/**
 * One job and everything the field screen needs for it — but only if the caller
 * is its current assignee (or office). A non-assignee, or a known id for another
 * technician's job, gets the same opaque refusal as a missing job.
 */
export async function buildTechnicianJob(
  identity: AppSyncIdentity | undefined | null,
  jobId: string
): Promise<TechnicianJobResult> {
  const client = await dataClient();
  const { data: job } = await client.models.Job.get({ id: jobId });
  // Row-scoping proof. Throws the opaque refusal unless office or the assignee.
  await assertCanReadJob(identity, job);
  const j = job as unknown as AnyRecord;

  const [customerRes, reportsRes, priorRes, catalogRes] = await Promise.all([
    client.models.Customer.get({ id: String(j.customerId) }),
    client.models.ServiceReport.listServiceReportByJobId({ jobId }),
    client.models.Job.list({
      filter: { customerId: { eq: String(j.customerId) } },
      limit: 200,
    }),
    client.models.Product.list({ limit: 500 }),
  ]);

  const tech = await technicianForCaller(identity);

  // GL-13: a still-employed technician with NO current licence is reviewing
  // their own completed record (assertCanReadJob already restricted them to
  // their own COMPLETED jobs). That review does not grant NEW customer context:
  // no other-visit history, and only the reports they personally authored.
  const lapsedReview =
    !callerIsOffice(identity) && tech != null && !hasCurrentLicense(tech);

  const priorVisits = lapsedReview
    ? []
    : ((priorRes.data as AnyRecord[]) ?? [])
        .filter((v) => v.id !== j.id)
        .map((v) => ({
          id: v.id,
          status: v.status,
          serviceType: v.serviceType ?? null,
          scheduledDate: v.scheduledDate ?? null,
          noAccessReason: v.noAccessReason ?? null,
        }));

  const catalog = ((catalogRes.data as AnyRecord[]) ?? []).filter(
    (p) =>
      p.active &&
      p.labelApproved &&
      typeof p.epaNumber === "string" &&
      p.epaNumber.trim() &&
      typeof p.defaultRate === "string" &&
      p.defaultRate.trim() &&
      p.reEntryHours != null
  );

  const reports = lapsedReview
    ? ((reportsRes.data as AnyRecord[]) ?? []).filter(
        (r) => String(r.technicianId ?? "") === String(tech?.id ?? "")
      )
    : ((reportsRes.data as AnyRecord[]) ?? []);

  return {
    job: pickJob(j),
    customer: pickCustomer((customerRes as { data?: AnyRecord | null }).data),
    reports,
    technician: tech
      ? {
          id: tech.id,
          name: tech.name ?? null,
          active: tech.active ?? null,
          userSub: tech.userSub ?? null,
        }
      : null,
    catalog,
    priorVisits,
  };
}
