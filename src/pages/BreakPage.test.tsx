import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BreakPage } from "./BreakPage";
import { createMockBackend, defaultBootstrap, type MockBackend } from "../test/mockIpc";
import type { TimerSnapshot } from "../types/timer";

let backend: MockBackend;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => backend.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => backend.listen(...args),
}));

async function renderBreak(snapshot: TimerSnapshot) {
  backend = createMockBackend({ ...defaultBootstrap, snapshot });
  render(<BreakPage />);
  await waitFor(() => expect(backend.calls.map(([name]) => name)).toContain("get_snapshot"));
  return backend;
}

const activeBreak = (): TimerSnapshot => ({
  state: "BREAK_ACTIVE",
  breakEndsAt: Date.now() + 30_000,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("break screen", () => {
  it("shows the break message and a countdown", async () => {
    await renderBreak(activeBreak());

    expect(screen.getByRole("heading", { name: /take a break/i })).toBeInTheDocument();
    expect(
      screen.getByText(/look away from your screen and focus on something in the distance/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("timer")).toHaveTextContent(/^00:(30|29)$/));
  });

  it("offers no clickable way out, only the documented Esc hint", async () => {
    await renderBreak(activeBreak());

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText(/skip/i)).not.toBeInTheDocument();
    expect(screen.getByText(/press esc to end this break early/i)).toBeInTheDocument();
  });

  it("ends the break when Esc is pressed", async () => {
    await renderBreak(activeBreak());

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(backend.calls.map(([name]) => name)).toContain("timer_interrupt_break"),
    );
  });

  it("ignores other keys, so the break is not dismissed by accident", async () => {
    await renderBreak(activeBreak());

    await userEvent.keyboard("{Enter}{ }{a}{Backspace}{Tab}");

    expect(backend.calls.map(([name]) => name)).not.toContain("timer_interrupt_break");
  });

  it("follows the deadline pushed by the backend rather than its own clock", async () => {
    await renderBreak(activeBreak());

    backend.emit({ state: "BREAK_ACTIVE", breakEndsAt: Date.now() + 5_000 });

    await waitFor(() => expect(screen.getByRole("timer")).toHaveTextContent(/^00:0[45]$/));
  });

  it("shows a placeholder rather than a wrong time if the snapshot is unusable", async () => {
    await renderBreak({ state: "BREAK_ACTIVE" });

    expect(screen.getByRole("timer")).toHaveTextContent("--:--");
  });

  it("still renders the message if the backend cannot be reached", async () => {
    backend = createMockBackend({ ...defaultBootstrap, snapshot: activeBreak() });
    backend.failCommand("get_snapshot", "backend unavailable");
    render(<BreakPage />);

    expect(await screen.findByRole("heading", { name: /take a break/i })).toBeInTheDocument();
  });
});
