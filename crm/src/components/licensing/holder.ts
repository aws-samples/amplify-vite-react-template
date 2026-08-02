import type { License, UserProfile } from "../../lib/client";
import type { LicenseHolderType } from "../../lib/enums";

/** The schema's `LicenseHolderType`, under the name licensing code uses. */
export type HolderType = LicenseHolderType;

export function holderLabel(l: License, profiles: UserProfile[]): string {
  if (l.holderType === "FIRM") return "(firm)";
  const p = profiles.find((x) => x.id === l.userProfileId);
  return p ? `${p.firstName} ${p.lastName}` : l.holderName ?? "(unassigned)";
}
