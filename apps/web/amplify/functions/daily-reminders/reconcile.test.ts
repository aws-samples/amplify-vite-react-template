import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GL-05 scheduled reconciliation. The pure set logic lives in
 * shared/bookingReconcile (tested there); this exercises the daily-cron IO
 * around it — reading Stripe's succeeded booking payments and the real tables,
 * detecting dangling checkpoint IDs, and opening/resolving owned Finance cases.
 */

type Row = Record<string, unknown> & { id: string };

let bookings: Row[] = [];
let invoices: Row[] = [];
const customers = new Set<string>();
const jobs = new Set<string>();
const agreements = new Set<string>();
const plans = new Set<string>();
let stripePis: Record<string, unknown>[] = [];
let stripeThrows = false;

const has = (set: Set<string>, id: string) => (set.has(id) ? { id } : null);

const fakeDataClient = {
  models: {
    BookingRequest: { list: async () => ({ data: bookings, nextToken: null }) },
    Invoice: { list: async () => ({ data: invoices, nextToken: null }) },
    Customer: { get: async ({ id }: { id: string }) => ({ data: has(customers, id) }) },
    Job: { get: async ({ id }: { id: string }) => ({ data: has(jobs, id) }) },
    Agreement: { get: async ({ id }: { id: string }) => ({ data: has(agreements, id) }) },
    ServicePlan: { get: async ({ id }: { id: string }) => ({ data: has(plans, id) }) },
  },
};

vi.mock("../shared/dataClient", () => ({ dataClient: async () => fakeDataClient }));
vi.mock("../shared/stripeClient", () => ({
  stripeClient: () => ({
    paymentIntents: {
      list: async () => {
        if (stripeThrows) throw new Error("stripe down");
        return { data: stripePis, has_more: false };
      },
    },
  }),
}));
vi.mock("../shared/email", () => ({
  emailShell: (h: string, b: string) => `${h}${b}`,
  notifyOffice: async () => true,
  sendEmail: async () => true,
}));

const opened: { kind: string; dedupeKey: string; title: string; detail: string }[] = [];
const resolved: { kind: string; dedupeKey: string }[] = [];
vi.mock("../shared/ownedWork", () => ({
  openOwnedWork: async (o: { kind: string; dedupeKey: string; title: string; detail: string }) => {
    opened.push(o);
    return "work-1";
  },
  resolveOwnedWork: async (o: { kind: string; dedupeKey: string }) => {
    resolved.push(o);
    return true;
  },
  defaultWorkOwner: () => "office@pestbuzzkill.com",
  openMissingContactWork: async () => "work-1",
}));

const { reconcilePaidBookings } = await import("./handler");

const succeeded = (id: string, bookingRequestId: string, amount: number) => ({
  id,
  status: "succeeded",
  metadata: { bookingRequestId },
  amount_received: amount,
});

beforeEach(() => {
  bookings = [];
  invoices = [];
  customers.clear();
  jobs.clear();
  agreements.clear();
  plans.clear();
  stripePis = [];
  stripeThrows = false;
  opened.length = 0;
  resolved.length = 0;
});

describe("scheduled paid-booking reconciliation", () => {
  it("resolves the exception on a booking that proves whole", async () => {
    bookings = [
      {
        id: "bh",
        status: "BOOKED",
        stripePaymentIntentId: "pi_h",
        amountCents: 31300,
        customerId: "c1",
        jobId: "j1",
        agreementId: "a1",
      },
    ];
    invoices = [{ id: "booking-bh", status: "PAID", stripePaymentIntentId: "pi_h" }];
    customers.add("c1");
    jobs.add("j1");
    agreements.add("a1");
    stripePis = [succeeded("pi_h", "bh", 31300)];

    const res = await reconcilePaidBookings();

    expect(opened).toHaveLength(0);
    expect(resolved).toContainEqual(
      expect.objectContaining({ kind: "PAID_NOT_FINALIZED", dedupeKey: "bh" })
    );
    expect(res).toMatchObject({ reconciled: true, ok: true });
  });

  it("opens a Finance case for a succeeded payment with no booking at all", async () => {
    stripePis = [succeeded("pi_orphan", "gone", 19900)];

    await reconcilePaidBookings();

    const item = opened.find((o) => o.dedupeKey === "recon-missing-pi:pi_orphan");
    expect(item).toBeDefined();
    expect(item!.detail).toContain("$199.00");
  });

  it("flags a BOOKED booking whose checkpoint ID no longer resolves (dangling)", async () => {
    bookings = [
      {
        id: "bd",
        status: "BOOKED",
        stripePaymentIntentId: "pi_d",
        amountCents: 5000,
        customerId: "c1",
        jobId: "j-gone", // nonblank, but the Job no longer exists
        agreementId: "a1",
      },
    ];
    invoices = [{ id: "booking-bd", status: "PAID", stripePaymentIntentId: "pi_d" }];
    customers.add("c1");
    agreements.add("a1"); // note: jobs set does NOT contain j-gone
    stripePis = [succeeded("pi_d", "bd", 5000)];

    await reconcilePaidBookings();

    const item = opened.find(
      (o) => o.kind === "PAID_NOT_FINALIZED" && o.dedupeKey === "bd"
    );
    expect(item).toBeDefined();
    expect(item!.detail).toContain("job");
    expect(resolved.find((r) => r.dedupeKey === "bd")).toBeUndefined();
  });

  it("flags a BOOKED booking whose Stripe amount differs from the committed amount", async () => {
    bookings = [
      {
        id: "bm",
        status: "BOOKED",
        stripePaymentIntentId: "pi_m",
        amountCents: 31300,
        customerId: "c1",
        jobId: "j1",
        agreementId: "a1",
      },
    ];
    invoices = [{ id: "booking-bm", status: "PAID", stripePaymentIntentId: "pi_m" }];
    customers.add("c1");
    jobs.add("j1");
    agreements.add("a1");
    stripePis = [succeeded("pi_m", "bm", 9900)]; // took $99, committed $313

    await reconcilePaidBookings();

    const item = opened.find((o) => o.dedupeKey === "bm");
    expect(item).toBeDefined();
    expect(item!.detail).toContain("$99.00");
    expect(item!.detail).toContain("$313.00");
  });

  it("a stuck QUOTED booking's succeeded payment is keyed on the booking, not left orphan", async () => {
    bookings = [
      {
        id: "bs",
        status: "QUOTED",
        stripePaymentIntentId: "pi_s",
        amountCents: 31300,
      },
    ];
    stripePis = [succeeded("pi_s", "bs", 31300)];

    await reconcilePaidBookings();

    expect(opened.find((o) => o.dedupeKey === "bs")).toBeDefined();
    expect(opened.find((o) => o.dedupeKey.startsWith("recon-missing-pi"))).toBeUndefined();
  });

  it("a Stripe read failure is loud owned work, not a silent all-clear", async () => {
    stripeThrows = true;

    const res = await reconcilePaidBookings();

    expect(res).toMatchObject({ reconciled: false, reason: "stripe-unavailable" });
    expect(opened.find((o) => o.dedupeKey === "recon-stripe-unavailable")).toBeDefined();
  });
});
