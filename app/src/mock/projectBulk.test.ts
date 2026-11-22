import { expect, it } from "vitest";
import { createMockBackend } from "./mockBackend";

async function project() {
  const backend = createMockBackend({ fast: true });
  const opened = await backend.newProject(
    "/work/bulk-project",
    "Bulk project",
    "bulk-project-id",
    "bulk-sheet-id",
  );
  return { backend, root: opened.root };
}

it("moves a selection atomically and compacts a selected folder plus its child", async () => {
  const { backend, root } = await project();
  await backend.projectCreate(root, "", "source", "folder");
  await backend.projectCreate(root, "", "destination", "folder");
  await backend.projectCreate(root, "source", "nested", "folder");

  const moved = await backend.projectMoveMany(root, ["source", "source/nested"], "destination");
  expect(moved.entries.some((entry) => entry.path === "destination/source/nested" && entry.kind === "folder")).toBe(true);
  expect(moved.entries.some((entry) => entry.path === "source")).toBe(false);
});

it("rejects a batch move collision without moving any item", async () => {
  const { backend, root } = await project();
  await backend.projectCreate(root, "", "left", "folder");
  await backend.projectCreate(root, "", "right", "folder");
  await backend.projectCreate(root, "", "destination", "folder");
  await backend.projectImport(root, "left", ["/tmp/shared.txt"]);
  await backend.projectImport(root, "right", ["/tmp/shared.txt"]);

  await expect(backend.projectMoveMany(root, ["left/shared.txt", "right/shared.txt"], "destination"))
    .rejects.toMatchObject({ message: expect.stringContaining("already exists") });
  const tree = await backend.projectTree(root);
  expect(tree.entries.some((entry) => entry.path === "left/shared.txt")).toBe(true);
  expect(tree.entries.some((entry) => entry.path === "right/shared.txt")).toBe(true);
  expect(tree.entries.some((entry) => entry.path === "destination/shared.txt")).toBe(false);
});

it("rewrites seeded asset paths and worksheet owners together in one move", async () => {
  const { backend, root } = await project();
  await backend.projectCreate(root, "", "archive", "folder");
  backend.addProjectAsset(root, "shared.png");
  backend.seedProjectImageUsage(root, [{ path: "assets/images/shared.png", worksheets: ["worksheets/main.eqv"], problem: null }]);

  await backend.projectMoveMany(root, ["assets/images/shared.png", "worksheets"], "archive");
  const usage = await backend.projectImageUsage(root);
  expect(usage).toEqual([{ path: "archive/shared.png", worksheets: ["archive/worksheets/main.eqv"], problem: null }]);
});

it("preflights last-worksheet and shared-asset rules before deleting any selection", async () => {
  const { backend, root } = await project();
  await backend.projectImport(root, "", ["/tmp/notes.txt"]);
  await expect(backend.projectDeleteMany(root, ["worksheets/main.eqv", "notes.txt"]))
    .rejects.toMatchObject({ message: expect.stringContaining("last one") });
  expect((await backend.projectTree(root)).entries.some((entry) => entry.path === "notes.txt")).toBe(true);

  backend.addProjectAsset(root, "shared.png");
  backend.seedProjectImageUsage(root, [{ path: "assets/images/shared.png", worksheets: ["worksheets/main.eqv"], problem: null }]);
  await expect(backend.projectDeleteMany(root, ["assets/images/shared.png", "notes.txt"]))
    .rejects.toMatchObject({ message: expect.stringContaining("references asset") });
  const tree = await backend.projectTree(root);
  expect(tree.entries.some((entry) => entry.path === "assets/images/shared.png")).toBe(true);
  expect(tree.entries.some((entry) => entry.path === "notes.txt")).toBe(true);
});
