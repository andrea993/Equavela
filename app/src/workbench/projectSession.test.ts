// the tabs of a project's last session.
import { afterEach, expect, it } from "vitest";
import { loadProjectSession, relativeTo, saveProjectSession } from "./projectSession";

afterEach(() => localStorage.clear());

it("saves and restores a project's tabs, keyed by its root as the file system compares it", () => {
  saveProjectSession("C:\\Work\\Beam\\", { sheets: ["worksheets/a.eqv"], files: [{ path: "julia/src/B.jl", kind: "text" }], active: "julia/src/B.jl" });
  expect(loadProjectSession("c:/work/beam")).toEqual({ sheets: ["worksheets/a.eqv"], files: [{ path: "julia/src/B.jl", kind: "text" }], active: "julia/src/B.jl" });
  expect(loadProjectSession("/other")).toBeNull();
});

it("reads a damaged entry as what it can and a path inside the root as relative", () => {
  localStorage.setItem("equavela.projectSession:/p", JSON.stringify({ sheets: ["a.eqv", 3], files: [{ path: "x", kind: "zip" }], active: 1 }));
  expect(loadProjectSession("/p")).toEqual({ sheets: ["a.eqv"], files: [], active: null });
  localStorage.setItem("equavela.projectSession:/q", "{not json");
  expect(loadProjectSession("/q")).toBeNull();
  expect(relativeTo("/p", "/p/worksheets/a.eqv")).toBe("worksheets/a.eqv");
  expect(relativeTo("C:/P", "c:\\p\\a.eqv")).toBe("a.eqv");
  expect(relativeTo("/p", "/elsewhere/a.eqv")).toBeNull();
});
