import { useState } from "react";
import {
  client,
  LINES_OF_BUSINESS,
  type Carrier,
  type Policy,
  type Quote,
} from "../lib/client";

/**
 * Shared create/edit form for quotes and policies.
 *
 * A Policy is a Quote plus a policy number and a different status set, so
 * both use one form — otherwise the two field lists drift apart every time a
 * term is added. Quotes can be created here; policies only ever come into
 * existence by binding a quote, so policy mode is edit-only.
 */

export const QUOTE_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "QUOTED",
  "PRESENTED",
  "DECLINED",
  "LOST",
] as const;

export const POLICY_STATUSES = [
  "ACTIVE",
  "CANCELLED",
  "EXPIRED",
  "NON_RENEWED",
] as const;

// Alphabetical by label.
const RC_TYPES = [
  ["ERC", "ERC — Extended Replacement Cost"],
  ["GRC", "GRC — Guaranteed Replacement Cost"],
  ["RC", "RC — Replacement Cost"],
] as const;

const num = (v: string) => (v.trim() === "" ? null : Number(v));
const str = (v: number | null | undefined) => (v == null ? "" : String(v));

export default function CoverageForm({
  kind,
  accountId,
  carriers,
  existing,
  onSaved,
  onCancel,
}: {
  kind: "quote" | "policy";
  accountId: string;
  carriers: Carrier[];
  existing: Quote | Policy | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const isPolicy = kind === "policy";
  const editing = !!existing;
  const asPolicy = existing as Policy | null;

  const [carrierId, setCarrierId] = useState(existing?.carrierId ?? "");
  const [policyNumber, setPolicyNumber] = useState(asPolicy?.policyNumber ?? "");
  const [status, setStatus] = useState<string>(
    existing?.status ?? (isPolicy ? "ACTIVE" : "DRAFT")
  );
  const [lines, setLines] = useState<string[]>(
    (existing?.lines ?? []).filter((l): l is string => !!l)
  );
  const [premium, setPremium] = useState(str(existing?.premium));
  const [commissionPct, setCommissionPct] = useState(str(existing?.commissionPct));
  // Only autofill the carrier's standard rate on an untouched new quote —
  // never clobber a rate already negotiated on an existing record.
  const [commissionTouched, setCommissionTouched] = useState(editing);
  const [perOccDed, setPerOccDed] = useState(str(existing?.perOccurrenceDeductible));
  const [perUnitDed, setPerUnitDed] = useState(str(existing?.perUnitDeductible));
  const [blanketLimit, setBlanketLimit] = useState(str(existing?.blanketLimit));
  const [coinsurance, setCoinsurance] = useState(str(existing?.coinsurancePct));
  const [rcType, setRcType] = useState(existing?.replacementCostType ?? "");
  const [effectiveDate, setEffectiveDate] = useState(existing?.effectiveDate ?? "");
  const [expirationDate, setExpirationDate] = useState(existing?.expirationDate ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function toggleLine(line: string) {
    setLines((ls) =>
      ls.includes(line) ? ls.filter((l) => l !== line) : [...ls, line]
    );
  }

  function pickCarrier(id: string) {
    setCarrierId(id);
    if (!commissionTouched) {
      const std = carriers.find((c) => c.id === id)?.standardCommissionPct;
      setCommissionPct(std != null ? String(std) : "");
    }
  }

  async function save() {
    if (effectiveDate && expirationDate && effectiveDate > expirationDate) {
      setError("Effective date can't be after the expiration date.");
      return;
    }
    setSaving(true);
    setError("");

    const shared = {
      carrierId: carrierId || null,
      lines,
      premium: num(premium),
      commissionPct: num(commissionPct),
      perOccurrenceDeductible: num(perOccDed),
      perUnitDeductible: num(perUnitDed),
      blanketLimit: num(blanketLimit),
      coinsurancePct: num(coinsurance),
      replacementCostType: (rcType || null) as Quote["replacementCostType"],
      effectiveDate: effectiveDate || null,
      expirationDate: expirationDate || null,
      notes: notes.trim() || null,
    };

    try {
      if (isPolicy) {
        if (!existing) throw new Error("Policies are created by binding a quote.");
        const { errors } = await client.models.Policy.update({
          id: existing.id,
          ...shared,
          policyNumber: policyNumber.trim() || null,
          status: status as Policy["status"],
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else if (existing) {
        const { errors } = await client.models.Quote.update({
          id: existing.id,
          ...shared,
          status: status as Quote["status"],
        });
        if (errors?.length) throw new Error(errors[0].message);
      } else {
        const { errors } = await client.models.Quote.create({
          accountId,
          ...shared,
          status: status as Quote["status"],
        });
        if (errors?.length) throw new Error(errors[0].message);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // A bound quote's status is owned by the policy — don't offer to unwind it
  // from here, but don't hide it either.
  const statusOptions = isPolicy
    ? [...POLICY_STATUSES]
    : existing?.status === "BOUND"
      ? ["BOUND"]
      : [...QUOTE_STATUSES];

  return (
    <div className="card" style={{ background: "#f8fafc" }}>
      <h3 style={{ marginTop: 0 }}>
        {editing ? "Edit" : "New"} {isPolicy ? "policy" : "quote"}
      </h3>
      <div className="form-grid">
        <div className="field">
          <label>Carrier</label>
          <select value={carrierId} onChange={(e) => pickCarrier(e.target.value)}>
            <option value="">—</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {isPolicy && (
          <div className="field">
            <label>Policy number</label>
            <input
              value={policyNumber}
              onChange={(e) => setPolicyNumber(e.target.value)}
            />
          </div>
        )}
        <div className="field">
          <label>Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            disabled={statusOptions.length === 1}
          >
            {[...statusOptions].sort((a, b) => a.localeCompare(b)).map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Premium ($)</label>
          <input
            type="number"
            value={premium}
            onChange={(e) => setPremium(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Commission % (baked into premium)</label>
          <input
            type="number"
            step="0.1"
            min={0}
            max={100}
            value={commissionPct}
            onChange={(e) => {
              setCommissionTouched(true);
              setCommissionPct(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label>Effective date</label>
          <input
            type="date"
            value={effectiveDate}
            onChange={(e) => setEffectiveDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Expiration date</label>
          <input
            type="date"
            value={expirationDate}
            onChange={(e) => setExpirationDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Per-occurrence deductible ($)</label>
          <input
            type="number"
            value={perOccDed}
            onChange={(e) => setPerOccDed(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Per-unit deductible ($)</label>
          <input
            type="number"
            value={perUnitDed}
            onChange={(e) => setPerUnitDed(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Blanket limit ($)</label>
          <input
            type="number"
            value={blanketLimit}
            onChange={(e) => setBlanketLimit(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Coinsurance %</label>
          <input
            type="number"
            min={0}
            max={100}
            value={coinsurance}
            onChange={(e) => setCoinsurance(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Replacement cost</label>
          <select value={rcType} onChange={(e) => setRcType(e.target.value)}>
            <option value="">—</option>
            {RC_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field full">
          <label>Lines</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px" }}>
            {LINES_OF_BUSINESS.map((l) => (
              <label
                key={l}
                className="small"
                style={{ display: "flex", gap: 4, alignItems: "center" }}
              >
                <input
                  type="checkbox"
                  checked={lines.includes(l)}
                  onChange={() => toggleLine(l)}
                />
                {l}
              </label>
            ))}
          </div>
        </div>
        <div className="field full">
          <label>Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      <div className="form-actions">
        <button className="primary" disabled={saving} onClick={save}>
          {saving ? "Saving…" : editing ? "Save changes" : "Save quote"}
        </button>
        <button className="link" onClick={onCancel}>
          Cancel
        </button>
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}
