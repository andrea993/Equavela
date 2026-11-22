import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBar } from "./MessageBar";
import type { MessageLevel } from "../workbench/useWorkbench";

afterEach(cleanup);

describe("MessageBar", () => {
  const cases: [MessageLevel, string, string][] = [
    ["success", "status", "✓"],
    ["info", "status", "i"],
    ["warning", "alert", "!"],
    ["error", "alert", "✕"],
  ];
  it.each(cases)("a %s message has its own class, its role %s and the symbol %s", (level, role, mark) => {
    const { container } = render(<MessageBar text="Something happened" level={level} onDismiss={() => {}} />);
    const bar = screen.getByRole(role);
    expect(bar.className).toContain(`message-${level}`);
    expect(bar.getAttribute("data-level")).toBe(level);
    expect(bar.textContent).toContain("Something happened");
    expect(container.querySelector(".message-mark")?.textContent).toBe(mark);
    expect(container.querySelector(".message-mark")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the dismiss button calls back", () => {
    const onDismiss = vi.fn();
    render(<MessageBar text="PDF saved: /m/a.pdf" level="success" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
