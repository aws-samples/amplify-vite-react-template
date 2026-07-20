import { dataClient } from "./dataClient";
import { addBusinessDays } from "./businessDays";
import { customerAccessGroups } from "./dynamicGroups";
import { emailShell, notifyOffice, sendEmail } from "./email";
import { casGuardedUpdate } from "./atomicLock";
import { openOwnedWork, resolveOwnedWork } from "./ownedWork";
import { verifyCallbackPhoto } from "./photoVerify";
import {
  onsiteMinutes,
  releaseSlot,
  reserveSlot,
  techBaseFor,
  windowOfTimeWindow,
} from "./capacity";
import {
  assertDispatchFacts,
  proveRoutable,
  type DispatchCustomer,
} from "./dispatchReadiness";

/**
 * GL-10 — the guarantee callback lifecycle.
 *
 * The locked rules, enforced here and nowhere else:
 *  - Only an ACTIVE residual-service subscription qualifies; one-time work
 *    is ineligible. The request must name a COMPLETED original appointment
 *    belonging to the same customer/plan.
 *  - A customer photo is REQUIRED before anything is scheduled, and it is
 *    retained on the request.
 *  - One original appointment permits AT MOST one callback, enforced by the
 *    deterministic id `cb-<originalJobId>` (a conditional create — two
 *    submissions collapse; the second is told about the first).
 *  - The customer receives a reference immediately, an owned Office
 *    response within one business day, and a promised return no later than
 *    7 BUSINESS days after acceptance (weekends and tracked closures do not
 *    count).
 *  - The callback technician records a CONTROLLED, evidenced finding:
 *    TREATABLE_UNEXPECTED continues the guarantee through completion;
 *    UNTREATABLE_CONDITION or EXPECTED_BEHAVIOR ends the guarantee with the
 *    evidence and one final customer notice (claim-marked — replays cannot
 *    re-send), and the CRM promises no further callback or appeal.
 *  - Nobody chooses or calculates money anywhere in this flow — a callback
 *    visit is $0 by construction.
 */

export const CALLBACK_RETURN_BUSINESS_DAYS = 7;

export const CALLBACK_FINDINGS = new Set([
  "TREATABLE_UNEXPECTED",
  "UNTREATABLE_CONDITION",
  "EXPECTED_BEHAVIOR",
]);

export function callbackIdFor(originalJobId: string): string {
  return `cb-${originalJobId}`;
}

type Requester = { email: string | null; isOffice: boolean };

