import { useParams } from "react-router-dom";
import { client, type Carrier } from "../lib/client";
import { Badge, flagBadge, CARRIER_APPOINTMENT_BADGE } from "../lib/badges";
import DocumentsPanel from "../components/DocumentsPanel";
import { CarrierForm } from "./carrier/CarrierForm";
import { AppetiteGuides } from "./carrier/AppetiteGuides";
import { useAsyncResource } from "../lib/useAsyncResource";

export default function CarrierDetail() {
  const { id } = useParams<{ id: string }>();

  /**
   * `!carrier` used to be the whole state machine: in-flight, failed,
   * not-found and no-route-param all rendered "Loading…", the last three
   * forever. Each now has its own answer.
   */
  const res = useAsyncResource(
    async () => {
      if (!id) return null;
      return (await client.models.Carrier.get({ id })).data;
    },
    [id],
    { initialData: null as Carrier | null, errorMessage: "Failed to load carrier" }
  );
  const carrier = res.data;

  if (!res.loaded) return <p className="muted">Loading…</p>;
  if (res.error) return <p className="error-text">{res.error}</p>;
  if (!carrier) return <p>Carrier not found.</p>;

  return (
    <>
      <h1>
        {carrier.name}{" "}
        <Badge {...flagBadge(carrier.appointed, CARRIER_APPOINTMENT_BADGE)} />
      </h1>
      <p className="sub">Carrier appointment &amp; appetite</p>

      <CarrierForm carrier={carrier} onChange={res.setData} />
      <AppetiteGuides carrierId={carrier.id} />

      <div className="card">
        <h2>Documents</h2>
        <DocumentsPanel entityType="CARRIER" entityId={carrier.id} />
      </div>
    </>
  );
}
