/**
 * GL-19 — leadership's lifecycle-derived measures, computed from DURABLE
 * facts: LeadActivity timestamps, the GL-02 per-lead fact fields, completed
 * visits, and the GL-10 callback lifecycle. Nothing here is inferred from
 * coarse stage totals or open work-item counts, and every figure names its
 * window and denominator. Pure functions — the Command view feeds them
 * fully-paged reads and shows a loud error instead of partial numbers.
 */

export type MetricLead = {
  id: string;
  createdAt?: string | null;
  lastAttemptedAt?: string | null;
  lastReachedAt?: string | null;
  qualificationStatus?: string | null;
  bookingLinkDeliveredAt?: string | null;
  convertedAt?: string | null;
  status?: string | null;
  lostReason?: string | null;
};

export type MetricActivity = {
  customerId: string;
  channel: string;
  direction?: string | null;
  outcome: string;
  occurredAt: string;
};

/** Channels that are a real attempt to communicate with the lead. Intake,
 *  lifecycle, assignment, and note events are administrative — a lead is
 *  not "answered" because the system logged its own creation. */
const COMMUNICATION_CHANNELS = new Set(["CALL", "TEXT", "EMAIL", "BOOKING_LINK"]);

/** Outcomes that are NOT a communication attempt even on a real channel —
 *  mirrors the server's GL-02 attempted rule exactly. */
const NON_ATTEMPT_OUTCOMES = new Set(["NOTE", "QUALIFIED", "UNQUALIFIED"]);

/**
 * The approved sales definition of "first response": the first genuine
 * ATTEMPTED CONTACT — a call, text, email, or booking link the team actually
 * tried (reached or not) — matching the server's GL-02 `attempted` rule.
 * The Command card labels it "first attempted contact" for the same reason
 * attempt-vs-reached exists: an attempt is not a conversation.
 */
export function isGenuineResponse(a: MetricActivity): boolean {
  return (
    COMMUNICATION_CHANNELS.has(a.channel) && !NON_ATTEMPT_OUTCOMES.has(a.outcome)
  );
}

export type MetricJob = {
  id: string;
  customerId?: string | null;
  status?: string | null;
  completedAt?: string | null;
  scheduledDate?: string | null;
};

export type MetricCallback = {
  id: string;
  customerId?: string | null;
  originalJobId?: string | null;
  createdAt?: string | null;
  acceptedOn?: string | null;
};

const inWindow = (iso: string | null | undefined, sinceMs: number): boolean =>
  Boolean(iso && Date.parse(iso) >= sinceMs);

/** Leads created inside the window. The universal denominator base. */
function windowLeads(leads: MetricLead[], sinceMs: number): MetricLead[] {
  return leads.filter((l) => inWindow(l.createdAt, sinceMs));
}

export type FirstResponseStats = {
  /** Leads created in the window — the denominator. */
  leadsCreated: number;
  /** Of those, leads with at least one recorded activity after creation. */
  responded: number;
  /** Median minutes from lead creation to the FIRST recorded activity. */
  medianMinutes: number | null;
  /** Slowest first response in the window, minutes. */
  worstMinutes: number | null;
  /** Created in the window with NO recorded activity yet. */
  notYetResponded: number;
};

/** True first-response time: the earliest GENUINE communication attempt
 *  (isGenuineResponse) strictly after the lead's creation. Administrative
 *  events (intake LIFECYCLE/NOTE rows, assignment notes, dispositions)
 *  never count, and an activity recorded before creation is ignored — it
 *  is never converted into a zero-minute response. */
