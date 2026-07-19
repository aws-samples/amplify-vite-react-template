import { useCallback, useEffect, useState } from "react";
import {
  api,
  listAll,
  unwrap,
  updateMarketRate,
  type MarketRate,
  type PricingControl,
  type RateCoverage,
} from "../lib/api";
import {
  CADENCE_LABEL,
  HOA_BANDS,
  HOA_BAND_LABEL,
  PLAN_CADENCES,
  SERVICE_LABEL,
  bandOfKey,
  mergeSheetEdits,
  rateStatus,
  sheetOf,
  type HoaBand,
  type HoaPerUnitRates,
  type PlanCadence,
  type PlanRate,
  type RateStatus,
} from "../lib/marketRates";
import { fmtDate, money } from "../lib/format";
import { useRoles } from "../lib/auth";
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
  Sheet,
  Spinner,
  type BadgeTone,
} from "../ui/kit";

/**
 * The pricing console. Every base price in the system is an AI-researched
 * market-rate sheet cached on one of these rows — this screen is the ONLY
 * human pricing control: the office edits any component of a sheet (one-time,
 * extra nest, each cadence's monthly + initial fee), and saving pins the row
 * so it never expires or re-researches until the office un-pins it.
 */

const STATUS_TONE: Record<RateStatus, BadgeTone> = {
  active: "ok",
  pinned: "info",
  stale: "warn",
  retired: "muted",
};

const STATUS_LABEL: Record<RateStatus, string> = {
  active: "active",
  pinned: "pinned — never re-researches",
  // Serve-last-known-good: a row past its refresh date keeps quoting until
  // the pricing cron replaces the sheet — amber, not an outage.
  stale: "stale — serving last known, refresh due",
  retired: "retired",
};

function bandLabel(rate: MarketRate): string | null {
  const band = bandOfKey(rate.rateKey);
  // Only sqft services carry a key band; HOA keeps all unit bands inside
  // the one sheet.
  return band == null ? null : `up to ${band.toLocaleString()} sqft`;
}

function scopeOf(rate: MarketRate): string {
  const band = bandLabel(rate);
  return `${SERVICE_LABEL[rate.service] ?? rate.service} · ${rate.areaKey}${band ? ` · ${band}` : ""}`;
}

/** Mirrors the engine's per-research cost estimate (pricing-refresh's
 *  COST_PER_RESEARCH_USD) — an estimate for leadership, not billing truth. */
const COST_PER_RESEARCH_USD = 0.35;
/** Mirrors the engine's daily cap (pricing-refresh's RESEARCH_PER_DAY). */
const RESEARCH_PER_DAY = 150;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function covScope(c: RateCoverage): string {
  return `${SERVICE_LABEL[c.service] ?? c.service} · ${c.areaKey}${c.band ? ` · up to ${c.band.toLocaleString()} sqft` : ""}`;
}

/**
 * GL-16 — the engine panel: what the AI pricer is doing with the budget,
 * what is queued, and every parked (exhausted) combo with its one safe
 * next action. Data: the RateCoverage work-list plus today's atomic
 * PricingControl day counters (written by the refresh worker itself, so
 * this screen never needs an engineering query).
 */
