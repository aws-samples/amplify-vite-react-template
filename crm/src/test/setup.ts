// Vitest setup, loaded once per test file (see `test.setupFiles` in vite.config.ts).
//
// - Registers the jest-dom matchers (toBeInTheDocument, toHaveTextContent, ...)
//   on Vitest's `expect`, including their TypeScript augmentation.
// - Unmounts anything React Testing Library rendered, so tests stay isolated.
//   We do this explicitly because `globals` is off, and RTL's automatic cleanup
//   only registers itself when a global `afterEach` exists.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
