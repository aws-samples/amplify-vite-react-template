import { dataClient } from "./dataClient";
import { customerAccessGroups } from "./dynamicGroups";

/**
 * One-time migration of established FieldRoutes agreements into the CRM.
 *
 * The whole trick lives in the schema: a ServicePlan's `priceCents` IS the
 * locked-in price, and billing reads it verbatim (shared/subscription.ts —
 * price_data.unit_amount = plan.priceCents). No rate card, funnel, or promo
 * touches an existing plan. So migrating a locked agreement is exactly:
 * write the customer, write the plan at the agreed cents. Nothing more.
 *
 * ServicePlan/Customer have no browser create (GL-09) — only IAM Lambdas write
 * them — so this runs inside crm-migrate (IAM), never a screen.
 *
 * IDEMPOTENCY. Every CRM id is derived from FieldRoutes' own ids, so the whole
 * import is a no-op on rows that already landed: a partial run just resumes.
 * Same createOrGet contract as bookingFinalize.
 *
 * STAGES. This unit does the DATA only — group, one customer per property, the
 * plan at the locked price, and a single seed visit to continue the recurring
 * chain (recurring.ts chains off job COMPLETION, so one queued visit is enough;
 * never bulk-generate the future schedule). Portal logins (adminCreateUser) and
 * billing (startPlanBilling with a billing_cycle_anchor) are separate, opt-in
 * stages — a migrated plan sits ACTIVE-not-billing until a card is on file,
 * which the dashboard already surfaces.
 */

/** A management company / multi-property owner. Absent for a single-property
 *  customer — the group is what lets ONE portal login see every property. */
export type AgreementGroupInput = {
  /** FieldRoutes account/office id — the stable key the CRM group id derives
   *  from, so every property under it links to one group on re-run. */
  externalId: string;
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
};

export type AgreementInput = {
  /** FieldRoutes customer id — keys this property's customer record. */
  externalCustomerId: string;
  /** FieldRoutes subscription/agreement id — keys the plan. A customer with two
   *  agreements imports two plans under one customer. */
  externalSubscriptionId: string;
  group?: AgreementGroupInput;

  // Customer / property (each property is its own Customer under the group).
  displayName: string;
  contactName?: string;
  email?: string;
  phone?: string;
  serviceStreet?: string;
  serviceCity?: string;
  serviceState?: string;
  serviceZip?: string;
  /** A pre-existing Stripe customer, if cards were already migrated. */
  stripeCustomerId?: string;

  // The agreement — the numbers that must survive untouched.
  planName: string;
  /** The exact agreed price, in cents. This is the contract. */
  priceCents: number;
  serviceFrequency: "MONTHLY" | "BIMONTHLY" | "QUARTERLY";
  /** The original FieldRoutes agreement start — kept for the record; also the
   *  natural billing_cycle_anchor basis when billing is turned on later. */
  startDate?: string;
  seasonal?: boolean;
  serviceMonths?: number[];
  /** The customer's sales-tax rate (e.g. 6.25). priceCents is PRE-tax; the
   *  billing stage adds a Stripe tax rate at this percent so the customer's
   *  total (price + tax) matches what FieldRoutes charged. BuzzKill bills 0%
   *  today, so until a first-class tax field + Stripe tax-rate wiring lands
   *  this is only recorded on the plan for traceability. */
  salesTaxPercent?: number;
  /** The next known service date to seed one visit and continue the chain. */
  nextVisitDate?: string;
  serviceType: string;
  propertyClass?: "RESIDENTIAL" | "COMMUNITY" | "COMMERCIAL";
};

export type AgreementImportResult = {
  groupId: string | null;
  customerId: string;
  servicePlanId: string;
  seedJobId: string | null;
};

/** createOrGet: the create wins; on a losing race / resume, the get resolves the
 *  row a prior attempt made. Mirrors bookingFinalize.createOrGet. */
async function createOrGet<T extends { id?: string | null }>(
  what: string,
  create: () => Promise<{ data: T | null; errors?: { message: string }[] }>,
  get: () => Promise<{ data: T | null }>
): Promise<T> {
  const { data, errors } = await create();
  if (data) return data;
  const { data: existing } = await get();
  if (existing) return existing;
  throw new Error(
    `${what} could not be created or resolved: ${
      errors?.map((e) => e.message).join("; ") ?? "unknown error"
    }`
  );
}

