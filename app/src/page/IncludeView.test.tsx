import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncludeView } from "./IncludeView";

afterEach(cleanup);

const field = () => screen.getByLabelText("Include path") as HTMLInputElement;

describe("IncludeView", () => {
  it("draws the label and the path, and the tools are screen-only", () => {
    const { container } = render(<IncludeView path="libs/helpers.eqv" missing={false} />);
    expect(container.textContent).toContain("Include");
    expect(screen.getByTestId("include-path").textContent).toBe("libs/helpers.eqv");
    expect(container.querySelector(".include-tools")?.className).toContain("no-print");
  });

  it("a double-click on the path edits it, Enter commits the typed text", () => {
    const onPath = vi.fn();
    render(<IncludeView path="old.eqv" missing={false} onPath={onPath} />);
    fireEvent.doubleClick(screen.getByTestId("include-path"));
    expect(field().value).toBe("old.eqv");
    fireEvent.change(field(), { target: { value: "  libs\\new.eqv " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPath).toHaveBeenCalledTimes(1);
    expect(onPath).toHaveBeenCalledWith("libs\\new.eqv");
    expect(screen.queryByLabelText("Include path")).toBeNull();
  });

  it("the pencil button is the keyboard way in, and leaving the field commits", () => {
    const onPath = vi.fn();
    render(<IncludeView path="old.eqv" missing={false} onPath={onPath} />);
    fireEvent.click(screen.getByTestId("include-edit"));
    fireEvent.change(field(), { target: { value: "other.eqv" } });
    fireEvent.blur(field());
    expect(onPath).toHaveBeenCalledWith("other.eqv");
  });

  it("Escape cancels, an unchanged or empty text commits nothing", () => {
    const onPath = vi.fn();
    render(<IncludeView path="old.eqv" missing={false} onPath={onPath} />);
    fireEvent.doubleClick(screen.getByTestId("include-path"));
    fireEvent.change(field(), { target: { value: "typed.eqv" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onPath).not.toHaveBeenCalled();
    expect(screen.getByTestId("include-path").textContent).toBe("old.eqv");
    fireEvent.doubleClick(screen.getByTestId("include-path"));
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.doubleClick(screen.getByTestId("include-path"));
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onPath).not.toHaveBeenCalled();
  });

  it("Browse… asks the host to choose a file, and the warning mark shows for a missing file", () => {
    const onBrowse = vi.fn();
    const { container } = render(<IncludeView path="gone.eqv" missing onBrowse={onBrowse} />);
    fireEvent.click(screen.getByTestId("include-browse"));
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".warning-mark")).not.toBeNull();
    expect(container.querySelector(".include-region")?.className).toContain("missing");
  });
});
