import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listen(...args),
}));

import {
  applyWorksheetEvent,
  applyWorksheetEvents,
  describeState,
  EVENT_KERNEL_STATUS,
  EVENT_WORKSHEET,
  formatValue,
  keyId,
  onKernelStatus,
  onWorksheetEvent,
  equavelaApi,
  type KernelValue,
  type RegionEntry,
  type WorksheetEvent,
} from "./equavelaApi";

afterEach(() => {
  invoke.mockReset();
  listen.mockReset();
});

const key = (region_id: string) => ({
  document: "/a.eqv",
  region_id,
  instance: 0,
});

describe("commands", () => {
  it("passes explicit environment maintenance operations to Tauri", async () => {
    invoke.mockResolvedValue(undefined);
    for (const operation of ["instantiate", "resolve", "update"] as const) {
      await equavelaApi.manageEnvironment("worksheet-1", operation);
    }
    expect(invoke.mock.calls).toEqual(["instantiate", "resolve", "update"].map((operation) => [
      "manage_environment", { worksheet: "worksheet-1", operation },
    ]));
  });
  it("passes package compatibility bounds to Tauri", async () => {
    invoke.mockResolvedValue(undefined);
    await equavelaApi.setCompatibility("worksheet-1", "JSON3", "1.14");
    await equavelaApi.setCompatibility("worksheet-1", "JSON3", "");
    expect(invoke.mock.calls).toEqual([
      ["set_compatibility", { worksheet: "worksheet-1", packageName: "JSON3", compatibility: "1.14" }],
      ["set_compatibility", { worksheet: "worksheet-1", packageName: "JSON3", compatibility: "" }],
    ]);
  });
  it("passes worksheet environment copy arguments to Tauri", async () => {
    invoke.mockResolvedValue(undefined);
    await equavelaApi.copyEnvironment("worksheet-1", "/work/env-copy");
    expect(invoke).toHaveBeenCalledWith("copy_worksheet_environment", {
      worksheet: "worksheet-1", destination: "/work/env-copy",
    });
  });
  it("passes environment switch preview, chooser and commit arguments to Tauri", async () => {
    invoke.mockResolvedValue(null);
    await equavelaApi.previewEnvironmentSwitch("worksheet-1", null);
    await equavelaApi.previewEnvironmentSwitch("worksheet-1", "/work/env");
    await equavelaApi.chooseEnvironmentSwitch("worksheet-1");
    await equavelaApi.commitEnvironmentSwitch("worksheet-1", "opaque-token");
    expect(invoke.mock.calls).toEqual([
      ["preview_environment_switch", { worksheet: "worksheet-1", target: null }],
      ["preview_environment_switch", { worksheet: "worksheet-1", target: "/work/env" }],
      ["choose_environment_switch", { worksheet: "worksheet-1" }],
      ["commit_environment_switch", { worksheet: "worksheet-1", token: "opaque-token" }],
    ]);
  });
  it("passes the selected metadata filename to Tauri", async () => {
    invoke.mockResolvedValue("");
    await equavelaApi.readEnvironmentMetadata("worksheet-1", "project");
    await equavelaApi.readEnvironmentMetadata("worksheet-1", "manifest");
    expect(invoke.mock.calls).toEqual([
      ["read_environment_metadata", { worksheet: "worksheet-1", file: "project" }],
      ["read_environment_metadata", { worksheet: "worksheet-1", file: "manifest" }],
    ]);
  });
  it("passes project paths and stable identities to the project commands", async () => {
    invoke.mockResolvedValue(undefined);
    await equavelaApi.newProject("/projects/heat", "Heat", "project-id", "sheet-id");
    await equavelaApi.openProject("/projects/heat");
    expect(invoke.mock.calls).toEqual([
      ["new_project", { destination: "/projects/heat", name: "Heat", projectId: "project-id", worksheetId: "sheet-id" }],
      ["open_project", { root: "/projects/heat" }],
    ]);
  });
  it("passes camelCase arguments under the command names", async () => {
    invoke.mockResolvedValue(undefined);
    await equavelaApi.openWorksheet("/x.eqv");
    await equavelaApi.closeWorksheet("ws1");
    await equavelaApi.editRegion("ws1", "/x.eqv", "r1", "a := 1");
    await equavelaApi.recalculate("ws1");
    await equavelaApi.recalculate("ws1", true);
    await equavelaApi.interrupt("ws1");
    await equavelaApi.getResults("ws1");
    await equavelaApi.kernelStatus();
    await equavelaApi.startKernel();
    await equavelaApi.coreVersion();
    expect(invoke.mock.calls).toEqual([
      ["open_worksheet", { path: "/x.eqv" }],
      ["close_worksheet", { worksheet: "ws1" }],
      [
        "edit_region",
        {
          worksheet: "ws1",
          document: "/x.eqv",
          regionId: "r1",
          text: "a := 1",
        },
      ],
      ["recalculate", { worksheet: "ws1", all: false }],
      ["recalculate", { worksheet: "ws1", all: true }],
      ["interrupt", { worksheet: "ws1" }],
      ["get_results", { worksheet: "ws1" }],
      ["kernel_status"],
      ["start_kernel"],
      ["core_version"],
    ]);
  });

  it("sends the label styles of a worksheet under their own command", async () => {
    invoke.mockResolvedValue(undefined);
    const values = {
      "label-style.var.italic": "false",
      "label-style.var.color": null,
    };
    await equavelaApi.setLabelStyles("ws1", values);
    expect(invoke.mock.calls).toEqual([["set_label_styles", { worksheet: "ws1", values }]]);
  });

  it("returns what the backend resolves with", async () => {
    invoke.mockResolvedValue([key("a")]);
    await expect(
      equavelaApi.editRegion("ws1", "/a.eqv", "a", "a := 2"),
    ).resolves.toEqual([key("a")]);
  });

  it("propagates structured command errors", async () => {
    const error = {
      kind: "parse",
      message: "line 1, column 6: unexpected `:=`",
      line: 1,
      column: 6,
      start: 5,
      end: 7,
    };
    invoke.mockRejectedValue(error);
    await expect(
      equavelaApi.editRegion("ws1", "/a.eqv", "a", "a := := 2"),
    ).rejects.toEqual(error);
  });
});

