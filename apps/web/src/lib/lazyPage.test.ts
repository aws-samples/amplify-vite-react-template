import { describe, expect, it } from "vitest";
import { chunkRecovery, isChunkLoadError } from "./lazyPage";

/**
 * The stale-deploy recovery rule.
 *
 * Observed on staging: a deploy landed while a customer was mid-funnel, the
 * hashed chunk their index.html named stopped existing, and /book rendered a
 * BLANK page at the payment step. The reload is the fix, but it has to be
 * bounded — a page that reloads forever is worse than one that fails once.
 */

/** The real message Chrome threw on staging, verbatim from the console. */
const CHROME =
  "TypeError: Failed to fetch dynamically imported module: https://staging.pestbuzzkill.com/assets/BookPage-C2B08sB1.js";

describe("isChunkLoadError", () => {
  it("recognizes each browser's wording for a chunk that isn't there", () => {
    expect(isChunkLoadError(new Error(CHROME))).toBe(true);
    expect(
      isChunkLoadError(new Error("Importing a module script failed."))
    ).toBe(true);
    expect(
      isChunkLoadError(new Error("error loading dynamically imported module"))
    ).toBe(true);
  });

  it("does not claim an ordinary module bug is a missing chunk", () => {
    expect(isChunkLoadError(new Error("x is not a function"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Cannot read properties of null"))).toBe(
      false
    );
  });

  it("survives a non-Error rejection", () => {
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError({ message: CHROME })).toBe(false); // not an Error
    expect(isChunkLoadError(CHROME)).toBe(true); // a bare string is readable
  });
});

describe("chunkRecovery", () => {
  it("reloads once for a missing chunk — the staging /book blank page", () => {
    expect(chunkRecovery(new Error(CHROME), false)).toBe("reload");
  });

  it("refuses to reload a second time, so it cannot loop", () => {
    // The reload already happened and the chunk STILL won't load (offline, or
    // a genuinely broken deploy). The customer gets an error page with a phone
    // number instead of a refresh loop.
    expect(chunkRecovery(new Error(CHROME), true)).toBe("rethrow");
  });

  it("never reloads for a module that threw — reloading just repeats it", () => {
    expect(chunkRecovery(new Error("x is not a function"), false)).toBe(
      "rethrow"
    );
  });
});
