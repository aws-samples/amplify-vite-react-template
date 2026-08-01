import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ConfirmButton from "./ConfirmButton";

/** A promise the test resolves or rejects by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const trigger = () => screen.getByRole("button", { name: "Delete" });
const confirm = () => screen.getByRole("button", { name: "Confirm" });
const cancel = () => screen.getByRole("button", { name: "Cancel" });

describe("ConfirmButton", () => {
  it("shows only the trigger before it is armed", () => {
    render(<ConfirmButton onConfirm={vi.fn()} />);
    expect(trigger()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("arms on the first click without running the action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmButton onConfirm={onConfirm} />);

    await user.click(trigger());

    expect(confirm()).toBeInTheDocument();
    expect(cancel()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("runs the action once on confirm, then disarms", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmButton onConfirm={onConfirm} />);

    await user.click(trigger());
    await user.click(confirm());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(trigger()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("disarms on cancel without running the action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmButton onConfirm={onConfirm} />);

    await user.click(trigger());
    await user.click(cancel());

    expect(trigger()).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("moves focus to cancel when armed", async () => {
    const user = userEvent.setup();
    render(<ConfirmButton onConfirm={vi.fn()} />);

    await user.click(trigger());

    expect(document.activeElement).toBe(cancel());
    expect(screen.getByRole("group")).toHaveAccessibleName("Delete");
  });

  it("goes busy while the action is in flight and blocks a second click", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const onConfirm = vi.fn(() => gate.promise);
    render(<ConfirmButton onConfirm={onConfirm} />);

    await user.click(trigger());
    await user.click(confirm());

    const busy = screen.getByRole("button", { name: "Deleting…" });
    expect(busy).toBeDisabled();
    expect(cancel()).toBeDisabled();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(trigger()).toBeInTheDocument();
  });

  it("stays armed but not busy when the action rejects", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const boom = new Error("delete failed");
    const onError = vi.fn();
    render(
      <ConfirmButton onConfirm={() => gate.promise} onError={onError} />
    );

    await user.click(trigger());
    await user.click(confirm());
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();

    await act(async () => {
      gate.reject(boom);
      await gate.promise.catch(() => {});
    });

    expect(screen.queryByRole("button", { name: "Deleting…" })).toBeNull();
    expect(confirm()).toBeEnabled();
    expect(cancel()).toBeEnabled();
    expect(onError).toHaveBeenCalledWith(boom);

    // and it can be retried or backed out of
    await user.click(cancel());
    expect(trigger()).toBeInTheDocument();
  });

  it("honours overridden labels and a message", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmButton
        onConfirm={vi.fn()}
        label="Remove"
        confirmLabel="Confirm delete"
        cancelLabel="Keep"
        message="This can't be undone."
      />
    );

    await user.click(screen.getByRole("button", { name: "Remove" }));

    const confirmBtn = screen.getByRole("button", { name: "Confirm delete" });
    expect(confirmBtn).toHaveAccessibleDescription("This can't be undone.");
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("cannot be armed while disabled", async () => {
    const user = userEvent.setup();
    render(<ConfirmButton onConfirm={vi.fn()} disabled />);

    expect(trigger()).toBeDisabled();
    await user.click(trigger());
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });
});
