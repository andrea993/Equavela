// The Recent menu's list: most recent first, at most
// RECENT_FILES_MAX, no duplicates; per user in localStorage, never part of a worksheet.

import { beforeEach, describe, expect, it } from "vitest";
import {
  readRecentFiles,
  recentFileFolder,
  recentFileName,
  RECENT_FILES_KEY,
  RECENT_FILES_MAX,
  sanitizeRecentFiles,
  withRecent,
  writeRecentFiles,
} from "./recentFiles";

beforeEach(() => window.localStorage.clear());

describe("the recent files list", () => {
  it("keeps only non-empty strings, trimmed, without duplicates", () => {
    expect(sanitizeRecentFiles(["/a.eqv", "  /b.eqv  ", "/a.eqv", "", 7, null, "/c.eqv"])).toEqual([
      "/a.eqv",
      "/b.eqv",
      "/c.eqv",
    ]);
    expect(sanitizeRecentFiles("not a list")).toEqual([]);
    expect(sanitizeRecentFiles(null)).toEqual([]);
  });

  it("keeps at most ten entries", () => {
    const many = Array.from({ length: RECENT_FILES_MAX + 5 }, (_, i) => `/file-${i}.eqv`);
    const kept = sanitizeRecentFiles(many);
    expect(kept).toHaveLength(RECENT_FILES_MAX);
    expect(kept[0]).toBe("/file-0.eqv");
    expect(kept.at(-1)).toBe(`/file-${RECENT_FILES_MAX - 1}.eqv`);
  });

  it("moves a file that is opened again to the front, never repeating it", () => {
    expect(withRecent(["/a.eqv", "/b.eqv"], "/b.eqv")).toEqual(["/b.eqv", "/a.eqv"]);
    expect(withRecent(["/a.eqv", "/b.eqv"], "/c.eqv")).toEqual(["/c.eqv", "/a.eqv", "/b.eqv"]);
    expect(withRecent(["/a.eqv"], "   ")).toEqual(["/a.eqv"]);
  });

  it("stores and reads the list; damaged storage reads as empty", () => {
    expect(readRecentFiles()).toEqual([]);
    writeRecentFiles(["/a.eqv", "/b.eqv"]);
    expect(readRecentFiles()).toEqual(["/a.eqv", "/b.eqv"]);
    window.localStorage.setItem(RECENT_FILES_KEY, "{ not json");
    expect(readRecentFiles()).toEqual([]);
  });
});

describe("the name and the folder of an entry", () => {
  it("splits a POSIX path", () => {
    expect(recentFileName("/home/anna/work/beam.eqv")).toBe("beam.eqv");
    expect(recentFileFolder("/home/anna/work/beam.eqv")).toBe("/home/anna/work");
  });

  it("splits a Windows path", () => {
    expect(recentFileName("C:\\Users\\anna\\beam.eqv")).toBe("beam.eqv");
    expect(recentFileFolder("C:\\Users\\anna\\beam.eqv")).toBe("C:\\Users\\anna");
  });

  it("leaves a path without a folder alone", () => {
    expect(recentFileName("beam.eqv")).toBe("beam.eqv");
    expect(recentFileFolder("beam.eqv")).toBe("");
  });
});
