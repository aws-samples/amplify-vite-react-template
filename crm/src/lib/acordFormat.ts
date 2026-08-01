// Value formatters for ACORD PDF form fields. Public entry point: ./acord.ts

import { fmtDate, fmtNum } from "./client";

// ── Rendering values into PDF form fields ────────────────────────────
//
// Both helpers below are `fmtDate`/`fmtNum` with one deliberate difference:
// **absent renders as blank, not as "—".** A screen can say "—" to mean "we
// don't hold this"; a printed ACORD field cannot — an em dash typed into
// `Policy_ExpirationDate_A` is a literal mark on a form a carrier or a
// mortgagee reads, and it looks like data. An empty field is how paper says
// "not provided". So the *emptiness* rule is local to this module and the
// *formatting* rule is shared, rather than the whole thing being copied.

/** A date as `fmtDate` renders it everywhere else; blank when there isn't one. */
export const fmtUs = (d: string | null | undefined) => (d ? fmtDate(d) : "");

/**
 * A coverage limit as whole dollars: `fmtNum` plus the rounding these fields
 * want (cents on a $1,000,000 aggregate are noise, and the boxes are narrow).
 * Blank when there is no figure.
 *
 * Module-level so the OTHER-policy blanket limit can call it — that site had
 * this same body inlined, in a block the previous function-local declaration
 * was out of scope for.
 */
export const amt = (n: number | null | undefined) =>
  n == null ? "" : fmtNum(Math.round(n));

/** Today, rendered by the same `fmtDate` as every other date on the form.
 *  The local calendar day, matching what `new Date().toLocaleDateString()`
 *  printed here before — the reader of a form completed at 9pm in Boston
 *  expects today's date on it, not tomorrow's UTC one. */
export function todayUs(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return fmtDate(
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  );
}
