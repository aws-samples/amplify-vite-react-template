import { useState } from "react";
import { api, listAll, unwrap, type PromoCode } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { useRoles } from "../lib/auth";
import { fmtDate } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  ListRow,
  Page,
  Sheet,
  Spinner,
} from "../ui/kit";
import { formatMoney } from "../../../web/amplify/functions/shared/money";

/**
 * Owner-only discount codes for the public booking funnel. Staff create a code
 * (a percent or a flat dollar amount off), optionally with a validity window
 * and a redemption cap, and hand it to a customer — who types it at checkout.
 * The public booking Lambda validates and applies it; the applied discount is
 * snapshotted onto the booking, so editing or retiring a code here never
 * re-prices a booking that already used it.
 *
 * Codes are RETIRED by unchecking "Active" (they keep their redemption
 * history); a code that has never been redeemed can be deleted outright.
 */

/** "20% off" / "$25.00 off" — the value line shown in the list and summaries. */
function valueLabel(p: PromoCode): string {
  if (p.kind === "PERCENT") return `${p.percentOff ?? 0}% off`;
  if (p.kind === "FIXED") return `${formatMoney(p.amountOffCents ?? 0)} off`;
  return "—";
}

export default function PromoCodes() {
  const roles = useRoles();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PromoCode | null>(null);

  const { data, error, reload } = useAsync<PromoCode[]>(
    async () => {
      const all = await listAll((t) =>
        api().models.PromoCode.list({ limit: 200, nextToken: t })
      );
      // Active first, then alphabetical — the codes staff hand out today sit at
      // the top, retired ones settle below.
      return [...all].sort(
        (a, b) =>
          Number(!!b.active) - Number(!!a.active) ||
          (a.code ?? "").localeCompare(b.code ?? "")
      );
    },
    [],
    "Could not load discount codes"
  );
  // A failed load used to fall through to the empty state beside its error,
  // rather than spinning forever — keep that.
  const codes = data ?? (error ? [] : null);

  if (!roles.owner) {
    return (
      <Page title="Discount codes" back="/more">
        <EmptyState
          title="Owners only"
          body="Discount codes are managed by the owner."
        />
      </Page>
    );
  }

  return (
    <Page
      title="Discount codes"
      back="/more"
      actions={
        <Button small variant="ghost" onClick={() => setAdding(true)}>
          + Code
        </Button>
      }
    >
      <Card title="Codes">
        <p className="muted small" style={{ marginBottom: 6 }}>
          Codes your customers type on the online booking checkout. A code can be
          a percentage or a flat dollar amount off, with an optional date window
          and redemption limit. Retire a code by turning off "Active".
        </p>
        <ErrorNote error={error} />
        {codes === null ? (
          <Spinner label="Loading discount codes…" />
        ) : codes.length === 0 ? (
          <EmptyState
            title="No discount codes yet"
            body="Create a code to hand out — customers enter it at online checkout."
            action={<Button onClick={() => setAdding(true)}>Add code</Button>}
          />
        ) : (
          codes.map((p) => {
            const cap =
              typeof p.maxRedemptions === "number"
                ? `${p.timesRedeemed ?? 0} / ${p.maxRedemptions} used`
                : `${p.timesRedeemed ?? 0} used`;
            const window = [
              p.startsAt ? `from ${fmtDate(p.startsAt, true)}` : null,
              p.endsAt ? `until ${fmtDate(p.endsAt, true)}` : null,
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <ListRow
                key={p.id}
                title={
                  <span>
                    {p.code}{" "}
                    {!p.active ? <Badge tone="danger">inactive</Badge> : null}
                  </span>
                }
                subtitle={
                  [valueLabel(p), p.description, window]
                    .filter(Boolean)
                    .join(" · ") || undefined
                }
                meta={
                  <>
                    <Badge tone="muted">{cap}</Badge>
                    <Button small variant="ghost" onClick={() => setEditing(p)}>
                      Edit
                    </Button>
                  </>
                }
                onClick={() => setEditing(p)}
              />
            );
          })
        )}
      </Card>

      <Sheet open={adding} onClose={() => setAdding(false)} title="New discount code">
        {adding ? (
          <PromoForm
            onDone={async () => {
              setAdding(false);
              reload();
            }}
          />
        ) : null}
      </Sheet>

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit discount code"
      >
        {editing ? (
          <PromoForm
            existing={editing}
            onDone={async () => {
              setEditing(null);
              reload();
            }}
          />
        ) : null}
      </Sheet>
    </Page>
  );
}

/** A YYYY-MM-DD calendar date, stored as a UTC instant. Start dates open at
 *  the top of the day, end dates run through its final millisecond, so a
 *  window is inclusive of both days the way staff read it. */
function dateToStartIso(date: string): string {
  return `${date}T00:00:00.000Z`;
}
function dateToEndIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}
/** The reverse: pull the calendar date back out of a stored instant. */
function isoToDate(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}

