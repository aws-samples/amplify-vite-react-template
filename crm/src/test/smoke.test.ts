// Harness smoke test — pure functions.
//
// This file exists to prove the Vitest harness runs at all. It has no
// production subject and should not grow; real tests live beside the module
// they cover (e.g. src/lib/foo.ts -> src/lib/foo.test.ts).
import { describe, expect, it } from "vitest";

const double = (n: number): number => n * 2;

describe("harness smoke: pure function", () => {
  it("runs a synchronous assertion", () => {
    expect(double(21)).toBe(42);
  });

  it("runs an async assertion", async () => {
    await expect(Promise.resolve(double(2))).resolves.toBe(4);
  });
});
