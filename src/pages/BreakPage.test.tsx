import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BreakPage } from "./BreakPage";
import { createMockBackend, defaultBootstrap, type MockBackend } from "../test/mockIpc";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { TimerSnapshot } from "../types/timer";

let backend: MockBackend;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => backend.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => backend.listen(...args),
}));

async function renderBreak(snapshot: TimerSnapshot, quote: string | null = null) {
  backend = createMockBackend({ ...defaultBootstrap, snapshot });
  backend.setQuote(quote);
  render(<BreakPage />);
  await waitFor(() => expect(backend.calls.map(([name]) => name)).toContain("get_break_view"));
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

    act(() => backend.emit({ state: "BREAK_ACTIVE", breakEndsAt: Date.now() + 5_000 }));

    await waitFor(() => expect(screen.getByRole("timer")).toHaveTextContent(/^00:0[45]$/));
  });

  it("shows a placeholder rather than a wrong time if the snapshot is unusable", async () => {
    await renderBreak({ state: "BREAK_ACTIVE" });

    expect(screen.getByRole("timer")).toHaveTextContent("--:--");
  });

  it("still renders the message if the backend cannot be reached", async () => {
    backend = createMockBackend({ ...defaultBootstrap, snapshot: activeBreak() });
    backend.failCommand("get_break_view", "backend unavailable");
    render(<BreakPage />);

    expect(await screen.findByRole("heading", { name: /take a break/i })).toBeInTheDocument();
  });

  it("shows the default heading when no quotes are configured", async () => {
    await renderBreak(activeBreak(), null);

    expect(screen.getByRole("heading", { name: /take a break/i })).toBeInTheDocument();
  });

  it("shows the quote in place of the heading when one is configured", async () => {
    const quote = "The eyes are the first to tire.";
    await renderBreak(activeBreak(), quote);

    expect(await screen.findByRole("heading", { name: quote })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /take a break/i })).not.toBeInTheDocument();
    // The instruction and countdown are still the point of the screen.
    expect(screen.getByText(/look away from your screen/i)).toBeInTheDocument();
    expect(screen.getByRole("timer")).toBeInTheDocument();
  });

  it("still offers no way out when a quote is shown", async () => {
    await renderBreak(activeBreak(), "Rest.");

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/press esc to end this break early/i)).toBeInTheDocument();
  });

  it("applies the configured theme to the break screen", async () => {
    backend = createMockBackend({
      ...defaultBootstrap,
      settings: { ...DEFAULT_SETTINGS, breakBackgroundColor: "#f5f0e0", fontChoice: "serif" },
      snapshot: activeBreak(),
    });
    render(<BreakPage />);
    await waitFor(() =>
      expect(backend.calls.map(([name]) => name)).toContain("get_break_view"),
    );

    const root = screen.getByRole("timer").closest("main")!;
    await waitFor(() => expect(root.style.getPropertyValue("--break-bg")).toBe("#f5f0e0"));
    // Light background, so the derived text colour must be the dark one.
    expect(root.style.getPropertyValue("--break-fg")).toBe("#101014");
    expect(root.style.getPropertyValue("--break-font")).toMatch(/Georgia/);
  });
});
