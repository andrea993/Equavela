import { expect, it } from "vitest";
import type { EnvironmentSummary } from "../equavelaApi";
import { replProjectOf } from "./replTarget";

const env = (kind: EnvironmentSummary["kind"]): { environment: EnvironmentSummary } => ({
  environment: { kind, directory: "/d", absolute: false, kernel: "/d" },
});

it("follows the worksheet in front between the project and the generic REPL", () => {
  expect(replProjectOf("/p", env("project"))).toBe("/p");
  expect(replProjectOf("/p", env("shared"))).toBeNull();
  expect(replProjectOf(null, env("shared"))).toBeNull();
});

it("uses the project's REPL with no worksheet in front", () => {
  expect(replProjectOf("/p", null)).toBe("/p");
  expect(replProjectOf(null, null)).toBeNull();
});