function EnginePanel({
  coverage,
  rates,
  control,
  onChanged,
}: {
  coverage: RateCoverage[];
  rates: MarketRate[];
  control: PricingControl | null;
  onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const liveKeys = new Set(
    rates.filter((r) => r.active).map((r) => r.rateKey)
  );
  const active = coverage.filter((c) => c.active);
  const exhausted = active.filter((c) => c.exhaustedAt);
  const backingOff = active
    .filter(
      (c) =>
        !c.exhaustedAt &&
        c.nextEligibleAt &&
        Date.parse(c.nextEligibleAt) > now
    )
    .sort((a, b) => (a.nextEligibleAt ?? "").localeCompare(b.nextEligibleAt ?? ""));
  const waiting = active.filter(
    (c) =>
      !c.exhaustedAt &&
      !liveKeys.has(c.id) &&
      !(c.nextEligibleAt && Date.parse(c.nextEligibleAt) > now)
  );
  const dueRefresh = rates.filter(
    (r) =>
      r.active &&
      !r.pinned &&
      r.researchedAt &&
      now - Date.parse(r.researchedAt) > WEEK_MS
  );

  const attempts = control?.attempts ?? 0;
  const succeeded = control?.succeeded ?? 0;
  const failed = control?.failed ?? 0;
  const demand = control?.demandAttempts ?? 0;
  const spend = (attempts * COST_PER_RESEARCH_USD).toFixed(2);

  const retry = async (c: RateCoverage) => {
    setBusyId(c.id);
    setError(null);
    try {
      // Re-arm the combo: the next refresh run researches it again with a
      // clean attempt count. The parked state (and its owned work item) is
      // the office's to clear — this is that one safe action.
      unwrap(
        await api().models.RateCoverage.update({
          id: c.id,
          exhaustedAt: null,
          nextEligibleAt: null,
          failCount: 0,
        })
      );
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not retry research");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <div className="row-split">
        <strong>AI research engine — today</strong>
        <Badge tone={exhausted.length ? "warn" : "ok"}>
          {exhausted.length ? `${exhausted.length} parked` : "healthy"}
        </Badge>
      </div>
      <p className="small" style={{ margin: "6px 0 0" }}>
        {attempts} research attempts ({succeeded} succeeded, {failed} failed,{" "}
        {demand} for waiting leads) · estimated spend ~${spend} · daily cap{" "}
        {RESEARCH_PER_DAY}
      </p>
      <p className="muted small" style={{ margin: "4px 0 0" }}>
        Queue: {waiting.length} waiting for research · {dueRefresh.length} due
        a weekly refresh · {backingOff.length} backing off after a failure ·{" "}
        {active.length} combos covered
      </p>
      <ErrorNote error={error} />
      {exhausted.map((c) => (
        <ListRow
          key={c.id}
          title={covScope(c)}
          subtitle={`Gave up after ${c.failCount ?? 0} straight failures — quotes fall back to a callback until this is retried, priced by hand, or retired`}
          meta={
            <Button
              small
              loading={busyId === c.id}
              onClick={() => void retry(c)}
            >
              Retry research
            </Button>
          }
        />
      ))}
      {backingOff.slice(0, 5).map((c) => (
        <ListRow
          key={c.id}
          title={covScope(c)}
          subtitle={`${c.failCount ?? 0} failure${(c.failCount ?? 0) === 1 ? "" : "s"} — next automatic retry ${fmtDate(c.nextEligibleAt!, true)}`}
          meta={<Badge tone="muted">backing off</Badge>}
        />
      ))}
    </Card>
  );
}

export default function MarketRates() {
  const [rates, setRates] = useState<MarketRate[] | null>(null);
  const [coverage, setCoverage] = useState<RateCoverage[]>([]);
  const [control, setControl] = useState<PricingControl | null>(null);
  const [rollback, setRollback] = useState<PricingControl | null>(null);
  const [editing, setEditing] = useState<MarketRate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await listAll<MarketRate>((t) =>
        api().models.MarketRate.list({ limit: 500, nextToken: t })
      );
      setRates(
        rows.sort((a, b) =>
          (b.researchedAt ?? "").localeCompare(a.researchedAt ?? "")
        )
      );
      // The engine panel's inputs: the work-list plus today's day counters.
      // Their absence must not blank the pricing console itself.
      try {
        setCoverage(
          await listAll<RateCoverage>((t) =>
            api().models.RateCoverage.list({ limit: 500, nextToken: t })
          )
        );
        const dayId = `day#${new Date().toISOString().slice(0, 10)}`;
        const { data } = await api().models.PricingControl.get({ id: dayId });
        setControl(data ?? null);
        const { data: rb } = await api().models.PricingControl.get({
          id: "catalog-rollback",
        });
        setRollback(rb ?? null);
      } catch {
        /* engine stats unavailable — rates remain editable */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load market rates");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page title="Market rates" back="/more">
      <ErrorNote error={error} />
      <RollbackPanel rollback={rollback} onChanged={load} />
      {rates !== null ? (
        <EnginePanel
          coverage={coverage}
          rates={rates}
          control={control}
          onChanged={load}
        />
      ) : null}
      {rates === null ? (
        <Spinner />
      ) : rates.length === 0 ? (
        <EmptyState
          title="No market rates yet"
          body="Every base price is AI-researched: the hourly pricing refresh researches each service + area (+ size band) and caches the full rate sheet here, re-checking it weekly. Review, edit (which pins the rate), or retire any row."
        />
      ) : (
        <Card>
          {rates.map((r) => {
            const status = rateStatus(r);
            const sheet = sheetOf(r);
            const planMin = Math.min(
              ...PLAN_CADENCES.map(
                (c) => sheet.plans?.[c]?.monthlyCents ?? Infinity
              )
            );
            const plans = Number.isFinite(planMin)
              ? ` · plans from ${money(planMin)}/mo`
              : "";
            const headline = sheet.hoaPerUnitMonthly
              ? `from ${money(r.priceCents)}/unit/mo`
              : `${money(r.priceCents)} one-time${plans}`;
            return (
              <ListRow
                key={r.id}
                title={scopeOf(r)}
                subtitle={`${headline}${r.researchedAt ? ` · researched ${fmtDate(r.researchedAt, true)}` : ""}`}
                meta={<Badge tone={STATUS_TONE[status]}>{status}</Badge>}
                onClick={() => setEditing(r)}
              />
            );
          })}
        </Card>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Market rate"
      >
        {editing ? (
          <RateForm
            rate={editing}
            onDone={async () => {
              setEditing(null);
              await load();
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

/** Dollar-string state for one plan cadence. */
type PlanDraft = { monthly: string; initialFee: string };

const toDollars = (cents: number | null | undefined) =>
  cents != null ? (cents / 100).toString() : "";

const toCents = (dollars: string): number | null => {
  if (!dollars.trim()) return null;
  const cents = Math.round(parseFloat(dollars) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : NaN;
};

/** GL-16 — the controlled reason an office edit records. No free-text-only
 *  escape hatch: the note elaborates, the code classifies. */
const EDIT_REASONS = [
  { code: "TOO_HIGH", label: "Researched price too high for us" },
  { code: "TOO_LOW", label: "Researched price too low (margin)" },
  { code: "MATCH_COMPETITOR", label: "Match a specific competitor" },
  { code: "PROMOTION", label: "Promotion / negotiated rate" },
  { code: "CORRECTION", label: "Correcting a bad research result" },
  { code: "OTHER", label: "Other (explain in the note)" },
] as const;

function RateForm({
  rate,
  onDone,
}: {
  rate: MarketRate;
  onDone: () => Promise<void>;
}) {
  const roles = useRoles();
  const sheet = sheetOf(rate);
  const status = rateStatus(rate);

  const [oneTime, setOneTime] = useState(toDollars(sheet.oneTimeCents));
  const [extraNest, setExtraNest] = useState(toDollars(sheet.extraNestCents));
  const [plans, setPlans] = useState<Record<PlanCadence, PlanDraft>>(() => {
    const out = {} as Record<PlanCadence, PlanDraft>;
    for (const cadence of PLAN_CADENCES) {
      out[cadence] = {
        monthly: toDollars(sheet.plans?.[cadence]?.monthlyCents),
        initialFee: toDollars(sheet.plans?.[cadence]?.initialFeeCents),
      };
    }
    return out;
  });
  const [hoa, setHoa] = useState<Record<HoaBand, Record<PlanCadence, string>>>(
    () => {
      const out = {} as Record<HoaBand, Record<PlanCadence, string>>;
      for (const band of HOA_BANDS) {
        out[band] = {} as Record<PlanCadence, string>;
        for (const cadence of PLAN_CADENCES) {
          out[band][cadence] = toDollars(
            sheet.hoaPerUnitMonthly?.[band]?.[cadence]
          );
        }
      }
      return out;
    }
  );
  const [active, setActive] = useState(rate.active);
  const [editReason, setEditReason] = useState("");
  const [editNote, setEditNote] = useState("");
  const [busy, setBusy] = useState<null | "save" | "unpin">(null);
  const [error, setError] = useState<string | null>(null);

  // HOA sheets have no one-time card; everything else always has one.
  const isHoa = sheet.hoaPerUnitMonthly != null || rate.service === "HOA";
  const hasExtraNest = sheet.extraNestCents != null || rate.service === "WASP_NEST";
  const hasPlans = sheet.plans != null;

  const save = async () => {
    let oneTimeCents: number | null = null;
    if (!isHoa) {
      oneTimeCents = toCents(oneTime);
      if (oneTimeCents == null || Number.isNaN(oneTimeCents) || oneTimeCents <= 0) {
        setError("Enter a valid one-time price");
        return;
      }
    }
    const extraNestCents = toCents(extraNest);
    if (extraNestCents != null && Number.isNaN(extraNestCents)) {
      setError("The extra-nest price doesn't look valid");
      return;
    }
    const planEdits: Partial<Record<PlanCadence, PlanRate>> = {};
    if (hasPlans) {
      for (const cadence of PLAN_CADENCES) {
        const monthly = toCents(plans[cadence].monthly);
        const initialFee = toCents(plans[cadence].initialFee);
        if (
          monthly == null ||
          Number.isNaN(monthly) ||
          monthly <= 0 ||
          (initialFee != null && Number.isNaN(initialFee))
        ) {
          setError(`The ${CADENCE_LABEL[cadence]} plan prices don't look valid`);
          return;
        }
        planEdits[cadence] = {
          monthlyCents: monthly,
          initialFeeCents: initialFee ?? 0,
        };
      }
    }
    let hoaEdits: HoaPerUnitRates | undefined;
    if (isHoa) {
      const out = {} as HoaPerUnitRates;
      for (const band of HOA_BANDS) {
        out[band] = {} as HoaPerUnitRates[HoaBand];
        for (const cadence of PLAN_CADENCES) {
          const cents = toCents(hoa[band][cadence]);
          if (cents == null || Number.isNaN(cents) || cents <= 0) {
            setError(
              `The ${HOA_BAND_LABEL[band]} ${CADENCE_LABEL[cadence]} per-unit rate doesn't look valid`
            );
            return;
          }
          out[band][cadence] = cents;
        }
      }
      hoaEdits = out;
    }
    if (active && !editReason) {
      setError("Pick the reason for this price change");
      return;
    }
    if (active && editReason === "OTHER" && !editNote.trim()) {
      setError("Explain the change in the note");
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const merged = mergeSheetEdits(rate, {
        oneTimeCents: oneTimeCents ?? undefined,
        extraNestCents: hasExtraNest ? extraNestCents : undefined,
        plans: hasPlans ? planEdits : undefined,
        hoaPerUnitMonthly: hoaEdits,
      });
      if (active) {
        // GL-16: an office edit is a NEW pinned VERSION with a controlled
        // reason — it retires (never edits) the AI row, so the exact history
        // behind every price stays intact and the change shares the same
        // durable current-versus-prior record as AI research.
        const reasonLabel =
          EDIT_REASONS.find((r) => r.code === editReason)?.label ?? editReason;
        unwrap(
          await api().models.MarketRate.create({
            rateKey: rate.rateKey,
            service: rate.service,
            areaKey: rate.areaKey,
            priceCents: merged.priceCents,
            ratesJson: merged.ratesJson,
            basis: `Office edit — ${reasonLabel}${editNote.trim() ? `: ${editNote.trim()}` : ""}`,
            active: true,
            pinned: true,
            prevPriceCents: rate.priceCents,
            prevResearchedAt: rate.researchedAt ?? undefined,
            editedBy: roles.email ?? undefined,
            editReason,
          } as Parameters<ReturnType<typeof api>["models"]["MarketRate"]["create"]>[0])
        );
        unwrap(
          await updateMarketRate({ id: rate.id, active: false, pinned: false })
        );
      } else {
        // Retiring ends this row's service — a state change, not a version.
        unwrap(
          await updateMarketRate({ id: rate.id, active: false, pinned: false })
        );
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(null);
    }
  };

  const unpin = async () => {
    setBusy("unpin");
    setError(null);
    try {
      unwrap(await updateMarketRate({ id: rate.id, pinned: false }));
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not un-pin");
      setBusy(null);
    }
  };

  return (
    <div className="form-grid">
      <div className="row-split">
        <strong>{scopeOf(rate)}</strong>
        <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
      </div>
      <dl className="kv">
        {rate.researchedAt ? (
          <>
            <dt>Researched</dt>
            <dd>{fmtDate(rate.researchedAt, true)}</dd>
          </>
        ) : null}
        <dt>Refresh due</dt>
        <dd>
          {rate.pinned
            ? "never — pinned until you un-pin it"
            : rate.expiresAt
              ? // Past-due rows keep serving the last known sheet until the
                // pricing cron refreshes them — due, never dark.
                fmtDate(rate.expiresAt, true)
              : "—"}
        </dd>
      </dl>
      {rate.basis ? (
        <p
          className="small"
          style={{ background: "var(--surface-2)", borderRadius: 10, padding: 10 }}
        >
          {rate.basis}
        </p>
      ) : null}

      {!isHoa ? (
        <Field
          label="One-time price ($)"
          hint="What one visit costs; quoted to the website funnel and the CRM alike"
        >
          <input
            inputMode="decimal"
            value={oneTime}
            onChange={(e) => setOneTime(e.target.value)}
          />
        </Field>
      ) : null}
      {hasExtraNest ? (
        <Field label="Each extra nest ($)" hint="Per additional nest on the same visit">
          <input
            inputMode="decimal"
            value={extraNest}
            onChange={(e) => setExtraNest(e.target.value)}
          />
        </Field>
      ) : null}
      {hasPlans
        ? PLAN_CADENCES.map((cadence) => (
            <div className="form-row-2" key={cadence}>
              <Field
                label={`${CADENCE_LABEL[cadence].replace(/^./, (c) => c.toUpperCase())} plan ($/mo)`}
              >
                <input
                  inputMode="decimal"
                  value={plans[cadence].monthly}
                  onChange={(e) =>
                    setPlans((p) => ({
                      ...p,
                      [cadence]: { ...p[cadence], monthly: e.target.value },
                    }))
                  }
                />
              </Field>
              <Field label="Initial fee ($)">
                <input
                  inputMode="decimal"
                  value={plans[cadence].initialFee}
                  onChange={(e) =>
                    setPlans((p) => ({
                      ...p,
                      [cadence]: { ...p[cadence], initialFee: e.target.value },
                    }))
                  }
                />
              </Field>
            </div>
          ))
        : null}
      {isHoa ? (
        <>
          <p className="group-label">Per-unit monthly rate ($/unit/mo)</p>
          {HOA_BANDS.map((band) => (
            <div key={band}>
              <p className="muted small" style={{ margin: "0 0 4px" }}>
                {HOA_BAND_LABEL[band]}
              </p>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: 8,
                }}
              >
                {PLAN_CADENCES.map((cadence) => (
                  <Field key={cadence} label={CADENCE_LABEL[cadence]}>
                    <input
                      inputMode="decimal"
                      value={hoa[band][cadence]}
                      onChange={(e) =>
                        setHoa((h) => ({
                          ...h,
                          [band]: { ...h[band], [cadence]: e.target.value },
                        }))
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>
          ))}
        </>
      ) : null}

      {active ? (
        <Field
          label="Why is this price changing?"
          hint="Recorded on the new pinned version — the AI row and its history stay intact"
        >
          <select
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
          >
            <option value="">Pick a reason…</option>
            {EDIT_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {active ? (
        <Field label="Note (optional unless Other)">
          <input
            value={editNote}
            onChange={(e) => setEditNote(e.target.value)}
            placeholder="e.g. GreenHow quotes $249 for this"
          />
        </Field>
      ) : null}
      {rate.pinned && (rate.editedBy || rate.editReason) ? (
        <p className="muted small">
          Pinned{rate.editedBy ? ` by ${rate.editedBy}` : ""}
          {rate.editReason
            ? ` — ${EDIT_REASONS.find((r) => r.code === rate.editReason)?.label ?? rate.editReason}`
            : ""}
        </p>
      ) : null}
      <Field label="Active" hint="Retire to stop serving this rate — the refresh cron researches a replacement">
        <SegControl
          options={[
            { value: "yes" as const, label: "Active" },
            { value: "no" as const, label: "Retired" },
          ]}
          value={active ? "yes" : "no"}
          onChange={(v) => setActive(v === "yes")}
        />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy === "save"} onClick={() => void save()}>
        {active ? "Save & pin this rate" : "Save & retire this rate"}
      </Button>
      <p className="muted small">
        {active
          ? "Saving pins the sheet: it becomes the quoted price for this service + area and never expires or re-researches until you un-pin it."
          : "A retired rate is never served — the next quote for this service + area researches the market fresh."}
      </p>
      {rate.pinned ? (
        <Button
          block
          variant="ghost"
          loading={busy === "unpin"}
          onClick={() => void unpin()}
        >
          Resume AI research for this rate
        </Button>
      ) : null}
    </div>
  );
}

/** GL-16 — the controlled rollback reasons (no free-text-only escape hatch). */
const ROLLBACK_REASONS = [
  { code: "BAD_PROMPT_RESULT", label: "A prompt/model run produced bad prices" },
  { code: "MODEL_ERROR", label: "Model or provider malfunction" },
  { code: "BULK_MISTAKE", label: "A bulk change was a mistake" },
  { code: "OTHER", label: "Other (explain in the note)" },
] as const;

/**
 * GL-16 — the one reasoned, authorized recovery from a bad model/prompt
 * result: an OWNER rolls the WHOLE catalog back to how it stood at a chosen
 * moment in one atomic action. Quotes immediately serve that prior coherent
 * sheet (office-pinned rows still win), research pauses, history is
 * untouched, and clearing the rollback resumes everything.
 */
function RollbackPanel({
  rollback,
  onChanged,
}: {
  rollback: PricingControl | null;
  onChanged: () => Promise<void>;
}) {
  const roles = useRoles();
  const [open, setOpen] = useState(false);
  const [cutoffLocal, setCutoffLocal] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "apply" | "clear">(null);
  const [error, setError] = useState<string | null>(null);

  const active = Boolean(rollback?.rollbackCutoff);
  if (!active && !roles.owner) return null;

  const apply = async () => {
    if (!cutoffLocal) {
      setError("Pick the moment to roll back to");
      return;
    }
    if (!reason) {
      setError("Pick a rollback reason");
      return;
    }
    if (reason === "OTHER" && !note.trim()) {
      setError("Explain the rollback in the note");
      return;
    }
    setBusy("apply");
    setError(null);
    try {
      unwrap(
        await api().mutations.rollbackPricing({
          cutoffIso: new Date(cutoffLocal).toISOString(),
          reasonCode: reason,
          note: note.trim() || undefined,
        })
      );
      setOpen(false);
      setCutoffLocal("");
      setReason("");
      setNote("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rollback failed — nothing changed");
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (
      !window.confirm(
        "Clear the rollback? The newest rate rows serve again immediately and AI research resumes."
      )
    ) {
      return;
    }
    setBusy("clear");
    setError(null);
    try {
      unwrap(await api().mutations.clearPricingRollback({}));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not clear the rollback");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="row-split">
        <strong>Catalog rollback</strong>
        <Badge tone={active ? "warn" : "muted"}>
          {active ? "ROLLED BACK" : "not active"}
        </Badge>
      </div>
      {active ? (
        <>
          <p className="small" style={{ margin: "6px 0 0" }}>
            Quoting the catalog as it stood at{" "}
            <strong>{fmtDate(rollback!.rollbackCutoff!, true)}</strong>
            {rollback?.rollbackActor ? ` — by ${rollback.rollbackActor}` : ""}
            {rollback?.rollbackReason ? ` (${rollback.rollbackReason})` : ""}.
            Office-pinned rows still serve; AI research is paused until this is
            cleared.
          </p>
          {roles.owner ? (
            <Button
              small
              loading={busy === "clear"}
              onClick={() => void clear()}
            >
              Clear rollback — serve newest rates again
            </Button>
          ) : (
            <p className="muted small">Only an owner can clear the rollback.</p>
          )}
        </>
      ) : open ? (
        <>
          <Field
            label="Serve the catalog as it stood at"
            hint="Every AI rate researched after this moment stops serving; pinned office rates still win"
          >
            <input
              type="datetime-local"
              value={cutoffLocal}
              onChange={(e) => setCutoffLocal(e.target.value)}
            />
          </Field>
          <Field label="Why?">
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Pick a reason…</option>
              {ROLLBACK_REASONS.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note (optional unless Other)">
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="row-split">
            <Button small variant="ghost" onClick={() => setOpen(false)}>
              Never mind
            </Button>
            <Button small loading={busy === "apply"} onClick={() => void apply()}>
              Roll the catalog back
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted small" style={{ margin: "6px 0 0" }}>
            If a research run published bad prices, roll the whole catalog back
            to a moment before it — one action, immediately live, fully
            reversible.
          </p>
          <Button small variant="ghost" onClick={() => setOpen(true)}>
            Roll back the catalog…
          </Button>
        </>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}
