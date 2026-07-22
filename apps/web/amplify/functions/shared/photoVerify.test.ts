import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setS3ClientForTests, verifyCallbackPhoto } from "./photoVerify";

/**
 * GL-10 reopened — "a customer photo is REQUIRED" means a verified upload:
 * the key must live under THIS customer's callback prefix and reference a
 * real image object in the bucket. A plausible string, another customer's
 * key, an unfinished upload, or a non-image all refuse, fail closed.
 */

let headResult: { ContentType?: string } | (() => never) = {
  ContentType: "image/jpeg",
};
const headCalls: { Bucket?: string; Key?: string }[] = [];

const fakeS3 = {
  send: async (cmd: { input: { Bucket?: string; Key?: string } }) => {
    headCalls.push(cmd.input);
    if (typeof headResult === "function") return headResult();
    return headResult;
  },
};

beforeEach(() => {
  process.env.DOCS_BUCKET = "docs-bucket";
  headResult = { ContentType: "image/jpeg" };
  headCalls.length = 0;
  _setS3ClientForTests(fakeS3);
});

afterEach(() => {
  _setS3ClientForTests(null);
  delete process.env.DOCS_BUCKET;
});

describe("verifyCallbackPhoto", () => {
  it("accepts a real image under the customer's own prefix", async () => {
    await verifyCallbackPhoto("callbacks/c1/abc.jpg", "c1");
    expect(headCalls).toEqual([{ Bucket: "docs-bucket", Key: "callbacks/c1/abc.jpg" }]);
  });

  it("refuses a key outside the customer's prefix — no referencing other customers' files", async () => {
    await expect(
      verifyCallbackPhoto("callbacks/c2/theirs.jpg", "c1")
    ).rejects.toThrow(/isn't attached to this account/);
    await expect(
      verifyCallbackPhoto("agreements/contract.pdf", "c1")
    ).rejects.toThrow(/isn't attached to this account/);
    expect(headCalls).toHaveLength(0);
  });

  it("refuses when the object was never uploaded", async () => {
    headResult = () => {
      const err = new Error("no such key") as Error & { name: string };
      err.name = "NotFound";
      throw err;
    };
    await expect(
      verifyCallbackPhoto("callbacks/c1/ghost.jpg", "c1")
    ).rejects.toThrow(/upload didn't finish/);
  });

  it("refuses a non-image object", async () => {
    headResult = { ContentType: "application/pdf" };
    await expect(
      verifyCallbackPhoto("callbacks/c1/not-a-photo", "c1")
    ).rejects.toThrow(/isn't an image/);
  });

  it("fails closed when the bucket isn't configured or S3 is unreachable", async () => {
    delete process.env.DOCS_BUCKET;
    await expect(
      verifyCallbackPhoto("callbacks/c1/abc.jpg", "c1")
    ).rejects.toThrow(/isn't configured/);

    process.env.DOCS_BUCKET = "docs-bucket";
    headResult = () => {
      throw new Error("socket hang up");
    };
    await expect(
      verifyCallbackPhoto("callbacks/c1/abc.jpg", "c1")
    ).rejects.toThrow(/can't be verified right now/);
  });
});
