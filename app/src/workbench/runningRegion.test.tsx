// The wait symbol of the region being calculated.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusBar, type StatusBarProps } from "../components/Chrome";
import type { RegionKey, WorksheetEvent } from "../equavelaApi";
import {
  BUSY_AFTER_MS,
  resetRunningRegions,
  runningRegionOf,
  trackRunningRegion,
  useRegionBusy,
} from "./runningRegion";

const key = (regionId: string, document = "/a.eqv"): RegionKey => ({ document, region_id: regionId, instance: 0 });
const started = (regionId: string, document = "/a.eqv"): WorksheetEvent => ({
  worksheet: "w1",
  event: "region_started",
  key: key(regionId, document),
});
const updated = (regionId: string, document = "/a.eqv"): WorksheetEvent => ({
  worksheet: "w1",
  event: "region_updated",
  entry: { key: key(regionId, document), state: "pending" } as never,
});

function Probe({ id, document = "/a.eqv" }: { id: string; document?: string }) {
  return useRegionBusy(id, document) ? <span data-testid={`busy-${id}`} /> : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRunningRegions();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the wait symbol of the running region", () => {
  it("shows after one second on the running region only, never on another one", () => {
    render(<><Probe id="r1" /><Probe id="r2" /></>);
    act(() => trackRunningRegion(started("r1")));
    act(() => void vi.advanceTimersByTime(BUSY_AFTER_MS - 1));
    expect(screen.queryByTestId("busy-r1")).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByTestId("busy-r1")).toBeTruthy();
    expect(screen.queryByTestId("busy-r2")).toBeNull();
  });

  it("never shows for a region that finishes within the second", () => {
    render(<Probe id="r1" />);
    act(() => trackRunningRegion(started("r1")));
    act(() => void vi.advanceTimersByTime(600));
    act(() => trackRunningRegion(updated("r1")));
    act(() => void vi.advanceTimersByTime(5000));
    expect(screen.queryByTestId("busy-r1")).toBeNull();
  });

  it("goes when the result arrives, when the pass ends and when another pass starts", () => {
    render(<Probe id="r1" />);
    const run = () => {
      act(() => trackRunningRegion(started("r1")));
      act(() => void vi.advanceTimersByTime(BUSY_AFTER_MS));
      expect(screen.getByTestId("busy-r1")).toBeTruthy();
    };
    run();
    act(() => trackRunningRegion(updated("r1")));
    expect(screen.queryByTestId("busy-r1")).toBeNull();
    run();
    act(() => trackRunningRegion({ worksheet: "w1", event: "pass_failed", message: "x" }));
    expect(screen.queryByTestId("busy-r1")).toBeNull();
    run();
    act(() => trackRunningRegion({ worksheet: "w1", event: "pass_started", affected: 3, reset: false }));
    expect(screen.queryByTestId("busy-r1")).toBeNull();
  });

  it("is the region of its own document: the same id in an included worksheet does not show it", () => {
    render(<><Probe id="r1" /><Probe id="r1" document="/inc.eqv" /></>);
    act(() => trackRunningRegion(started("r1", "/inc.eqv")));
    act(() => void vi.advanceTimersByTime(BUSY_AFTER_MS));
    expect(screen.getAllByTestId("busy-r1")).toHaveLength(1);
  });

  it("keeps the key of the running region for the progress bar", () => {
    act(() => trackRunningRegion(started("r7")));
    expect(runningRegionOf("w1")).toEqual(key("r7"));
    act(() => trackRunningRegion({ worksheet: "w1", event: "pass_finished", summary: {} as never }));
    expect(runningRegionOf("w1")).toBeNull();
  });
});

describe("the progress bar", () => {
  const bar = (onShowRunning: () => void) => {
    const props = {
      mode: "mock",
      kernel: null,
      doc: { progress: { done: 1, total: 4, stopping: false } } as never,
      page: { current: 1, total: 1 },
      calcMode: "auto",
      zoom: 1,
      viewMode: "page",
      find: { query: "", replacement: "", index: 0, total: 0 },
      onFind: () => {},
      onReplace: () => {},
      onFindStep: () => {},
      onReplaceOne: () => {},
      onReplaceAll: () => {},
      onToggleCalc: () => {},
      onStop: () => {},
      onShowRunning,
      onZoom: () => {},
      onViewMode: () => {},
    } as StatusBarProps;
    return render(<StatusBar {...props} />);
  };

  it("shows the running region on Ctrl+click and does nothing on a plain click", () => {
    const show = vi.fn();
    bar(show);
    const progress = screen.getByTestId("progress");
    expect(progress.getAttribute("title")).toMatch(/Ctrl\+click/);
    fireEvent.click(progress);
    expect(show).not.toHaveBeenCalled();
    fireEvent.click(progress, { ctrlKey: true });
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe("the stylesheet contract of the wait symbol", () => {
  const css = (() => {
    for (const candidate of [resolve("src/styles/page.css"), resolve("app/src/styles/page.css")]) {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    }
    return "";
  })();

  it("passes pointer events through, spins, and stands still under reduced motion", () => {
    const rule = /\.region-busy\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/pointer-events\s*:\s*none/);
    expect(rule).toMatch(/animation\s*:/);
    expect(css).toMatch(/prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{\s*\.region-busy\s*\{\s*animation\s*:\s*none/);
  });
});