export async function importAgreement(
  input: AgreementInput
): Promise<AgreementImportResult> {
  const client = await dataClient();

  // Deterministic ids — the FieldRoutes ids ARE the idempotency keys.
  const groupId = input.group ? `grp-fr-${input.group.externalId}` : null;
  const customerId = `cust-fr-${input.externalCustomerId}`;
  const servicePlanId = `plan-fr-${input.externalSubscriptionId}`;
  const accessGroups = customerAccessGroups(customerId, groupId);

  // 1. The group (multi-property owner / management company), if any.
  if (input.group && groupId) {
    await createOrGet(
      "customer group",
      () =>
        client.models.CustomerGroup.create({
          id: groupId,
          name: input.group!.name,
          contactName: input.group!.contactName,
          contactEmail: input.group!.contactEmail,
          contactPhone: input.group!.contactPhone,
          notes: `Imported from FieldRoutes (account ${input.group!.externalId}).`,
          // The group's own dynamic group — the login is made a member of this,
          // and every property below lists it, so one login sees them all.
          accessGroups: [`grp-${groupId}`],
        }),
      () => client.models.CustomerGroup.get({ id: groupId })
    );
  }

  // 2. The customer — one per property, its OWN address. Reusing a single
  //    customer across properties would drop every address but the first
  //    (fillIfMissing); a group of per-property customers is the model.
  await createOrGet(
    "customer",
    () =>
      client.models.Customer.create({
        id: customerId,
        groupId: groupId ?? undefined,
        displayName: input.displayName,
        contactName: input.contactName ?? input.displayName,
        email: input.email,
        phone: input.phone,
        serviceStreet: input.serviceStreet,
        serviceCity: input.serviceCity,
        serviceState: input.serviceState,
        serviceZip: input.serviceZip,
        status: "ACTIVE",
        leadSource: "FIELDROUTES_MIGRATION",
        stripeCustomerId: input.stripeCustomerId,
        convertedAt: new Date().toISOString(),
        accessGroups,
      }),
    () => client.models.Customer.get({ id: customerId })
  );

  // 3. The plan — the locked agreement. priceCents is the contract; billing
  //    reads it verbatim and never re-prices it.
  await createOrGet(
    "service plan",
    () =>
      client.models.ServicePlan.create({
        id: servicePlanId,
        customerId,
        planName: input.planName,
        priceCents: input.priceCents,
        serviceFrequency: input.serviceFrequency,
        status: "ACTIVE",
        startDate: input.startDate,
        // No stripeSubscriptionId yet — billing is a later, opt-in stage. The
        // plan reads ACTIVE-not-billing until a card is on file.
        ...(input.seasonal
          ? { seasonal: true, serviceMonths: input.serviceMonths }
          : {}),
        notes: `Imported from FieldRoutes (agreement ${input.externalSubscriptionId}). Price locked at migration (pre-tax).${
          input.salesTaxPercent
            ? ` Sales tax ${input.salesTaxPercent}% billed separately.`
            : ""
        }`,
        accessGroups,
      }),
    () => client.models.ServicePlan.get({ id: servicePlanId })
  );

  // 4. Seed exactly ONE next visit so the recurring engine continues the chain
  //    (it queues the next visit off each completion). Skip if no next date is
  //    known — the office schedules the first one and the chain takes over.
  let seedJobId: string | null = null;
  if (input.nextVisitDate) {
    seedJobId = `job-fr-${input.externalSubscriptionId}`;
    await createOrGet(
      "seed visit",
      () =>
        client.models.Job.create({
          id: seedJobId!,
          customerId,
          servicePlanId,
          type: "RECURRING",
          serviceType: input.serviceType,
          scheduledDate: input.nextVisitDate,
          propertyClass: input.propertyClass ?? "RESIDENTIAL",
          // NOT paid — migration creates no charge. Just the next visit.
          status: "SCHEDULED",
          notes: `First visit after FieldRoutes migration (agreement ${input.externalSubscriptionId}).`,
          accessGroups,
        }),
      () => client.models.Job.get({ id: seedJobId! })
    );
  }

  return { groupId, customerId, servicePlanId, seedJobId };
}
