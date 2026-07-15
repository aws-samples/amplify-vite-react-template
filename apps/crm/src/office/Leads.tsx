import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  listAll,
  unwrap, type Customer } from "../lib/api";
import { fmtDate } from "../lib/format";
import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  ListRow,
  Page,
  Sheet,
  Spinner,
} from "../ui/kit";
import CustomerForm, { customerToForm } from "../components/CustomerForm";
import PriceLeadSheet from "../components/PriceLeadSheet";

export default function Leads() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pricing, setPricing] = useState(false);

  const load = useCallback(async () => {
    try {
      setLeads(
        await listAll((t) =>
          api().models.Customer.listCustomerByStatusAndDisplayName(
            { status: "LEAD" },
            { limit: 500, nextToken: t }
          )
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load leads");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page
      title="Leads"
      actions={
        <>
          <Button small variant="subtle" onClick={() => setPricing(true)}>
            ⚡ Price a lead
          </Button>
          <Button small onClick={() => setAdding(true)}>
            + Lead
          </Button>
        </>
      }
    >
      <ErrorNote error={error} />
      {!leads ? (
        <Spinner />
      ) : leads.length === 0 ? (
        <EmptyState
          title="No open leads"
          body="New website inquiries and manually added leads will show up here."
          action={<Button onClick={() => setAdding(true)}>Add a lead</Button>}
        />
      ) : (
        <Card>
          {leads.map((lead) => (
            <ListRow
              key={lead.id}
              title={lead.displayName}
              subtitle={[lead.serviceCity, lead.leadSource]
                .filter(Boolean)
                .join(" · ")}
              meta={<span>{fmtDate(lead.createdAt)}</span>}
              onClick={() => navigate(`/customers/${lead.id}`)}
            />
          ))}
        </Card>
      )}

      <Sheet open={pricing} onClose={() => setPricing(false)} title="Price a lead">
        <PriceLeadSheet />
      </Sheet>

      <Sheet open={adding} onClose={() => setAdding(false)} title="New lead">
        <CustomerForm
          initial={customerToForm()}
          submitLabel="Add lead"
          showLeadSource
          onSubmit={async (v) => {
            unwrap(
              await api().models.Customer.create({
                displayName: v.displayName.trim(),
                contactName: v.contactName.trim() || undefined,
                email: v.email.trim() || undefined,
                phone: v.phone.trim() || undefined,
                serviceStreet: v.serviceStreet.trim() || undefined,
                serviceCity: v.serviceCity.trim() || undefined,
                serviceState: v.serviceState.trim() || undefined,
                serviceZip: v.serviceZip.trim() || undefined,
                leadSource: v.leadSource.trim() || undefined,
                notes: v.notes.trim() || undefined,
                status: "LEAD",
              })
            );
            setAdding(false);
            await load();
          }}
        />
      </Sheet>
    </Page>
  );
}
