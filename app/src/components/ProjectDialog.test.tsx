// the specification : Browse… and the proposed folder of the project dialogs.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectDialog } from "./ProjectDialog";

afterEach(cleanup);

const field = () => screen.getByLabelText(/directory/) as HTMLInputElement;

it("proposes the worksheet's folder for Convert, following the name until the path is typed", () => {
  render(<ProjectDialog mode="convert" initialName="sizing" initialParent="/work/calcs" onSubmit={vi.fn()} onClose={vi.fn()} />);
  expect(field().value).toBe("/work/calcs/sizing");
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Beam" } });
  expect(field().value).toBe("/work/calcs/Beam");
  fireEvent.change(field(), { target: { value: "/elsewhere/x" } });
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Other" } });
  expect(field().value).toBe("/elsewhere/x");
});

it("keeps Windows separators", () => {
  render(<ProjectDialog mode="convert" initialName="sizing" initialParent={"C:\\work\\calcs"} onSubmit={vi.fn()} onClose={vi.fn()} />);
  expect(field().value).toBe("C:\\work\\calcs\\sizing");
});

it("Browse chooses the parent for New and the project folder for Open; cancelling changes nothing", async () => {
  const chooseFolder = vi.fn(async () => "/work/chosen");
  const { unmount } = render(<ProjectDialog mode="new" chooseFolder={chooseFolder} onSubmit={vi.fn()} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Beam" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Browse…" })));
  expect(chooseFolder).toHaveBeenCalledWith("Choose the folder to create the project in", undefined);
  expect(field().value).toBe("/work/chosen/Beam");
  unmount();
});

it("submits the proposed path", async () => {
  const onSubmit = vi.fn(async () => undefined);
  render(<ProjectDialog mode="convert" initialName="sizing" initialParent="/work/calcs" onSubmit={onSubmit} onClose={vi.fn()} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  expect(onSubmit).toHaveBeenCalledWith("/work/calcs/sizing", "sizing");
});
