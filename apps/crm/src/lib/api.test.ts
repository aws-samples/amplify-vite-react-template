import { describe, expect, it } from "vitest";
import { listAll } from "./api";

/**
 * listAll is what stands between a list screen and silent truncation: a
 * filtered DynamoDB scan counts its limit against rows *scanned*, not rows
 * matched, so a single page can come back short — or empty — while a
 * nextToken says there is more. The Schedule pool and the tech's day list
 * both ride on this, so the paging contract gets pinned down here.
 */

type Row = { id: string };

/** A canned sequence of pages, served one per call, tracking tokens seen. */
function pagedFetcher(
  pages: { data: Row[]; nextToken?: string | null }[],
  tokensSeen: (string | undefined)[]
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
      pagedFetcher(
        [
          { data: [], nextToken: "t1" },
          { data: [{ id: "a" }] },
        ],
        []
      )
    );
    expect(rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("stops after a single page with no token", async () => {
    const tokens: (string | undefined)[] = [];
    const rows = await listAll(pagedFetcher([{ data: [{ id: "a" }] }], tokens));
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(tokens).toEqual([undefined]);
  });

  it("surfaces GraphQL errors on any page instead of returning a partial list", async () => {
    let call = 0;
    await expect(
      listAll(() => {
        call++;
        return Promise.resolve(
          call === 1
            ? { data: [{ id: "a" }], nextToken: "t1" }
            : { data: [], errors: [{ message: "boom" }] }
        );
      })
    ).rejects.toThrow("boom");
  });
});