describe("events", () => {
  it("subscribes to kernel status and unwraps the payload", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const handler = vi.fn();
    const result = await onKernelStatus(handler);
    expect(result).toBe(unlisten);
    expect(listen.mock.calls[0][0]).toBe(EVENT_KERNEL_STATUS);
    listen.mock.calls[0][1]({ payload: { status: "busy" } });
    expect(handler).toHaveBeenCalledWith({ status: "busy" });
  });

  it("subscribes to worksheet events and unwraps the payload", async () => {
    listen.mockResolvedValue(vi.fn());
    const handler = vi.fn();
    await onWorksheetEvent(handler);
    expect(listen.mock.calls[0][0]).toBe(EVENT_WORKSHEET);
    const event: WorksheetEvent = {
      worksheet: "ws1",
      event: "pass_failed",
      message: "no kernel",
    };
    listen.mock.calls[0][1]({ payload: event });
    expect(handler).toHaveBeenCalledWith(event);
  });
});

describe("applyWorksheetEvent", () => {
  const results: RegionEntry[] = [
    { key: key("a"), state: "pending" },
    { key: key("b"), state: "pending" },
  ];

  it("replaces the updated region only", () => {
    const entry: RegionEntry = {
      key: key("b"),
      state: "value",
      value: { type: "real", value: 3 },
    };
    const next = applyWorksheetEvent(results, {
      worksheet: "ws1",
      event: "region_updated",
      entry,
    });
    expect(next[0]).toBe(results[0]);
    expect(next[1]).toEqual(entry);
    expect(results[1]).toEqual({ key: key("b"), state: "pending" });
  });

  it("ignores events that carry no result", () => {
    const same = applyWorksheetEvent(results, {
      worksheet: "ws1",
      event: "region_started",
      key: key("a"),
    });
    expect(same).toBe(results);
  });

  it("keys distinguish instances of an included document", () => {
    expect(keyId(key("a"))).not.toBe(keyId({ ...key("a"), instance: 1 }));
  });
});

describe("applyWorksheetEvents", () => {
  const results: RegionEntry[] = [
    { key: key("a"), state: "pending" },
    { key: key("b"), state: "pending" },
    { key: key("c"), state: "pending" },
  ];
  const value = (region_id: string, amount: number): RegionEntry => ({
    key: key(region_id),
    state: "value",
    value: { type: "real", value: amount },
  });
  const updated = (entry: RegionEntry): WorksheetEvent => ({
    worksheet: "ws1",
    event: "region_updated",
    entry,
  });

  it("applies the updates of several keys in one batch", () => {
    const a = value("a", 1);
    const c = value("c", 3);
    const next = applyWorksheetEvents(results, [updated(a), updated(c)]);
    expect(next).toEqual([a, results[1], c]);
    // The entries the batch does not touch stay the same objects.
    expect(next[1]).toBe(results[1]);
  });

  it("lets the last update of a key win", () => {
    const first = value("b", 1);
    const last = value("b", 2);
    const next = applyWorksheetEvents(results, [updated(first), updated(last)]);
    expect(next[1]).toEqual(last);
    // A later event that carries the entry already in place puts it back.
    expect(applyWorksheetEvents(results, [updated(first), updated(results[1])])).toEqual(results);
  });

  it("ignores events that carry no known region", () => {
    const same = applyWorksheetEvents(results, [
      updated(value("zzz", 1)),
      { worksheet: "ws1", event: "region_started", key: key("a") },
      { worksheet: "ws1", event: "plot_updated", document: "/a.eqv", region_id: "r" },
    ]);
    expect(same).toBe(results);
  });

  it("keeps finding the right entry across batches and after the results are rearranged", () => {
    // Batches of one pass: each works on the array the previous one returned.
    const first = applyWorksheetEvents(results, [updated(value("a", 1))]);
    const second = applyWorksheetEvents(first, [updated(value("c", 3))]);
    const third = applyWorksheetEvents(second, [updated(value("b", 2)), updated(value("a", 4))]);
    expect(third).toEqual([value("a", 4), value("b", 2), value("c", 3)]);
    // An edit rebuilds the results in another order: the new array gets its own positions.
    const reordered = [third[2], third[0], third[1]];
    const after = applyWorksheetEvents(reordered, [updated(value("a", 9))]);
    expect(after).toEqual([value("c", 3), value("a", 9), value("b", 2)]);
  });

  it("does not mutate the results it is given", () => {
    const before = [...results];
    applyWorksheetEvents(results, [updated(value("a", 1)), updated(value("b", 2))]);
    expect(results).toEqual(before);
    expect(results[1]).toEqual({ key: key("b"), state: "pending" });
  });

  it("returns the same array when nothing changes", () => {
    expect(applyWorksheetEvents(results, [])).toBe(results);
    // An update that carries the entry object already in place changes nothing either.
    expect(applyWorksheetEvents(results, [updated(results[0])])).toBe(results);
  });
});

