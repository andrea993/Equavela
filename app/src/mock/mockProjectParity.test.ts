// The browser preview's project operations behave as the service's do, so a preview
// session can be trusted when auditing project workflows.
import { describe, expect, it } from "vitest";
import { createMockBackend } from "./mockBackend";

const ID = "11111111-1111-4111-8111-111111111111";

describe("mock project parity", () => {
  it("runs every worksheet of a project in the project's environment", async () => {
    const backend = createMockBackend({ fast: true });
    const project = await backend.newProject("/work/p", "P", ID, ID);
    const change = await backend.projectCreate(project.root, "worksheets", "second.eqv", "worksheet");
    const second = change.opened!;
    expect((await backend.environmentInfo(second.id)).kind).toBe("project");
  });

  it("keeps a renamed .jl file's text, version and Load in worksheets", async () => {
    const backend = createMockBackend({ fast: true });
    const project = await backend.newProject("/work/p", "P", ID, ID);
    await backend.projectCreate(project.root, "julia", "helpers.jl", "julia");
    const read = await backend.projectReadText(project.root, "julia/helpers.jl");
    const saved = await backend.projectWriteText(project.root, "julia/helpers.jl", "f(x) = 2x\n", read.version);
    await backend.projectSetJuliaModule(project.root, "julia/helpers.jl", true);
    const renamed = await backend.projectRename(project.root, "julia/helpers.jl", "renamed.jl");
    expect(renamed.manifest.julia_modules).toEqual(["julia/renamed.jl"]);
    const after = await backend.projectReadText(project.root, "julia/renamed.jl");
    expect(after).toEqual({ text: "f(x) = 2x\n", version: saved.version });
    const moved = await backend.projectMove(project.root, "julia/renamed.jl", "worksheets");
    expect(moved.manifest.julia_modules).toEqual(["worksheets/renamed.jl"]);
    expect((await backend.projectReadText(project.root, "worksheets/renamed.jl")).text).toBe("f(x) = 2x\n");
  });

  it("keeps a worksheet's content when it becomes a project", async () => {
    const backend = createMockBackend({ fast: true });
    const sheet = await backend.newWorksheet();
    await backend.addRegion(sheet.id, "math", 1, 72, 72, "a := 1");
    const project = await backend.convertToProject(sheet.id, "/work/c", "C", ID, ID);
    expect(project.worksheet?.view.regions.map((region) => region.kind)).toEqual(["math"]);
  });
});
