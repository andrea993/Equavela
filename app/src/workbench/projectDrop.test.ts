import { afterEach, expect, it } from "vitest";
import { projectDropFolder } from "./projectDrop";

afterEach(() => { document.body.innerHTML = ""; });

it("routes a folder row to itself and a file row beside itself", () => {
  document.body.innerHTML = `<nav class="project-tree"><div role="treeitem" data-path="worksheets" aria-expanded="true"><span id="folder-child">folder</span></div><div role="treeitem" data-path="worksheets/main.eqv"><span id="file-child">file</span></div></nav>`;
  expect(projectDropFolder(document.querySelector("#folder-child"))).toBe("worksheets");
  expect(projectDropFolder(document.querySelector("#file-child"))).toBe("worksheets");
});

it("routes explorer root surfaces and the collapsed rail to the root, outside targets away", () => {
  document.body.innerHTML = `<div class="project-explorer-frame"><div class="project-tree"><header id="header"></header><div id="empty"></div></div><button id="rail"></button><button class="project-explorer-backdrop"></button></div><main id="outside"></main>`;
  expect(projectDropFolder(document.querySelector("#header"))).toBe("");
  expect(projectDropFolder(document.querySelector("#empty"))).toBe("");
  expect(projectDropFolder(document.querySelector("#rail"))).toBe("");
  expect(projectDropFolder(document.querySelector("#outside"))).toBeNull();
  expect(projectDropFolder(document.querySelector(".project-explorer-backdrop"))).toBeNull();
  expect(projectDropFolder(null)).toBeNull();
});
