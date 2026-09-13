import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "./SettingsPage";
import { createMockBackend, defaultBootstrap, type MockBackend } from "../test/mockIpc";
import type { Bootstrap } from "../types/timer";

let backend: MockBackend;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => backend.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => backend.listen(...args),
}));

async function renderPage(bootstrap: Bootstrap = defaultBootstrap) {
  backend = createMockBackend(bootstrap);
  render(<SettingsPage />);
  // Wait out the bootstrap round trip so tests never assert on the loading frame.
  await waitFor(() => expect(screen.getByRole("heading")).toBeInTheDocument());
  return backend;
}

/** Names of the commands invoked so far, ignoring their arguments. */
const commandNames = () => backend.calls.map(([name]) => name);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("first run", () => {
  it("offers a single Start button with the default schedule and no setup steps", async () => {
    await renderPage({ ...defaultBootstrap, isFirstRun: true, snapshot: { state: "STOPPED" } });

    expect(screen.getByText("Take regular breaks to rest your eyes.")).toBeInTheDocument();
    expect(screen.getByText(/Every 1 hour/)).toBeInTheDocument();
    expect(screen.getByText(/for 1 minute/)).toBeInTheDocument();

    // Nothing resembling a signup, tutorial or permission prompt.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("persists settings before starting, so the welcome view does not return", async () => {
    await renderPage({ ...defaultBootstrap, isFirstRun: true, snapshot: { state: "STOPPED" } });

    await userEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(commandNames()).toContain("timer_start"));
    // The settings write is what creates the file the backend uses to detect
    // a first run, so it has to happen and has to come first.
    expect(commandNames().indexOf("update_settings")).toBeLessThan(
      commandNames().indexOf("timer_start"),
    );
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
  });
});

describe("configuring durations", () => {
  it("saves a preset interval as seconds", async () => {
    await renderPage();

    await userEvent.click(screen.getByRole("radio", { name: "30m" }));

    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("update_settings", {
        settings: expect.objectContaining({ intervalSeconds: 1800 }),
      }),
    );
  });

  it("saves a preset break duration as seconds", async () => {
    await renderPage();

    await userEvent.click(screen.getByRole("radio", { name: "30s" }));

    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("update_settings", {
        settings: expect.objectContaining({ breakDurationSeconds: 30 }),
      }),
    );
  });

  it("marks the stored preset as selected", async () => {
    await renderPage({
      ...defaultBootstrap,
      settings: { enabled: true, intervalSeconds: 2700, breakDurationSeconds: 15 },
    });

    expect(screen.getByRole("radio", { name: "45m" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "15s" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "60m" })).not.toBeChecked();
  });

  it("opens a custom field prefilled with the current value", async () => {
    await renderPage();

    const [intervalCustom] = screen.getAllByRole("radio", { name: "Custom" });
    await userEvent.click(intervalCustom);

    const field = screen.getByLabelText("Custom (minutes)");
    expect(field).toHaveValue("60");
  });

  it("shows an inline error and saves nothing for an invalid custom value", async () => {
    await renderPage();
    const callsBefore = commandNames().length;

    const [intervalCustom] = screen.getAllByRole("radio", { name: "Custom" });
    await userEvent.click(intervalCustom);
    const field = screen.getByLabelText("Custom (minutes)");
    await userEvent.clear(field);
    await userEvent.type(field, "0");

    expect(await screen.findByRole("alert")).toHaveTextContent(/minimum is 1 minute/i);
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(commandNames()).toHaveLength(callsBefore);
  });

  it("saves a valid custom value and clears the error", async () => {
    await renderPage();

    const [intervalCustom] = screen.getAllByRole("radio", { name: "Custom" });
    await userEvent.click(intervalCustom);
    const field = screen.getByLabelText("Custom (minutes)");
    await userEvent.clear(field);
    await userEvent.type(field, "25");

    await waitFor(() =>
      expect(backend.invoke).toHaveBeenCalledWith("update_settings", {
        settings: expect.objectContaining({ intervalSeconds: 1500 }),
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reopens the custom field when the stored value is not a preset", async () => {
    await renderPage({
      ...defaultBootstrap,
      settings: { enabled: true, intervalSeconds: 1500, breakDurationSeconds: 45 },
    });

    expect(screen.getByLabelText("Custom (minutes)")).toHaveValue("25");
    expect(screen.getByLabelText("Custom (seconds)")).toHaveValue("45");
  });
});

describe("reminders toggle", () => {
  it("reflects the persisted state in words as well as visually", async () => {
    await renderPage();
    expect(screen.getByRole("switch", { name: /break reminders/i })).toBeChecked();
    expect(screen.getByText("On")).toBeInTheDocument();
  });

  it("turning reminders off stops the timer", async () => {
    await renderPage();

    await userEvent.click(screen.getByRole("switch", { name: /break reminders/i }));

    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith("set_enabled", { enabled: false }));
    expect(await screen.findByText("Break reminders off")).toBeInTheDocument();
  });
});

