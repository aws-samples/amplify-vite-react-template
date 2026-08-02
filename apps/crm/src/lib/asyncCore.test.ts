import { describe, expect, it, vi } from "vitest";
import {
  createRequestGuard,
  createSingleFlight,
  runGuarded,
  toMessage,
  type AsyncSink,
} from "./asyncCore";

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing here rejects unobserved; the tests always await through runGuarded.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

const sink = <T,>(): AsyncSink<T> & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    data: (v) => calls.push(`data:${JSON.stringify(v)}`),
    error: (m) => calls.push(`error:${m}`),
    settled: () => calls.push("settled"),
  };
};

describe("toMessage", () => {
  it("prefers a real Error message", () => {
    expect(toMessage(new Error("card declined"), "nope")).toBe("card declined");
  });

  it("accepts a thrown string", () => {
    expect(toMessage("card declined", "nope")).toBe("card declined");
  });

  it.each([new Error("   "), "", "  ", null, undefined, 42, {}, []])(
    "falls back for %p rather than rendering [object Object]",
    (thrown) => {
      expect(toMessage(thrown, "Could not save")).toBe("Could not save");
    }
  );
});

describe("createRequestGuard", () => {
  it("holds for a single request", () => {
    const guard = createRequestGuard();
    expect(guard.begin()()).toBe(true);
  });

  it("invalidates an earlier request when a newer one starts", () => {
    const guard = createRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("invalidates everything once disposed", () => {
    const guard = createRequestGuard();
    const only = guard.begin();
    guard.dispose();
    expect(only()).toBe(false);
  });

  it("stays disposed for requests begun afterwards", () => {
    const guard = createRequestGuard();
    guard.dispose();
    expect(guard.begin()()).toBe(false);
  });
});

describe("runGuarded", () => {
  it("reports data then settles", async () => {
    const s = sink<string>();
    await runGuarded(async () => "rows", () => true, s, "Could not load");
    expect(s.calls).toEqual(['data:"rows"', "settled"]);
  });

  it("reports a failure as a message, then settles", async () => {
    const s = sink<string>();
    await runGuarded(
      async () => {
        throw new Error("throttled");
      },
      () => true,
      s,
      "Could not load"
    );
    expect(s.calls).toEqual(["error:throttled", "settled"]);
  });

  it("uses the fallback when the failure carries no message", async () => {
    const s = sink<string>();
    await runGuarded(
      async () => {
        throw {};
      },
      () => true,
      s,
      "Could not load leads"
    );
    expect(s.calls).toEqual(["error:Could not load leads", "settled"]);
  });

  it("never rejects, so a caller cannot get an unhandled rejection", async () => {
    await expect(
      runGuarded(
        async () => {
          throw new Error("boom");
        },
        () => true,
        sink<string>(),
        "fallback"
      )
    ).resolves.toBeUndefined();
  });

  it("stays silent entirely when the run is stale", async () => {
    const s = sink<string>();
    await runGuarded(async () => "rows", () => false, s, "Could not load");
    expect(s.calls).toEqual([]);
  });

  it("swallows a stale FAILURE too — no error against current data", async () => {
    const s = sink<string>();
    await runGuarded(
      async () => {
        throw new Error("old tab failed");
      },
      () => false,
      s,
      "Could not load"
    );
    expect(s.calls).toEqual([]);
  });

  // The defect the guard exists for: only 1 of ~25 list screens had it.
  it("lets the NEWER response win when an older one lands last", async () => {
    const guard = createRequestGuard();
    const s = sink<string>();
    const older = deferred<string>();
    const newer = deferred<string>();

    const isFirst = guard.begin();
    const runFirst = runGuarded(() => older.promise, isFirst, s, "Could not load");
    const isSecond = guard.begin();
    const runSecond = runGuarded(() => newer.promise, isSecond, s, "Could not load");

    newer.resolve("NEW tab rows");
    await runSecond;
    older.resolve("OLD tab rows");
    await runFirst;

    expect(s.calls).toEqual(['data:"NEW tab rows"', "settled"]);
  });
});

describe("createSingleFlight", () => {
  it("admits one caller and refuses the rest", () => {
    const gate = createSingleFlight();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.tryEnter()).toBe(false);
    expect(gate.tryEnter()).toBe(false);
  });

  it("re-admits after exit", () => {
    const gate = createSingleFlight();
    gate.tryEnter();
    gate.exit();
    expect(gate.tryEnter()).toBe(true);
  });

  it("reports busy while a run holds it", () => {
    const gate = createSingleFlight();
    expect(gate.busy).toBe(false);
    gate.tryEnter();
    expect(gate.busy).toBe(true);
    gate.exit();
    expect(gate.busy).toBe(false);
  });

  it("a double-submit runs the action exactly once", async () => {
    const gate = createSingleFlight();
    const action = vi.fn(async () => {});
    const submit = async () => {
      if (!gate.tryEnter()) return false;
      try {
        await action();
        return true;
      } finally {
        gate.exit();
      }
    };
    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first, second]).toEqual([true, false]);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