describe("formatValue", () => {
  const real = (value: number | "nan" | "infinity" | "-infinity") =>
    ({ type: "real", value }) as KernelValue;

  it("formats scalars", () => {
    expect(formatValue(null)).toBe("");
    expect(formatValue(real(2.5))).toBe("2.5");
    expect(formatValue(real("nan"))).toBe("NaN");
    expect(formatValue(real("-infinity"))).toBe("-∞");
    expect(formatValue({ type: "string", value: "hi" })).toBe('"hi"');
    expect(formatValue({ type: "complex", real: 1, imag: -2 })).toBe(
      "1 - 2i",
    );
    expect(formatValue({ type: "complex", real: 1, imag: 2 })).toBe("1 + 2i");
  });

  it("formats quantities and handles", () => {
    expect(
      formatValue({
        type: "quantity",
        magnitude: { type: "real", value: 9.81 },
        dimension: [
          { base: "length", power: [1, 1] },
          { base: "time", power: [-2, 1] },
        ],
      }),
    ).toBe("9.81 [SI: length·time^-2]");
    expect(
      formatValue({
        type: "handle",
        id: "h1",
        julia_type: "Foo.Bar",
        summary: "a bar",
      }),
    ).toBe("Foo.Bar: a bar");
  });

  it("formats small matrices row by row from column-major storage", () => {
    const matrix: KernelValue = {
      type: "matrix",
      rows: 2,
      cols: 2,
      storage: {
        type: "inline",
        values: [real(1), real(3), real(2), real(4)],
      },
    };
    expect(formatValue(matrix)).toBe("1  2\n3  4");
  });

  it("summarizes large matrices", () => {
    expect(
      formatValue({
        type: "matrix",
        rows: 10,
        cols: 10,
        storage: { type: "inline", values: [] },
      }),
    ).toBe("10×10 matrix");
  });
});

describe("describeState", () => {
  it("describes every state", () => {
    expect(describeState({ state: "pending" })).toBe("pending");
    expect(
      describeState({
        state: "stale",
        value: { type: "real", value: 1 },
      }),
    ).toBe("stale 1");
    expect(describeState({ state: "stale", value: null })).toBe("stale");
    expect(describeState({ state: "value", value: null })).toBe("defined");
    expect(
      describeState({
        state: "value",
        value: { type: "real", value: 4 },
      }),
    ).toBe("4");
    expect(
      describeState({
        state: "error",
        failure: {
          kind: "blocked",
          message: "depends on failed region a",
          span: null,
          blocked_by: key("a"),
          julia_type: null,
        },
      }),
    ).toBe("error: depends on failed region a");
  });
});

describe("page view commands", () => {
  it("passes camelCase arguments for the region commands", async () => {
    invoke.mockResolvedValue(undefined);
    await equavelaApi.addRegion("ws1", "math", 2, 54, 72, "x := 1");
    expect(invoke).toHaveBeenLastCalledWith("add_region", {
      worksheet: "ws1",
      kind: "math",
      page: 2,
      x: 54,
      y: 72,
      text: "x := 1",
    });
    const moves = [{ region_id: "a", page: 1, x: 3, y: 6 }];
    await equavelaApi.moveRegions("ws1", moves);
    expect(invoke).toHaveBeenLastCalledWith("move_regions", { worksheet: "ws1", moves });
    await equavelaApi.removeRegions("ws1", ["a", "b"]);
    expect(invoke).toHaveBeenLastCalledWith("remove_regions", {
      worksheet: "ws1",
      regionIds: ["a", "b"],
    });
    await equavelaApi.undo("ws1");
    expect(invoke).toHaveBeenLastCalledWith("undo", { worksheet: "ws1" });
    await equavelaApi.redo("ws1");
    expect(invoke).toHaveBeenLastCalledWith("redo", { worksheet: "ws1" });
    await equavelaApi.newWorksheet();
    expect(invoke).toHaveBeenLastCalledWith("new_worksheet");
    await equavelaApi.initialWorksheet();
    expect(invoke).toHaveBeenLastCalledWith("initial_worksheet");
    await equavelaApi.getView("ws1");
    expect(invoke).toHaveBeenLastCalledWith("get_view", { worksheet: "ws1" });
  });
});
