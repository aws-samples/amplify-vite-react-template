export const money = (cents?: number | null) =>
  cents == null
    ? "—"
    : (cents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });

/** "Jul 14" / "Jul 14, 2026" from an ISO date (YYYY-MM-DD) or datetime. */
export const fmtDate = (iso?: string | null, withYear = false) => {
  if (!iso) return "—";
  const d = iso.includes("T") ? new Date(iso) : new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
};

export const fmtDateTime = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

/** Today's date (YYYY-MM-DD) in the shop's timezone. */
export const todayEastern = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export const addDays = (isoDate: string, days: number) => {
  const d = new Date(`${isoDate}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Monday of the week containing `isoDate` (the shop's weeks start Monday). */
export const startOfWeek = (isoDate: string) => {
  const dow = new Date(`${isoDate}T12:00:00`).getDay(); // 0 Sun … 6 Sat
  return addDays(isoDate, -((dow + 6) % 7));
};

export const prettyWeekday = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