export function firstResponseStats(
  leads: MetricLead[],
  activities: MetricActivity[],
  sinceMs: number
): FirstResponseStats {
  const created = windowLeads(leads, sinceMs);
  const createdMsByLead = new Map(
    created.map((l) => [l.id, Date.parse(l.createdAt!)])
  );
  const earliestByLead = new Map<string, number>();
  for (const a of activities) {
    if (!isGenuineResponse(a)) continue;
    const createdMs = createdMsByLead.get(a.customerId);
    const t = Date.parse(a.occurredAt);
    // Only activities AFTER the lead existed can answer it.
    if (createdMs == null || t < createdMs) continue;
    const prev = earliestByLead.get(a.customerId);
    if (prev == null || t < prev) earliestByLead.set(a.customerId, t);
  }
  const minutes: number[] = [];
  let notYet = 0;
  for (const l of created) {
    const first = earliestByLead.get(l.id);
    if (first == null) {
      notYet++;
      continue;
    }
    minutes.push((first - createdMsByLead.get(l.id)!) / 60_000);
  }
  minutes.sort((a, b) => a - b);
  const median =
    minutes.length === 0
      ? null
      : minutes.length % 2
        ? minutes[(minutes.length - 1) / 2]
        : (minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2;
  return {
    leadsCreated: created.length,
    responded: created.length - notYet,
    medianMinutes: median == null ? null : Math.round(median),
    worstMinutes: minutes.length ? Math.round(minutes[minutes.length - 1]) : null,
    notYetResponded: notYet,
  };
}

export type AttemptReachedStats = {
  /** Leads created in the window with at least one recorded attempt. */
  attempted: number;
  /** Of the attempted, leads actually REACHED (a real conversation). */
  reached: number;
  /** reached / attempted, whole percent; null when nothing was attempted. */
  reachedPct: number | null;
};

export function attemptVsReached(
  leads: MetricLead[],
  sinceMs: number
): AttemptReachedStats {
  const created = windowLeads(leads, sinceMs);
  const attempted = created.filter((l) => l.lastAttemptedAt);
  const reached = attempted.filter((l) => l.lastReachedAt);
  return {
    attempted: attempted.length,
    reached: reached.length,
    reachedPct: attempted.length
      ? Math.round((reached.length / attempted.length) * 100)
      : null,
  };
}

export type QualificationFunnel = {
  created: number;
  attempted: number;
  reached: number;
  qualified: number;
  unqualified: number;
  bookingSent: number;
  won: number;
  lost: number;
};

/** The qualification funnel over leads CREATED in the window, from the
 *  durable per-lead facts (each column is a fact field, not a stage total). */
export function qualificationFunnel(
  leads: MetricLead[],
  sinceMs: number
): QualificationFunnel {
  const created = windowLeads(leads, sinceMs);
  return {
    created: created.length,
    attempted: created.filter((l) => l.lastAttemptedAt).length,
    reached: created.filter((l) => l.lastReachedAt).length,
    qualified: created.filter((l) => l.qualificationStatus === "QUALIFIED")
      .length,
    unqualified: created.filter((l) => l.qualificationStatus === "UNQUALIFIED")
      .length,
    bookingSent: created.filter((l) => l.bookingLinkDeliveredAt).length,
    won: created.filter((l) => l.convertedAt || l.status === "ACTIVE").length,
    lost: created.filter((l) => l.lostReason).length,
  };
}

export type CallbackStats = {
  /** Original visits COMPLETED in the window — the cohort denominator. */
  completedVisits: number;
  /** Callbacks LINKED (originalJobId) to a cohort visit — the numerator. */
  callbacksOnCohort: number;
  /** callbacksOnCohort / completedVisits, whole percent. Cohort-tied, so a
   *  mismatch of time windows can never push it past 100. */
  callbackPct: number | null;
  /** Customers whose callbacks tie to 2+ cohort original appointments. */
  repeatCallbackCustomers: number;
  /** Customers with a callback on 1+ cohort appointment — the repeat
   *  denominator. */
  callbackCustomers: number;
  repeatPct: number | null;
};

/**
 * Callback + repeat-callback rates from the GL-10 lifecycle rows, COHORT
 * style: the denominator is original visits completed in the window, and
 * only callbacks LINKED to those exact visits (CallbackRequest.originalJobId)
 * count — a callback against an older visit never inflates this window's
 * rate, and one-callback-per-appointment bounds it at 100%.
 */
export function callbackStats(
  callbacks: MetricCallback[],
  jobs: MetricJob[],
  sinceMs: number
): CallbackStats {
  const cohort = jobs.filter(
    (j) =>
      j.status === "COMPLETED" &&
      inWindow(j.completedAt ?? j.scheduledDate, sinceMs)
  );
  const cohortIds = new Set(cohort.map((j) => j.id));
  const linked = callbacks.filter(
    (c) => c.originalJobId && cohortIds.has(c.originalJobId)
  );
  // One callback per original appointment is server-enforced; dedupe
  // defensively so replayed rows still cannot exceed the cohort.
  const byOriginal = new Map<string, MetricCallback>();
  for (const c of linked) byOriginal.set(c.originalJobId!, c);
  const appointmentsByCustomer = new Map<string, Set<string>>();
  for (const c of byOriginal.values()) {
    const key = c.customerId ?? c.id;
    const set = appointmentsByCustomer.get(key) ?? new Set<string>();
    set.add(c.originalJobId!);
    appointmentsByCustomer.set(key, set);
  }
  const repeat = [...appointmentsByCustomer.values()].filter(
    (set) => set.size >= 2
  ).length;
  return {
    completedVisits: cohort.length,
    callbacksOnCohort: byOriginal.size,
    callbackPct: cohort.length
      ? Math.round((byOriginal.size / cohort.length) * 100)
      : null,
    repeatCallbackCustomers: repeat,
    callbackCustomers: appointmentsByCustomer.size,
    repeatPct: appointmentsByCustomer.size
      ? Math.round((repeat / appointmentsByCustomer.size) * 100)
      : null,
  };
}
