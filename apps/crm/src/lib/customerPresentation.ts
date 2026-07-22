export function lifecycleActionTitle(action: string): string {
  if (action === "DEACTIVATE") return "Customer deactivated";
  if (action === "REACTIVATE") return "Customer reactivated";
  if (action === "GROUP_CHANGE") return "Customer group changed";
  const words = action.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function lifecycleReasonSummary(
  reason: string | null | undefined,
): string {
  if (!reason?.trim()) return "No reason recorded";
  const [rawCode, ...noteParts] = reason.split(" — ");
  const code = rawCode.trim();
  const note = noteParts.join(" — ").trim();
  const base = /^[A-Z0-9_]+$/.test(code) ? lifecycleActionTitle(code) : code;
  return note ? `${base} — ${note}` : base;
}

export function isTechnicalLifecycleReason(
  reason: string | null | undefined,
): boolean {
  return /\b(?:GL-\d+|drill|staging|test fixture)\b/i.test(reason ?? "");
}

export function groupChangeSummary(
  effects: string | null | undefined,
  groups: { id: string; name: string }[],
): string | null {
  const match = /^group:\s*(.*?)\s*→\s*(.*?)$/i.exec(effects ?? "");
  if (!match) return null;
  const groupName = (id: string) => {
    if (!id || id.toLowerCase() === "none") return "no group";
    return groups.find((group) => group.id === id)?.name ?? "an archived group";
  };
  return `Changed from ${groupName(match[1])} to ${groupName(match[2])}`;
}
