import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Modal from "./Modal";

function open(props: Partial<Parameters<typeof Modal>[0]> = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <Modal title="Report.pdf" onClose={onClose} {...props}>
      {props.children ?? <p>Body content</p>}
    </Modal>
  );
  return { onClose, dialog: screen.getByRole("dialog") };
}

/** `<Modal>` renders inline, so the backdrop is the dialog's parent. */
function backdrop() {
  return screen.getByRole("dialog").parentElement as HTMLElement;
}

describe("Modal", () => {
  it("renders the title and children", () => {
    open();
    expect(screen.getByText("Report.pdf")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("exposes a labelled modal dialog", () => {
    const { dialog } = open();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("dialog", { name: "Report.pdf" })).toBe(dialog);
  });

  it("renders header actions before the close button", () => {
    open({ actions: <button>Open / download</button> });
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Open / download",
      "Close",
    ]);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.keyboard("{Enter}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on a backdrop click", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the click is inside the modal", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.click(screen.getByText("Body content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes from the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = open();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("removes its key listener on unmount", async () => {
    const user = userEvent.setup();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onClose = vi.fn();
    const { unmount } = render(
      <Modal title="Report.pdf" onClose={onClose}>
        <p>Body content</p>
      </Modal>
    );

    const registered = add.mock.calls.filter(([type]) => type === "keydown");
    expect(registered).toHaveLength(1);

    unmount();
    expect(
      remove.mock.calls.filter(
        ([type, fn]) => type === "keydown" && fn === registered[0][1]
      )
    ).toHaveLength(1);

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();

    add.mockRestore();
    remove.mockRestore();
  });

  it("takes focus on open and gives it back on close", () => {
    function Shell({ open: isOpen }: { open: boolean }) {
      return (
        <>
          <button>Outside</button>
          {isOpen && (
            <Modal title="Report.pdf" onClose={() => {}}>
              <p>Body content</p>
            </Modal>
          )}
        </>
      );
    }

    const { rerender } = render(<Shell open={false} />);
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();

    rerender(<Shell open />);
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    rerender(<Shell open={false} />);
    expect(document.activeElement).toBe(outside);
  });

  it("traps Tab inside the dialog", () => {
    render(
      <Modal
        title="Report.pdf"
        onClose={() => {}}
        actions={<button>Open / download</button>}
      >
        <button>In body</button>
      </Modal>
    );
    const first = screen.getByRole("button", { name: "Open / download" });
    const last = screen.getByRole("button", { name: "In body" });

    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);

    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("leaves ordinary Tab presses alone in the middle of the dialog", () => {
    render(
      <Modal title="Report.pdf" onClose={() => {}}>
        <button>In body</button>
      </Modal>
    );
    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    // Close is not the last focusable here, so the browser handles it.
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(close);
  });
});
