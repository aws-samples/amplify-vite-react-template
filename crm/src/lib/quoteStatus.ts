/**
 * The one classification of `QuoteStatus`.
 *
 * The "which statuses are still open" list was written four times — three
 * hand-typed arrays plus a GraphQL `or:` filter — and the fourth copy had
 * already drifted into a different (larger) set under a name that gave no
 * hint of the difference. Everything a caller needs about a quote status is
 * derived here from ONE table.
 *
 * How drift is prevented: `QUOTE_STATUS_KIND` is `satisfies
 * Record<QuoteStatus, QuoteStatusKind>`, where `QuoteStatus` is the schema
 * enum itself. Add a status to `amplify/data/resource.ts` and this file stops
 * compiling until the new status is classified; delete one and the now-excess
 * key stops compiling too. There is no way to add a status and have it be
 * silently omitted from these lists — the lists are computed from the table,
 * not written out a second time.
 *
 * Type-only import of `Schema`, so nothing from `amplify/` — and in
 * particular no `generateClient()` call, the way `client.ts` has at module
 * scope — is pulled into a bundle or a test run.
 */
import type { Schema } from "../../amplify/data/resource";

/** The schema's `QuoteStatus` enum. Ground truth for what statuses exist. */
export type QuoteStatus = Schema["QuoteStatus"]["type"];

/**
 * - `OPEN`   — still being worked; shows in the pipeline.
 * - `BOUND`  — closed, and reachable only by binding a quote. Never offered
 *              in a status dropdown, which is the one way it differs from
 *              the other closed statuses.
 * - `CLOSED` — closed by a human picking it (declined, lost).
 */
type QuoteStatusKind = "OPEN" | "BOUND" | "CLOSED";

/**
 * The single table. Every list below is derived from it.
 *
 * `satisfies` (not `:`) so the literal key/value types survive for the
 * mapped types below, while still forcing exhaustiveness against the enum.
 */
const QUOTE_STATUS_KIND = {
  DRAFT: "OPEN",
  SUBMITTED: "OPEN",
  QUOTED: "OPEN",
  PRESENTED: "OPEN",
  BOUND: "BOUND",
  DECLINED: "CLOSED",
  LOST: "CLOSED",
} as const satisfies Record<QuoteStatus, QuoteStatusKind>;

type StatusesOfKind<K extends QuoteStatusKind> = {
  [S in QuoteStatus]: (typeof QUOTE_STATUS_KIND)[S] extends K ? S : never;
}[QuoteStatus];

/** `"DRAFT" | "SUBMITTED" | "QUOTED" | "PRESENTED"`, derived. */
export type OpenQuoteStatus = StatusesOfKind<"OPEN">;
/** Everything that is not open — including `BOUND`. */
export type ClosedQuoteStatus = Exclude<QuoteStatus, OpenQuoteStatus>;
/** Every status a human may pick from a dropdown: all but `BOUND`. */
export type SelectableQuoteStatus = StatusesOfKind<"OPEN" | "CLOSED">;

/**
 * Safe cast: `satisfies Record<QuoteStatus, …>` above rejects both a missing
 * key and an excess one, so the table's keys are exactly the enum's members.
 * Declaration order matches the enum's order in the schema.
 */
const ALL = Object.keys(QUOTE_STATUS_KIND) as QuoteStatus[];

/** Is this one of the schema's quote statuses at all? */
export function isQuoteStatus(s: string | null | undefined): s is QuoteStatus {
  return s != null && Object.prototype.hasOwnProperty.call(QUOTE_STATUS_KIND, s);
}

/** Still in the pipeline. */
export function isOpenQuoteStatus(
  s: string | null | undefined
): s is OpenQuoteStatus {
  return isQuoteStatus(s) && QUOTE_STATUS_KIND[s] === "OPEN";
}

/** Done — bound, declined or lost. False for anything not a status. */
export function isClosedQuoteStatus(
  s: string | null | undefined
): s is ClosedQuoteStatus {
  return isQuoteStatus(s) && QUOTE_STATUS_KIND[s] !== "OPEN";
}

/** Offerable in a status `<select>`. */
export function isSelectableQuoteStatus(
  s: string | null | undefined
): s is SelectableQuoteStatus {
  return isQuoteStatus(s) && QUOTE_STATUS_KIND[s] !== "BOUND";
}

/** Every status the schema allows, in schema order. */
export const ALL_QUOTE_STATUSES: readonly QuoteStatus[] = Object.freeze(ALL);

/** The list this module exists for. Schema order: DRAFT → PRESENTED. */
export const OPEN_QUOTE_STATUSES: readonly OpenQuoteStatus[] = Object.freeze(
  ALL.filter(isOpenQuoteStatus)
);

/** The exact complement of {@link OPEN_QUOTE_STATUSES}. */
export const CLOSED_QUOTE_STATUSES: readonly ClosedQuoteStatus[] =
  Object.freeze(ALL.filter(isClosedQuoteStatus));

/**
 * Statuses a human may pick. This is the list `CoverageForm` used to call
 * `QUOTE_STATUSES` and `QuotesPanel` used to spell `[...OPEN_STATUSES,
 * "DECLINED", "LOST"]` — a superset of the open set, and deliberately not the
 * same list. Both now read it from here.
 */
export const SELECTABLE_QUOTE_STATUSES: readonly SelectableQuoteStatus[] =
  Object.freeze(ALL.filter(isSelectableQuoteStatus));

/**
 * The `or:` shape `client.models.Quote.list({ filter })` wants.
 *
 * Written structurally rather than as Amplify's generated
 * `ModelQuoteFilterInput`: that type is only reachable through the client
 * module, and importing it here would drag `generateClient()` back in. It is
 * assignable to the real parameter — verified against `Quote.list` — and
 * arrays are mutable and freshly built per call, because Amplify's filter
 * input is not `readonly`.
 */
export type QuoteStatusFilter = { or: { status: { eq: QuoteStatus } }[] };

/** `or:`-filter for an arbitrary set of statuses. */
export function quoteStatusFilter(
  statuses: readonly QuoteStatus[]
): QuoteStatusFilter {
  return { or: statuses.map((status) => ({ status: { eq: status } })) };
}

/**
 * Drop-in for the hand-written four-clause `or:` filter: the same list as
 * {@link OPEN_QUOTE_STATUSES}, in the shape a GraphQL list call takes.
 */
export function openQuoteStatusFilter(): QuoteStatusFilter {
  return quoteStatusFilter(OPEN_QUOTE_STATUSES);
}
