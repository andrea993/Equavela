import { expect, it } from "vitest";
import { unavailableImageCount } from "./projectResources";

it("counts unavailable image regions once and excludes other diagnostics and documents", () => {
  const root = "/project/main.eqv";
  const diagnostic = (region_id: string, document = root) => ({ region_id, document, message: "unavailable" });
  expect(unavailableImageCount(root, [
    { id: "a", kind: "image" }, { id: "b", kind: "image" }, { id: "math", kind: "math" },
  ], [diagnostic("a"), diagnostic("a"), diagnostic("b"), diagnostic("math"), diagnostic(""), diagnostic("a", "/project/other.eqv")])).toBe(2);
  expect(unavailableImageCount(root, [], [diagnostic("a")])).toBe(0);
});

it("matches native Windows document paths without treating Unix paths as case insensitive", () => {
  const regions = [{ id: "image", kind: "image" }];
  expect(unavailableImageCount("C:\\Project\\Main.eqv", regions, [{ document: "c:/project/main.eqv", region_id: "image", message: "missing" }])).toBe(1);
  expect(unavailableImageCount("/Project/Main.eqv", regions, [{ document: "/project/main.eqv", region_id: "image", message: "missing" }])).toBe(0);
});
