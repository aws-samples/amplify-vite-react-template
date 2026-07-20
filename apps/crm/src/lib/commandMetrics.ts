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
  occurredAt: string;
};

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

/** True first-response time: earliest LeadActivity.occurredAt after the
 *  lead's createdAt — never a stage total. */
export function firstResponseStats(
  leads: MetricLead[],
  activities: MetricActivity[],
  sinceMs: number
): FirstResponseStats {
  const created = windowLeads(leads, sinceMs);
  const earliestByLead = new Map<string, number>();
  for (const a of activities) {
    const t = Date.parse(a.occurredAt);
    const prev = earliestByLead.get(a.customerId);
    if (prev == null || t < prev) earliestByLead.set(a.customerId, t);
  }
  const minutes: number[] = [];
  let notYet = 0;
  for (const l of created) {
    const createdMs = Date.parse(l.createdAt!);
    const first = earliestByLead.get(l.id);
    if (first == null || first < createdMs) {
      if (first == null) notYet++;
      else minutes.push(0); // recorded activity at/before creation — instant
      continue;
    }
    minutes.push((first - createdMs) / 60_000);
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
  /** Visits COMPLETED in the window — the callback-rate denominator. */
  completedVisits: number;
  /** Guarantee callbacks requested in the window. */
  callbacksRequested: number;
  /** callbacksRequested / completedVisits, whole percent. */
  callbackPct: number | null;
  /** Customers with 2+ callbacks in the window. */
  repeatCallbackCustomers: number;
  /** Customers with 1+ callback in the window — the repeat denominator. */
  callbackCustomers: number;
  repeatPct: number | null;
};

/** Callback + repeat-callback rates from the GL-10 lifecycle rows. */
export function callbackStats(
  callbacks: MetricCallback[],
  jobs: MetricJob[],
  sinceMs: number
): CallbackStats {
  const completed = jobs.filter(
    (j) =>
      j.status === "COMPLETED" &&
      inWindow(j.completedAt ?? j.scheduledDate, sinceMs)
  );
  const requested = callbacks.filter((c) =>
    inWindow(c.createdAt ?? c.acceptedOn, sinceMs)
  );
  const byCustomer = new Map<string, number>();
  for (const c of requested) {
    const key = c.customerId ?? c.id;
    byCustomer.set(key, (byCustomer.get(key) ?? 0) + 1);
  }
  const repeat = [...byCustomer.values()].filter((n) => n >= 2).length;
  return {
    completedVisits: completed.length,
    callbacksRequested: requested.length,
    callbackPct: completed.length
      ? Math.round((requested.length / completed.length) * 100)
      : null,
    repeatCallbackCustomers: repeat,
    callbackCustomers: byCustomer.size,
    repeatPct: byCustomer.size
      ? Math.round((repeat / byCustomer.size) * 100)
      : null,
  };
}
