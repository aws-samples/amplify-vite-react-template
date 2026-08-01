// Harness smoke test — jsdom + React Testing Library.
//
// This file exists to prove the DOM half of the harness works: rendering a
// component, asserting on the DOM with jest-dom matchers, driving a user
// interaction, and exercising a hook via renderHook. It has no production
// subject and should not grow; real tests live beside the module they cover
// (e.g. src/components/Modal.tsx -> src/components/Modal.test.tsx).
import { useState } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button onClick={() => setCount((c) => c + 1)}>
      {label}: {count}
    </button>
  );
}

function useCounter() {
  const [count, setCount] = useState(0);
  return { count, increment: () => setCount((c) => c + 1) };
}

describe("harness smoke: jsdom + React Testing Library", () => {
  it("renders a component and asserts on the DOM", () => {
    render(<Counter label="Clicks" />);
    expect(screen.getByRole("button")).toHaveTextContent("Clicks: 0");
  });

  it("handles a user interaction and re-renders", async () => {
    const user = userEvent.setup();
    render(<Counter label="Clicks" />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Clicks: 1");
  });

  it("exercises a hook in isolation", () => {
    const { result } = renderHook(() => useCounter());
    expect(result.current.count).toBe(0);
    act(() => result.current.increment());
    expect(result.current.count).toBe(1);
  });
});
