import { useCallback, useEffect, useState } from "react";
import { api, opResult, unwrap, type Product } from "../lib/api";
import { SERVICE_CATALOG } from "../../../web/amplify/functions/shared/serviceCatalog";
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
} from "../ui/kit";

function productComplianceIssue(product: Product): string | null {
  if (!product.labelApproved) return "label not approved";
  if (!product.epaNumber?.trim()) return "EPA number missing";
  if (!product.defaultRate?.trim()) return "application rate missing";
  if (product.reEntryHours == null) return "re-entry rule missing";
  return null;
}

/**
 * Master product log. Technicians pick from this catalog when recording
 * products applied on a service report; the office curates it here.
 */
export default function ProductLog() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows: Product[] = [];
      let nextToken: string | null | undefined;
      do {
        const page = await api().models.Product.list({
          limit: 500,
          nextToken: nextToken ?? undefined,
        });
        rows.push(...unwrap(page));
        nextToken = page.nextToken;
      } while (nextToken);
      setProducts(
        rows.sort(
          (a, b) =>
            (a.sortOrder ?? 999) - (b.sortOrder ?? 999) ||
            a.name.localeCompare(b.name)
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load products");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page
      title="Product log"
      back="/more"
      actions={
        <Button small variant="ghost" onClick={() => setEditing("new")}>
          + Product
        </Button>
      }
    >
      <ErrorNote error={error} />
      {products === null ? (
        <Spinner />
      ) : products.length === 0 ? (
        <EmptyState
          title="No products yet"
          body="Add the products BuzzKill applies — technicians pick from this list when filing service reports."
          action={<Button onClick={() => setEditing("new")}>Add the first product</Button>}
        />
      ) : (
        <Card>
          {products.map((p) => {
            const issue = p.active ? productComplianceIssue(p) : null;
            return (
              <ListRow
                key={p.id}
                title={p.name}
                subtitle={[
                  p.epaNumber ? `EPA #${p.epaNumber}` : null,
                  p.activeIngredient,
                  p.defaultRate ? `rate ${p.defaultRate}` : null,
                  p.reEntryHours != null ? `re-entry ${p.reEntryHours}h` : null,
                  p.targetPests ? `targets ${p.targetPests}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No details yet"}
                meta={
                  issue ? (
                    <Badge tone="warn">blocked · {issue}</Badge>
                  ) : p.active ? (
                    <Badge tone="ok">active</Badge>
                  ) : (
                    <Badge tone="muted">inactive</Badge>
                  )
                }
                onClick={() => setEditing(p)}
              />
            );
          })}
        </Card>
      )}

      <Sheet
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New product" : "Edit product"}
      >
        {editing !== null ? (
          <ProductForm
            existing={editing === "new" ? null : editing}
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

function ProductForm({
  existing,
  onDone,
}: {
  existing: Product | null;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [epaNumber, setEpaNumber] = useState(existing?.epaNumber ?? "");
  const [activeIngredient, setActiveIngredient] = useState(
    existing?.activeIngredient ?? ""
  );
  const [defaultQuantity, setDefaultQuantity] = useState(
    existing?.defaultQuantity ?? ""
  );
  const [defaultRate, setDefaultRate] = useState(existing?.defaultRate ?? "");
  const [reEntryHours, setReEntryHours] = useState(
    existing?.reEntryHours != null ? String(existing.reEntryHours) : ""
  );
  const [labelApproved, setLabelApproved] = useState(
    existing?.labelApproved ?? false
  );
  const [targetPests, setTargetPests] = useState(existing?.targetPests ?? "");
  // GL-15: the enforceable label rules finalization fails closed against.
  // Stored as structured JSON; edited here as plain fields so the office never
  // types JSON.
  const existingRules = (() => {
    try {
      const raw = (existing as { labelRulesJson?: unknown } | null | undefined)
        ?.labelRulesJson;
      if (!raw) return null;
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as {
        allowedServiceTypes?: string[];
        allowedPests?: string[];
        quantity?: { min: number; max: number; unit: string };
        rates?: string[];
        minReEntryHours?: number;
      };
    } catch {
      return null;
    }
  })();
  const [ruleServiceTypes, setRuleServiceTypes] = useState(
    (existingRules?.allowedServiceTypes ?? []).join(", ")
  );
  const [rulePests, setRulePests] = useState(
    (existingRules?.allowedPests ?? []).join(", ")
  );
  const [ruleRates, setRuleRates] = useState(
    (existingRules?.rates ?? []).join(", ")
  );
  const [ruleQtyMin, setRuleQtyMin] = useState(
    existingRules?.quantity ? String(existingRules.quantity.min) : ""
  );
  const [ruleQtyMax, setRuleQtyMax] = useState(
    existingRules?.quantity ? String(existingRules.quantity.max) : ""
  );
  const [ruleQtyUnit, setRuleQtyUnit] = useState(
    existingRules?.quantity?.unit ?? ""
  );
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError("Enter the product name");
      return;
    }
    if (
      active &&
      (!labelApproved ||
        !epaNumber.trim() ||
        !defaultRate.trim() ||
        reEntryHours.trim() === "")
    ) {
      setError(
        "Active products require approved label data, an EPA number, application rate, and re-entry rule"
      );
      return;
    }
    const parsedReEntry =
      reEntryHours.trim() === "" ? undefined : Number(reEntryHours);
    if (
      parsedReEntry != null &&
      (!Number.isFinite(parsedReEntry) || parsedReEntry < 0)
    ) {
      setError("Re-entry hours must be zero or greater");
      return;
    }
    const list = (v: string) =>
      v
        .split(/[,;]/)
        .map((x) => x.trim())
        .filter(Boolean);
    let labelRulesJson: string | null = null;
    const hasQty =
      ruleQtyMin.trim() !== "" || ruleQtyMax.trim() !== "" || ruleQtyUnit.trim() !== "";
    if (hasQty && (ruleQtyMin.trim() === "" || ruleQtyMax.trim() === "" || !ruleQtyUnit.trim())) {
      setError("A quantity rule needs min, max, and a unit (e.g. oz)");
      return;
    }
    const rules: Record<string, unknown> = {};
    if (list(ruleServiceTypes).length) rules.allowedServiceTypes = list(ruleServiceTypes);
    if (list(rulePests).length) rules.allowedPests = list(rulePests);
    if (list(ruleRates).length) rules.rates = list(ruleRates);
    if (hasQty) {
      const min = Number(ruleQtyMin);
      const max = Number(ruleQtyMax);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        setError("The quantity rule needs numeric min ≤ max");
        return;
      }
      rules.quantity = { min, max, unit: ruleQtyUnit.trim() };
    }
    if (Object.keys(rules).length) labelRulesJson = JSON.stringify(rules);
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      epaNumber: epaNumber.trim() || null,
      activeIngredient: activeIngredient.trim() || null,
      defaultQuantity: defaultQuantity.trim() || null,
      defaultRate: defaultRate.trim() || null,
      reEntryHours: parsedReEntry,
      labelApproved,
      targetPests: targetPests.trim() || null,
      labelRulesJson,
      notes: notes.trim() || null,
      active,
    };
    try {
      opResult(
        await api().mutations.saveProduct({
          productId: existing?.id,
          ...fields,
        })
      );
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save product");
      setBusy(false);
    }
  };

  return (
    <div className="form-grid">
      <Field label="Product name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Talstar P Professional"
        />
      </Field>
      <div className="form-row-2">
        <Field label="EPA #">
          <input
            value={epaNumber}
            onChange={(e) => setEpaNumber(e.target.value)}
            placeholder="279-3206"
          />
        </Field>
        <Field label="Active ingredient">
          <input
            value={activeIngredient}
            onChange={(e) => setActiveIngredient(e.target.value)}
            placeholder="Bifenthrin 7.9%"
          />
        </Field>
      </div>
      <div className="form-row-2">
        <Field label="Default amount" hint="Typical amount applied; tech can adjust">
          <input
            value={defaultQuantity}
            onChange={(e) => setDefaultQuantity(e.target.value)}
            placeholder="2 oz"
          />
        </Field>
        <Field label="Active">
          <SegControl
            options={[
              { value: "yes" as const, label: "Yes" },
              { value: "no" as const, label: "No" },
            ]}
            value={active ? "yes" : "no"}
            onChange={(v) => setActive(v === "yes")}
          />
        </Field>
      </div>
      <div className="form-row-2">
        <Field label="Label application rate / dilution" hint="Required when active">
          <input
            value={defaultRate}
            onChange={(e) => setDefaultRate(e.target.value)}
            placeholder="1 oz / gal (0.06%)"
          />
        </Field>
        <Field label="Label re-entry (hours)" hint="Use 0 when the label permits immediate re-entry">
          <input
            type="number"
            min="0"
            step="0.5"
            value={reEntryHours}
            onChange={(e) => setReEntryHours(e.target.value)}
            placeholder="4"
          />
        </Field>
      </div>
      <Field label="Approved label data">
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="checkbox"
            style={{ width: "auto", marginTop: 3 }}
            checked={labelApproved}
            onChange={(e) => setLabelApproved(e.target.checked)}
          />
          <span>
            I checked the EPA number, application rate, and re-entry rule
            against the approved product label.
          </span>
        </label>
      </Field>
      <Field label="Target pests">
        <input
          value={targetPests}
          onChange={(e) => setTargetPests(e.target.value)}
          placeholder="Ants, spiders, roaches"
        />
      </Field>
      <Field
        group
        label="Label rules (enforced at report time)"
        hint="Facets you fill in are refused when a report falls outside them. Leave blank to enforce only the rate above."
      >
        <input
          value={ruleRates}
          onChange={(e) => setRuleRates(e.target.value)}
          placeholder="Other approved rates, comma-separated (optional)"
        />
        <input
          value={rulePests}
          onChange={(e) => setRulePests(e.target.value)}
          placeholder="Allowed pests, comma-separated (optional)"
        />
        {/* GL-01: service types come from the ONE catalog — the datalist
            offers the canonical labels so a typo can't silently disagree
            with what jobs actually record. */}
        <input
          list="catalog-service-labels"
          value={ruleServiceTypes}
          onChange={(e) => setRuleServiceTypes(e.target.value)}
          placeholder="Allowed service types, comma-separated (optional)"
        />
        <datalist id="catalog-service-labels">
          {Object.values(SERVICE_CATALOG).map((s) => (
            <option key={s.id} value={s.label} />
          ))}
        </datalist>
        <div className="form-row-2">
          <input
            value={ruleQtyMin}
            onChange={(e) => setRuleQtyMin(e.target.value)}
            placeholder="Qty min"
          />
          <input
            value={ruleQtyMax}
            onChange={(e) => setRuleQtyMax(e.target.value)}
            placeholder="Qty max"
          />
        </div>
        <input
          value={ruleQtyUnit}
          onChange={(e) => setRuleQtyUnit(e.target.value)}
          placeholder="Qty unit (oz, gal…)"
        />
      </Field>
      <Field label="Notes" hint="Mixing/application notes for techs">
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <ErrorNote error={error} />
      <Button block loading={busy} onClick={() => void save()}>
        {existing ? "Save product" : "Add product"}
      </Button>
    </div>
  );
}