export async function requestCallback(
  opts: {
    customerId: string;
    originalJobId: string;
    photoKey: string;
    note?: string | null;
  },
  requester: Requester
): Promise<{
  reference: string;
  promisedBy: string;
  status: "ACCEPTED" | "ALREADY_REQUESTED";
}> {
  const client = await dataClient();
  if (!("CallbackRequest" in client.models)) {
    throw new Error("Callback requests are not available right now — call the office.");
  }
  if (!opts.photoKey?.trim()) {
    throw new Error(
      "A photo of what you're seeing is required before a callback can be scheduled."
    );
  }
  // "Required" means a VERIFIED upload: the key must live under this
  // customer's callback prefix and reference a real image object — a
  // plausible-looking string (or another customer's key) is refused.
  await verifyCallbackPhoto(opts.photoKey, opts.customerId);
  const { data: customer } = await client.models.Customer.get({
    id: opts.customerId,
  });
  if (!customer) throw new Error("Customer not found");
  const { data: original } = await client.models.Job.get({
    id: opts.originalJobId,
  });
  if (!original || original.customerId !== opts.customerId) {
    throw new Error("That appointment doesn't belong to this account.");
  }
  if (original.status !== "COMPLETED") {
    throw new Error(
      "The guarantee covers completed visits — this appointment hasn't been completed."
    );
  }
  // Eligibility: the ORIGINAL visit must belong to an ACTIVE residual
  // subscription. One-time work is never guarantee-eligible.
  if (!original.servicePlanId) {
    throw new Error(
      "The guarantee applies to active service plans — one-time visits aren't covered. If something's wrong, call the office and we'll help."
    );
  }
  const { data: plan } = await client.models.ServicePlan.get({
    id: original.servicePlanId,
  });
  if (!plan || plan.status !== "ACTIVE") {
    throw new Error(
      "The guarantee applies while the service plan is active. This plan isn't active — call the office and we'll help."
    );
  }

  const id = callbackIdFor(opts.originalJobId);
  const acceptedOn = new Date().toISOString().slice(0, 10);
  const promisedBy = await addBusinessDays(
    acceptedOn,
    CALLBACK_RETURN_BUSINESS_DAYS
  );
  const accessGroups = customerAccessGroups(
    opts.customerId,
    customer.groupId ?? undefined
  );
  const { data: created } = await client.models.CallbackRequest.create({
    id,
    customerId: opts.customerId,
    originalJobId: opts.originalJobId,
    servicePlanId: original.servicePlanId,
    photoKey: opts.photoKey.trim(),
    note: opts.note?.trim() || undefined,
    status: "REQUESTED",
    acceptedOn,
    promisedBy,
    accessGroups,
  });
  if (!created) {
    // One callback per original appointment — the deterministic id makes the
    // second submission collapse onto the first, and the customer is told.
    const { data: existing } = await client.models.CallbackRequest.get({ id });
    return {
      reference: id,
      promisedBy: existing?.promisedBy ?? promisedBy,
      status: "ALREADY_REQUESTED",
    };
  }

  await openOwnedWork({
    kind: "CALLBACK_PROMISE",
    dedupeKey: id,
    title: `Schedule a guarantee callback: ${customer.displayName ?? opts.customerId}`,
    detail: `A guarantee callback was requested for completed visit ${opts.originalJobId} (plan ${original.servicePlanId}). The photo is on the request. Promise: an owned response within one business day, and the return visit no later than ${promisedBy} (${CALLBACK_RETURN_BUSINESS_DAYS} business days). Schedule it from the customer screen — the visit is $0 by construction.`,
    customerId: opts.customerId,
    relatedId: id,
    sourceUrl: `/customers/${opts.customerId}`,
    resolutionAction:
      "Open the customer, schedule the callback visit onto a technician (no later than the promised date), and confirm the customer knows the day.",
    ownerTeam: "OPS",
  });

  if (customer.email) {
    await sendEmail({
      to: customer.email,
      subject: `Callback request received — reference ${id}`,
      template: "callback-received",
      customerId: opts.customerId,
      relatedId: id,
      html: emailShell(
        "We got your callback request",
        `<p>Hi ${customer.displayName ?? "there"},</p>
         <p>Your guarantee callback request is in — reference <strong>${id}</strong>.</p>
         <p>Our team will respond within one business day, and if the activity is covered by your plan's guarantee, we'll return <strong>no later than ${promisedBy}</strong> at no charge.</p>
         <p style="color:#666;font-size:13px;">The technician will confirm on site whether what you're seeing is treatable, unexpected activity covered by the guarantee.</p>`
      ),
    }).catch(() => undefined);
  }
  await notifyOffice({
    subject: `Guarantee callback requested: ${customer.displayName ?? opts.customerId}`,
    heading: "A guarantee callback needs scheduling",
    template: "ops-callback-requested",
    customerId: opts.customerId,
    relatedId: id,
    bodyHtml: `<p><strong>${customer.displayName ?? opts.customerId}</strong> requested a guarantee callback on visit ${opts.originalJobId}. Return promised by <strong>${promisedBy}</strong>. The photo is attached to the request; schedule it from the customer screen.</p>`,
  }).catch(() => undefined);

  return { reference: id, promisedBy, status: "ACCEPTED" };
}