describe("timer status", () => {
  it("shows a countdown against the backend's deadline", async () => {
    const now = Date.now();
    await renderPage({
      ...defaultBootstrap,
      snapshot: { state: "RUNNING", nextBreakAt: now + 1_663_000 },
    });

    expect(screen.getByText("Next break in")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/^27:4[23]$/);
  });

  it("reports a paused timer in words and hides the countdown", async () => {
    await renderPage({ ...defaultBootstrap, snapshot: { state: "PAUSED" } });

    expect(screen.getByText("Break reminders paused")).toBeInTheDocument();
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("reports an active break", async () => {
    await renderPage({
      ...defaultBootstrap,
      snapshot: { state: "BREAK_ACTIVE", breakEndsAt: Date.now() + 30_000 },
    });

    expect(screen.getByText("Break active")).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/^00:(30|29)$/);
  });

  it("follows a snapshot pushed by the backend, such as a break started from the tray", async () => {
    await renderPage();

    backend.emit({ state: "BREAK_ACTIVE", breakEndsAt: Date.now() + 30_000 });

    expect(await screen.findByText("Break active")).toBeInTheDocument();
  });
});

describe("controls", () => {
  it("offers Pause while running and Resume once paused", async () => {
    await renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(commandNames()).toContain("timer_pause"));
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();

    await userEvent.click(resume);
    await waitFor(() => expect(commandNames()).toContain("timer_resume"));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("starts a manual break on demand", async () => {
    await renderPage();

    await userEvent.click(screen.getByRole("button", { name: "Start Break Now" }));

    await waitFor(() => expect(commandNames()).toContain("timer_start_manual_break"));
    expect(await screen.findByText("Break active")).toBeInTheDocument();
  });

  it("disables Start Break Now while a break is already on screen", async () => {
    await renderPage({
      ...defaultBootstrap,
      snapshot: { state: "BREAK_ACTIVE", breakEndsAt: Date.now() + 30_000 },
    });

    expect(screen.getByRole("button", { name: "Start Break Now" })).toBeDisabled();
  });

  it("disables Pause when reminders are off", async () => {
    await renderPage({
      ...defaultBootstrap,
      settings: { ...defaultBootstrap.settings, enabled: false },
      snapshot: { state: "STOPPED" },
    });

    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
  });
});

describe("error handling", () => {
  it("surfaces a rejected command without losing the rest of the UI", async () => {
    await renderPage();
    backend.failCommand("timer_pause", "window management failed");

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("window management failed");
    // Still interactive; the failure did not wedge the page.
    expect(screen.getByRole("button", { name: "Start Break Now" })).toBeEnabled();
  });

  it("still renders when the bootstrap request fails", async () => {
    backend = createMockBackend(defaultBootstrap);
    backend.failCommand("get_bootstrap", "backend unavailable");
    render(<SettingsPage />);

    expect(await screen.findByRole("heading", { name: "Screen Break" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("backend unavailable");
  });
});
