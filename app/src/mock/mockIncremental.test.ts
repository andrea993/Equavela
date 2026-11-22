import { expect, it } from "vitest";
import type { WorksheetEvent } from "../equavelaApi";
import { createMockBackend } from "./mockBackend";

// The mock recalculates like the real session: an edit leaves out of date only what it
// changed and what comes after a changed definition, so the preview does not run the whole sheet again.

async function calculated() {
  const backend = createMockBackend({ fast: true });
  const opened = await backend.openWorksheet("/demo/demo.eqv");
  let finished: () => void = () => undefined;
  await backend.onWorksheetEvent((event: WorksheetEvent) => {
    if (event.event === "pass_finished") finished();
  });
  const pass = async () => {
    const done = new Promise<void>((resolve) => { finished = resolve; });
    await backend.recalculate(opened.id, false);
    await done;
  };
  await pass();
  return { backend, id: opened.id, view: opened.view, pass };
}

const name = (text: string) => ({ type: "Name", name: text });

it("calculates only a new expression that defines nothing", async () => {
  const { backend, id } = await calculated();
  const result = await backend.addMathRegion(id, 1, 400, 700, {
    type: "ExprRegion",
    expr: { type: "Binary", op: "Add", left: name("a"), right: name("b") },
  });
  const outOfDate = result.regions.filter((entry) => entry.state !== "value" && entry.state !== "error");
  expect(outOfDate.map((entry) => entry.key.region_id)).toEqual([result.created]);
});

it("makes everything after a changed definition out of date", async () => {
  const { backend, id, view } = await calculated();
  const math = view.regions.filter((region) => region.kind === "math").sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const first = math[0];
  if (first.kind !== "math") throw new Error("no math");
  const result = await backend.setMath(id, first.id, { type: "Define", target: name("q"), expr: { type: "Num", text: "7" } });
  const fresh = result.regions.filter((entry) => entry.state === "value").map((entry) => entry.key.region_id);
  expect(fresh).toEqual([]);
});