export async function scheduleCallback(opts: {
  callbackRequestId: string;
  scheduledDate: string;
  timeWindow?: string | null;
  /** The technician whose real capacity the visit consumes — a callback is
   *  a real slot on a real route, never free-floating schedule text. */
  technicianId: string;
  /** The customer explicitly asked for a date beyond the promise — recorded,
   *  never assumed. */
  customerRequestedLater?: boolean | null;
}): Promise<{ callbackJobId: string; scheduledDate: string }> {
  const client = await dataClient();
  const { data: cb } = await client.models.CallbackRequest.get({
    id: opts.callbackRequestId,
  });
  if (!cb) throw new Error("Callback request not found");
  if (cb.status === "GUARANTEE_ENDED") {
    throw new Error("This guarantee was ended by the technician's finding.");
  }
  if (cb.callbackJobId) {
    return {
      callbackJobId: cb.callbackJobId,
      scheduledDate: opts.scheduledDate,
    };
  }
  if (
    cb.promisedBy &&
    opts.scheduledDate > cb.promisedBy &&
    !opts.customerRequestedLater
  ) {
    throw new Error(
      `That date is after the promised return (${cb.promisedBy}). Pick an earlier day — or, if the customer asked for a later date, record that choice.`
    );
  }
  if (!opts.technicianId?.trim()) {
    throw new Error(
      "Pick the technician for the callback visit — it takes real minutes on a real route, so it schedules onto real capacity like every other visit."
    );
  }
  const { data: original } = await client.models.Job.get({
    id: cb.originalJobId,
  });
  const { data: customer } = await client.models.Customer.get({
    id: cb.customerId,
  });
  if (!customer) throw new Error("Customer not found");

  // GL-10 + GL-04: a callback visit is CAPACITY-SAFE — the same dispatch
  // facts, routability proof, and ONE atomic technician-window slot claim
  // as every other assignment. $0 changes the price, not the minutes.
  assertDispatchFacts(customer as DispatchCustomer, {
    propertyClass: (original as { propertyClass?: string | null } | null)
      ?.propertyClass,
    serviceType: original?.serviceType ?? "guarantee callback",
  });
  const base = await techBaseFor(opts.technicianId, opts.scheduledDate);
  if (!base) {
    throw new Error(
      "That technician isn't schedulable that day (inactive, unlicensed, or not a working day). Pick another technician or day."
    );
  }
  const routeProof = await proveRoutable(
    process.env.GOOGLE_ROUTES_API_KEY,
    base,
    customer as DispatchCustomer
  );
  const targetWindow = windowOfTimeWindow(opts.timeWindow ?? null);
  const slotMinutes =
    onsiteMinutes(
      (original as { propertyClass?: string | null } | null)?.propertyClass
    ) + (routeProof ? routeProof.driveMinutes * 2 : 0);
  const reserved = await reserveSlot(
    opts.scheduledDate,
    targetWindow,
    opts.technicianId,
    slotMinutes
  );
  if (!reserved.ok) throw new Error(reserved.message);
  const giveBack = () =>
    releaseSlot(
      opts.scheduledDate,
      targetWindow,
      opts.technicianId,
      slotMinutes
    ).catch(() => undefined);

  const callbackJobId = `cbjob-${cb.id}`;
  let job: Record<string, unknown> | null = null;
  try {
    job = (
      await client.models.Job.create({
        id: callbackJobId,
        customerId: cb.customerId,
        servicePlanId: cb.servicePlanId ?? undefined,
        type: "ONE_TIME",
        serviceType: `${original?.serviceType ?? "Service"} — guarantee callback`,
        serviceCode: (original as { serviceCode?: string | null } | null)?.serviceCode ?? undefined,
        catalogVersion:
          (original as { catalogVersion?: string | null } | null)?.catalogVersion ??
          undefined,
        // $0 by construction — nobody chooses or calculates a fee anywhere.
        priceCents: null,
        status: "SCHEDULED",
        scheduledDate: opts.scheduledDate,
        timeWindow: opts.timeWindow ?? undefined,
        technicianId: opts.technicianId,
        capacityWindow: targetWindow,
        capacityMinutes: slotMinutes,
        ...(routeProof
          ? {
              dispatchDriveMinutes: routeProof.driveMinutes,
              dispatchRouteCheckedAt: routeProof.checkedAt,
            }
          : {}),
        propertyClass:
          (original as { propertyClass?: string | null } | null)?.propertyClass ??
          undefined,
        notes: `Guarantee callback for visit ${cb.originalJobId} (request ${cb.id}). Customer photo: ${cb.photoKey}. Original technician: ${(original as { technicianId?: string | null } | null)?.technicianId ?? "n/a"}. The technician records a controlled finding on site.`,
        accessGroups: cb.accessGroups ?? undefined,
      })
    ).data as Record<string, unknown> | null;
  } catch (err) {
    await giveBack();
    throw err;
  }
  if (!job) {
    // A previous attempt already created (and reserved for) this visit —
    // give back THIS attempt's duplicate reservation.
    await giveBack();
    const { data: existing } = await client.models.Job.get({
      id: callbackJobId,
    });
    if (!existing) throw new Error("The callback visit could not be created");
  }
  await client.models.CallbackRequest.update({
    id: cb.id,
    status: "SCHEDULED",
    callbackJobId,
    scheduledDate: opts.scheduledDate,
    customerRequestedLater: Boolean(opts.customerRequestedLater),
  });
  await resolveOwnedWork({
    kind: "CALLBACK_PROMISE",
    dedupeKey: cb.id,
    note: `Callback visit ${callbackJobId} scheduled for ${opts.scheduledDate}.`,
  });
  if (customer?.email) {
    await sendEmail({
      to: customer.email,
      subject: `Your callback is scheduled — ${opts.scheduledDate}`,
      template: "callback-scheduled",
      customerId: cb.customerId,
      relatedId: cb.id,
      html: emailShell(
        "Your callback is scheduled",
        `<p>Hi ${customer.displayName ?? "there"},</p>
         <p>Your guarantee callback (reference <strong>${cb.id}</strong>) is scheduled for <strong>${opts.scheduledDate}</strong>${opts.timeWindow ? ` (${opts.timeWindow})` : ""} at no charge.</p>
         <p style="color:#666;font-size:13px;">On site, the technician will confirm whether the activity is treatable, unexpected activity covered by your plan's guarantee.</p>`
      ),
    }).catch(() => undefined);
  }
  return { callbackJobId, scheduledDate: opts.scheduledDate };
}

