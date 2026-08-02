/**
 * The one pagination loop. Every exhaustive or streaming read of an Amplify
 * Data list goes through here — nobody hand-writes `do … while (nextToken)`.
 *
 * Pure leaf: zero imports, shared verbatim with the CRM via re-export from
 * `apps/crm/src/lib/api.ts` (see docs/audit/PATTERNS.md, pattern 3).
 */

/** One page of an Amplify Data list result. */
export type PageResult<T> = {
  data: T[] | null;
  nextToken?: string | null;
  errors?: { message: string }[];
};

export type PageOptions = {
  /**
   * "throw" (default): a page carrying GraphQL `errors` aborts the scan with
   * an exception — a partial scan must never pass for a complete one.
   * "ignore": legacy call sites migrated verbatim from loops that silently
   * treated an errored page as a short page. Every "ignore" is marked debt
   * for the error-handling cleanup (INVENTORY.md item on swallowed errors);
   * do not write it into new code.
   *
   * An EXPLICIT "throw" means the site was reviewed and is deliberately
   * strict: it feeds a decision about money, capacity, or access, where a
   * short read does not degrade an answer but inverts it — an unpaid balance
   * reads as settled, a booked day reads as free. Those paths must fail loudly
   * rather than decide on half the rows. The remaining "ignore" count is still
   * the greppable backlog.
   */
  pageErrors?: "throw" | "ignore";
};

function pageData<T>(page: PageResult<T>, opts?: PageOptions): T[] {
  if ((opts?.pageErrors ?? "throw") === "throw" && page.errors?.length) {
    throw new Error(page.errors.map((e) => e.message).join("; "));
  }
  return page.data ?? [];
}

/**
 * Stream a paginated list, one page at a time, without holding every row.
 * `onPage` may return `false` to stop before exhaustion (short-circuit
 * searches, found-it scans); any other return value continues.
 */
export async function forEachPage<T>(
  fetchPage: (nextToken?: string) => Promise<PageResult<T>>,
  onPage: (items: T[]) => boolean | undefined | void | Promise<boolean | undefined | void>,
  opts?: PageOptions
): Promise<void> {
  let token: string | null | undefined;
  do {
    const page = await fetchPage(token ?? undefined);
    const proceed = await onPage(pageData(page, opts));
    if (proceed === false) return;
    token = page.nextToken;
  } while (token);
}

/**
 * Exhaustively page a list query. Dashboard totals, rosters, and long lists
 * must never silently truncate at one page (DynamoDB may also return fewer
 * items than `limit` per page even when more exist).
 */
export async function listAll<T>(
  fetchPage: (nextToken?: string) => Promise<PageResult<T>>,
  opts?: PageOptions
): Promise<T[]> {
  const out: T[] = [];
  await forEachPage(fetchPage, (items) => {
    out.push(...items);
  }, opts);
  return out;
}
