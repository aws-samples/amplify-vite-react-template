import type { License, UserProfile } from "../../lib/client";

export type HolderType = "FIRM" | "PRODUCER";

export function holderLabel(l: License, profiles: UserProfile[]): string {
  if (l.holderType === "FIRM") return "(firm)";
  const p = profiles.find((x) => x.id === l.userProfileId);
  return p ? `${p.firstName} ${p.lastName}` : l.holderName ?? "(unassigned)";
}