function PromoForm({
  existing,
  onDone,
}: {
  existing?: PromoCode | null;
  onDone: () => Promise<void>;
}) {
  const [code, setCode] = useState(existing?.code ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [kind, setKind] = useState<"PERCENT" | "FIXED">(
    existing?.kind === "FIXED" ? "FIXED" : "PERCENT"
  );
  const [percentOff, setPercentOff] = useState(
    existing?.percentOff != null ? String(existing.percentOff) : ""
  );
  const [amountOff, setAmountOff] = useState(
    existing?.amountOffCents != null
      ? (existing.amountOffCents / 100).toFixed(2)
      : ""
  );
  const [active, setActive] = useState(existing?.active ?? true);
  const [startsOn, setStartsOn] = useState(isoToDate(existing?.startsAt));
  const [endsOn, setEndsOn] = useState(isoToDate(existing?.endsAt));
  const [maxRedemptions, setMaxRedemptions] = useState(
    existing?.maxRedemptions != null ? String(existing.maxRedemptions) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalizedCode = code.trim().toUpperCase();
  const timesRedeemed = existing?.timesRedeemed ?? 0;
  const canDelete = Boolean(existing) && timesRedeemed === 0;

  async function save() {
    setError(null);
    if (!normalizedCode) {
      setError("Enter a code.");
      return;
    }
    let percentValue: number | null = null;
    let amountValue: number | null = null;
    if (kind === "PERCENT") {
      percentValue = Math.round(Number(percentOff));
      if (!Number.isFinite(percentValue) || percentValue < 1 || percentValue > 100) {
        setError("A percentage code needs a value between 1 and 100.");
        return;
      }
    } else {
      const dollars = Number(amountOff);
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setError("A dollar code needs an amount greater than $0.");
        return;
      }
      amountValue = Math.round(dollars * 100);
    }
    let maxValue: number | null = null;
    if (maxRedemptions.trim()) {
      maxValue = Math.round(Number(maxRedemptions));
      if (!Number.isFinite(maxValue) || maxValue < 1) {
        setError("A redemption limit must be a whole number of at least 1.");
        return;
      }
    }
    if (startsOn && endsOn && endsOn < startsOn) {
      setError("The end date can't be before the start date.");
      return;
    }

    setBusy(true);
    try {
      // A new code must be unique — reuse would make the funnel's lookup
      // ambiguous. Editing keeps its own code (skip the check when unchanged).
      if (!existing || existing.code !== normalizedCode) {
        const { data: clashes } =
          await api().models.PromoCode.listPromoCodeByCode({
            code: normalizedCode,
          });
        if (clashes && clashes.some((c) => c.id !== existing?.id)) {
          setError("That code already exists — pick a different one.");
          setBusy(false);
          return;
        }
      }
      const fields = {
        code: normalizedCode,
        description: description.trim() || null,
        kind,
        percentOff: kind === "PERCENT" ? percentValue : null,
        amountOffCents: kind === "FIXED" ? amountValue : null,
        active,
        startsAt: startsOn ? dateToStartIso(startsOn) : null,
        endsAt: endsOn ? dateToEndIso(endsOn) : null,
        maxRedemptions: maxValue,
      };
      if (existing) {
        unwrap(await api().models.PromoCode.update({ id: existing.id, ...fields }));
      } else {
        unwrap(
          await api().models.PromoCode.create({ ...fields, timesRedeemed: 0 })
        );
      }
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the code");
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    if (
      !window.confirm(
        `Delete ${existing.code}? It has never been used, so this can't affect any booking.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      unwrap(await api().models.PromoCode.delete({ id: existing.id }));
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the code");
      setBusy(false);
    }
  }

  return (
    <div className="form-grid">
      <Field label="Code" hint="What the customer types at checkout (UPPERCASE)">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="SAVE20"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </Field>
      <Field label="Description" hint="Optional — only staff see this">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Spring neighbor referral"
        />
      </Field>
      <Field label="Discount type" group>
        <div className="form-row-2">
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="radio"
              name="promo-kind"
              style={{ width: "auto" }}
              checked={kind === "PERCENT"}
              onChange={() => setKind("PERCENT")}
            />
            Percentage off
          </label>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="radio"
              name="promo-kind"
              style={{ width: "auto" }}
              checked={kind === "FIXED"}
              onChange={() => setKind("FIXED")}
            />
            Dollar amount off
          </label>
        </div>
      </Field>
      {kind === "PERCENT" ? (
        <Field label="Percent off" hint="1–100">
          <input
            type="text"
            inputMode="numeric"
            value={percentOff}
            onChange={(e) =>
              setPercentOff(e.target.value.replace(/[^\d]/g, "").slice(0, 3))
            }
            placeholder="20"
          />
        </Field>
      ) : (
        <Field label="Amount off (USD)">
          <input
            type="text"
            inputMode="decimal"
            value={amountOff}
            onChange={(e) =>
              setAmountOff(e.target.value.replace(/[^\d.]/g, "").slice(0, 8))
            }
            placeholder="25.00"
          />
        </Field>
      )}
      <div className="form-row-2">
        <Field label="Starts (optional)">
          <input
            type="date"
            value={startsOn}
            onChange={(e) => setStartsOn(e.target.value)}
          />
        </Field>
        <Field label="Ends (optional)">
          <input
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
        </Field>
      </div>
      <Field
        label="Redemption limit (optional)"
        hint={
          existing
            ? `Leave blank for unlimited · ${timesRedeemed} used so far`
            : "Leave blank for unlimited"
        }
      >
        <input
          type="text"
          inputMode="numeric"
          value={maxRedemptions}
          onChange={(e) =>
            setMaxRedemptions(e.target.value.replace(/[^\d]/g, "").slice(0, 6))
          }
          placeholder="Unlimited"
        />
      </Field>
      <Field label="Active" group>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Customers can use this code
        </label>
      </Field>

      <ErrorNote error={error} />
      <div className="row-split">
        <Button onClick={() => void save()} loading={busy} disabled={busy}>
          {existing ? "Save changes" : "Create code"}
        </Button>
        {canDelete ? (
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
