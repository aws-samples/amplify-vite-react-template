import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { client, type Carrier } from "../lib/client";
import { Badge, flagBadge, CARRIER_APPOINTMENT_BADGE } from "../lib/badges";
import DocumentsPanel from "../components/DocumentsPanel";
import { CarrierForm } from "./carrier/CarrierForm";
import { AppetiteGuides } from "./carrier/AppetiteGuides";

export default function CarrierDetail() {
  const { id } = useParams<{ id: string }>();
  const [carrier, setCarrier] = useState<Carrier | null>(null);

  useEffect(() => {
    if (!id) return;
    client.models.Carrier.get({ id }).then(({ data }) => setCarrier(data));
  }, [id]);

  if (!carrier) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>
        {carrier.name}{" "}
        <Badge {...flagBadge(carrier.appointed, CARRIER_APPOINTMENT_BADGE)} />
      </h1>
      <p className="sub">Carrier appointment &amp; appetite</p>

      <CarrierForm carrier={carrier} onChange={setCarrier} />
      <AppetiteGuides carrierId={carrier.id} />

      <div className="card">
        <h2>Documents</h2>
        <DocumentsPanel entityType="CARRIER" entityId={carrier.id} />
      </div>
    </>
  );
}
