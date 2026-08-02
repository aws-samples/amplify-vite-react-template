import { type Account } from "../lib/client";
import DetailsCard from "./property/DetailsCard";
import BuildingsCard from "./property/BuildingsCard";
import PhotosCard from "./property/PhotosCard";

/** Underwriting property details: construction, system updates, buildings,
 * and site photos. Feeds the ACORD 140 autofill. */
export default function PropertyPanel({
  account,
  onChange,
}: {
  account: Account;
  onChange: (a: Account) => void;
}) {
  return (
    <>
      <DetailsCard account={account} onChange={onChange} />
      <BuildingsCard accountId={account.id} />
      <PhotosCard account={account} onChange={onChange} />
    </>
  );
}
