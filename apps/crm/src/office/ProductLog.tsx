import { useCallback, useEffect, useState } from "react";
import { api, unwrap, type Product } from "../lib/api";
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
          {products.map((p) => (
            <ListRow
              key={p.id}
              title={p.name}
              subtitle={[
                p.epaNumber ? `EPA #${p.epaNumber}` : null,
                p.activeIngredient,
                p.targetPests ? `targets ${p.targetPests}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "No details yet"}
              meta={
                p.active ? (
                  <Badge tone="ok">active</Badge>
                ) : (
                  <Badge tone="muted">inactive</Badge>
                )
              }
              onClick={() => setEditing(p)}
            />
          ))}
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
  const [targetPests, setTargetPests] = useState(existing?.targetPests ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError("Enter the product name");
      return;
    }
    setBusy(true);
    setError(null);
    const fields = {
      name: name.trim(),
      epaNumber: epaNumber.trim() || null,
      activeIngredient: activeIngredient.trim() || null,
      defaultQuantity: defaultQuantity.trim() || null,
      targetPests: targetPests.trim() || null,
      notes: notes.trim() || null,
      active,
    };
    try {
      if (existing) {
        unwrap(
          await api().models.Product.update({ id: existing.id, ...fields })
        );
      } else {
        unwrap(await api().models.Product.create(fields));
      }
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
        <Field label="Default amount" hint="Prefills the report">
          <input
            value={defaultQuantity}
            onChange={(e) => setDefaultQuantity(e.target.value)}
            placeholder="1 oz / gal"
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
      <Field label="Target pests">
        <input
          value={targetPests}
          onChange={(e) => setTargetPests(e.target.value)}
          placeholder="Ants, spiders, roaches"
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
