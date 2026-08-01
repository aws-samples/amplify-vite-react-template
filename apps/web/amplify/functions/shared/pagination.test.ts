import { describe, expect, it } from "vitest";
import { forEachPage, listAll, type PageResult } from "./pagination";

/**
 * The one pagination loop. Every backend scan and every CRM list screen rides
 * on this contract, so it gets pinned here: exhaustion, ordering, the error
 * policy split, and forEachPage's short-circuit.
 */

type Row = { id: string };

function pagedFetcher(
  pages: PageResult<Row>[],
  tokensSeen: (string | undefined)[] = []
) {
  let call = 0;
  return (nextToken?: string) => {
    tokensSeen.push(nextToken);
    return Promise.resolve(pages[call++]);
  };
}

describe("listAll", () => {
  it("follows nextToken to exhaustion and concatenates in order", async () => {
    const tokens: (string | undefined)[] = [];
    const rows = await listAll(
      pagedFetcher(
        [
          { data: [{ id: "a" }, { id: "b" }], nextToken: "t1" },
          { data: [{ id: "c" }], nextToken: "t2" },
          { data: [{ id: "d" }], nextToken: null },
        ],
        tokens
      )
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(tokens).toEqual([undefined, "t1", "t2"]);
  });

  it("keeps paging through an empty page — a filtered scan can match nothing on a page and still have more", async () => {
    const rows = await listAll(
      pagedFetcher([{ data: [], nextToken: "t1" }, { data: [{ id: "a" }] }])
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("tolerates a null data page", async () => {
    const rows = await listAll(
      pagedFetcher([{ data: null, nextToken: "t1" }, { data: [{ id: "a" }] }])
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("surfaces GraphQL errors on any page instead of returning a partial list", async () => {
    await expect(
      listAll(
        pagedFetcher([
          { data: [{ id: "a" }], nextToken: "t1" },
          { data: [], errors: [{ message: "boom" }, { message: "bust" }] },
        ])
      )
    ).rejects.toThrow("boom; bust");
  });

  it('pageErrors: "ignore" treats an errored page as a short page and keeps paging', async () => {
    const rows = await listAll(
      pagedFetcher([
        { data: [{ id: "a" }], nextToken: "t1" },
        { data: null, errors: [{ message: "boom" }], nextToken: "t2" },
        { data: [{ id: "b" }] },
      ]),
      { pageErrors: "ignore" }
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("forEachPage", () => {
  it("streams pages in order without accumulating", async () => {
    const seen: string[][] = [];
    await forEachPage(
      pagedFetcher([
        { data: [{ id: "a" }, { id: "b" }], nextToken: "t1" },
        { data: [{ id: "c" }] },
      ]),
      (items) => {
        seen.push(items.map((r) => r.id));
      }
    );
    expect(seen).toEqual([["a", "b"], ["c"]]);
  });

  it("stops when onPage returns false, before fetching the next page", async () => {
    const tokens: (string | undefined)[] = [];
    const seen: string[] = [];
    await forEachPage(
      pagedFetcher(
        [
          { data: [{ id: "a" }], nextToken: "t1" },
          { data: [{ id: "b" }], nextToken: "t2" },
          { data: [{ id: "c" }] },
        ],
        tokens
      ),
      (items) => {
        seen.push(...items.map((r) => r.id));
        return seen.includes("b") ? false : undefined;
      }
    );
    expect(seen).toEqual(["a", "b"]);
    expect(tokens).toEqual([undefined, "t1"]);
  });

  it("awaits an async onPage per page — side effects stay page-ordered", async () => {
    const order: string[] = [];
    await forEachPage(
      pagedFetcher([
        { data: [{ id: "a" }], nextToken: "t1" },
        { data: [{ id: "b" }] },
      ]),
      async (items) => {
        order.push(`start:${items[0].id}`);
        await Promise.resolve();
        order.push(`end:${items[0].id}`);
      }
    );
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("propagates page errors under the default policy", async () => {
    await expect(
      forEachPage(
        pagedFetcher([{ data: [], errors: [{ message: "boom" }] }]),
        () => undefined
      )
    ).rejects.toThrow("boom");
  });
});
