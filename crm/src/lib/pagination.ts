/**
 * Page through a filtered list until it's exhausted.
 *
 * DynamoDB applies `filter` AFTER reading a page of rows, so a single
 * `list({ filter })` silently returns nothing once the matching rows sit
 * outside the first page — a bug that only appears as a table grows. Any
 * filtered list that must be complete goes through here.
 *
 * Generic over the page shape rather than deriving the model type — naming
 * the client's return type directly (ReturnType<typeof ...list>) makes tsc
 * bail with "type instantiation is excessively deep".
 *
 * Lives here rather than in client.ts so the Lambdas can import it: client.ts
 * calls generateClient() at module scope, and a handler must not pull the
 * browser data client into its bundle. This module has no imports.
 */
export async function listAllPages<T>(
  fetchPage: (
    nextToken?: string
  ) => Promise<{ data: T[]; nextToken?: string | null }>,
  options?: {
    /** Stop after this many pages instead of reading to the end. */
    maxPages?: number;
  }
): Promise<T[]> {
  const out: T[] = [];
  const maxPages = options?.maxPages ?? Infinity;
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(token);
    out.push(...page.data);
    token = page.nextToken ?? undefined;
    pages++;
  } while (token && pages < maxPages);
  return out;
}
