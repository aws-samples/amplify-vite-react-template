import { dataClient } from "./dataClient";
import { notifyOffice } from "./email";

/**
 * GL-22 — the emergency pause switchboard (OpsControl row "pause").
 *
 * Authorized incident owners (OWNER, per the incident playbooks) can stop
 * NEW customer-facing commitments while an incident is contained:
 *  - bookingPaused: the public funnel refuses new quotes/payments;
 *  - dispatchPaused: no new visit is scheduled or assigned;
 *  - billingPaused: no charge is INITIATED (dunning retries, one-time
 *    charges, subscription starts) — refunds and reads keep working.
 *
 * Reads are memoized briefly per container and FAIL OPEN: an unreadable
 * flag must not silently take the funnel down; pausing is an explicit
 * operator action whose screen confirms it took effect.
 */

export type OpsPause = {
  bookingPaused: boolean;
  dispatchPaused: boolean;
  billingPaused: boolean;
  reason: string | null;
};

const NO_PAUSE: OpsPause = {
  bookingPaused: false,
  dispatchPaused: false,
  billingPaused: false,
  reason: null,
};

let memo: { at: number; value: OpsPause } | null = null;

export async function readOpsPause(): Promise<OpsPause> {
  if (memo && Date.now() - memo.at < 30_000) return memo.value;
  let value = NO_PAUSE;
  try {
    const client = await dataClient();
    if ("OpsControl" in client.models) {
      const { data } = await client.models.OpsControl.get({ id: "pause" });
      if (data) {
        value = {
          bookingPaused: Boolean(data.bookingPaused),
          dispatchPaused: Boolean(data.dispatchPaused),
          billingPaused: Boolean(data.billingPaused),
          reason: data.reason ?? null,
        };
      }
    }
  } catch (err) {
    console.error("readOpsPause failed — treating as not paused", err);
    value = NO_PAUSE;
  }
  memo = { at: Date.now(), value };
  return value;
}

export function _resetOpsPauseMemoForTests(): void {
  memo = null;
}

/** The OWNER mutation's writer: create-or-update the one pause row, record
 *  who/why/when, and tell the office. Omitted flags keep their value. */
export async function writeOpsPause(opts: {
  bookingPaused?: boolean | null;
  dispatchPaused?: boolean | null;
  billingPaused?: boolean | null;
  reason: string;
  actorEmail: string | null;
}): Promise<OpsPause> {
  const client = await dataClient();
  const { data: existing } = await client.models.OpsControl.get({
    id: "pause",
  });
  const next = {
    id: "pause",
    bookingPaused: opts.bookingPaused ?? existing?.bookingPaused ?? false,
    dispatchPaused: opts.dispatchPaused ?? existing?.dispatchPaused ?? false,
    billingPaused: opts.billingPaused ?? existing?.billingPaused ?? false,
    reason: opts.reason.slice(0, 500),
    actorEmail: opts.actorEmail ?? "OWNER",
    changedAt: new Date().toISOString(),
  };
  const res = existing
    ? await client.models.OpsControl.update(next)
    : await client.models.OpsControl.create(next);
  if (!res.data || res.errors?.length) {
    throw new Error("The pause change could not be recorded — nothing changed");
  }
  _resetOpsPauseMemoForTests();
  const states = [
    `new bookings ${next.bookingPaused ? "PAUSED" : "running"}`,
    `new dispatch ${next.dispatchPaused ? "PAUSED" : "running"}`,
    `billing initiation ${next.billingPaused ? "PAUSED" : "running"}`,
  ].join(" · ");
  await notifyOffice({
    subject: `Emergency controls changed: ${states}`,
    heading: "Emergency pause switchboard changed",
    template: "ops-pause-changed",
    relatedId: "pause",
    bodyHtml: `<p>${next.actorEmail} changed the emergency controls: <strong>${states}</strong>.</p><p>Reason: ${next.reason}</p>`,
  }).catch(() => undefined);
  return {
    bookingPaused: next.bookingPaused,
    dispatchPaused: next.dispatchPaused,
    billingPaused: next.billingPaused,
    reason: next.reason,
  };
}