export async function recordCallbackFinding(opts: {
  callbackRequestId: string;
  finding: string;
  note: string;
  photoKey?: string | null;
}): Promise<{ status: string }> {
  if (!CALLBACK_FINDINGS.has(opts.finding)) {
    throw new Error("Pick one of the controlled findings.");
  }
  if (!opts.note?.trim()) {
    throw new Error(
      "The finding needs the technician's evidence note — what was found, in plain words."
    );
  }
  const client = await dataClient();
  const { data: cb } = await client.models.CallbackRequest.get({
    id: opts.callbackRequestId,
  });
  if (!cb) throw new Error("Callback request not found");

  const continues = opts.finding === "TREATABLE_UNEXPECTED";
  const nextStatus = continues ? "COMPLETED" : "GUARANTEE_ENDED";
  // Conditional: a finding lands once; a second submission cannot flip an
  // already-terminal outcome.
  const moved = await casGuardedUpdate(
    "CallbackRequest",
    cb.id,
    {
      status: nextStatus,
      finding: opts.finding,
      findingNote: opts.note.trim().slice(0, 1000),
      findingPhotoKey: opts.photoKey?.trim() || null,
      foundAt: new Date().toISOString(),
    },
    [{ kind: "fieldIn", field: "status", values: ["REQUESTED", "SCHEDULED"] }]
  );
  if (!moved.ok) {
    const { data: current } = await client.models.CallbackRequest.get({
      id: cb.id,
    });
    return { status: current?.status ?? "UNKNOWN" };
  }

  if (!continues) {
    // The guarantee ends with evidence and ONE final notice — claim-marked so
    // a retry cannot re-send, and no further callback or appeal is promised.
    const claimed = await casGuardedUpdate(
      "CallbackRequest",
      cb.id,
      { terminalNoticeSentAt: new Date().toISOString() },
      [{ kind: "fieldMissingOrNull", field: "terminalNoticeSentAt" }]
    );
    const { data: customer } = await client.models.Customer.get({
      id: cb.customerId,
    });
    if (customer?.email && (claimed.ok || claimed.reason === "UNSUPPORTED")) {
      const explanation =
        opts.finding === "UNTREATABLE_CONDITION"
          ? "the technician found a condition that treatment cannot resolve"
          : "the activity the technician found is expected pest behavior rather than a treatable infestation";
      const sent = await sendEmail({
        to: customer.email,
        subject: "Your callback visit — the technician's finding",
        template: "callback-guarantee-ended",
        customerId: cb.customerId,
        relatedId: cb.id,
        html: emailShell(
          "Your callback visit's result",
          `<p>Hi ${customer.displayName ?? "there"},</p>
           <p>Our technician visited for your callback (reference <strong>${cb.id}</strong>). Based on what they found, ${explanation}.</p>
           <p>${opts.note.trim()}</p>
           <p>This concludes the guarantee for that appointment. Your plan's regular visits continue as scheduled, and if something new comes up we're always a call away.</p>`
        ),
      }).catch(() => false);
      if (!sent) {
        // Clear the claim so the next attempt (or the office resend) can own
        // the notice — the guard is just "the row exists".
        await casGuardedUpdate(
          "CallbackRequest",
          cb.id,
          { terminalNoticeSentAt: null },
          []
        ).catch(() => undefined);
        await openOwnedWork({
          kind: "EMAIL_FAILURE",
          dedupeKey: `callback-final:${cb.id}`,
          title: "A guarantee-ended notice didn't send",
          detail: `The technician ended the guarantee on callback ${cb.id} (${opts.finding}), but the final customer notice failed to send. The customer doesn't yet know the outcome.`,
          customerId: cb.customerId,
          relatedId: cb.id,
          resolutionAction:
            "Resend the guarantee outcome to the customer (or record an alternate delivery), then verify it arrived.",
          ownerTeam: "OPS",
        });
      }
    }
  }
  return { status: nextStatus };
}
