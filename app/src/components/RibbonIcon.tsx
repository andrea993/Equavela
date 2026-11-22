// Line drawings for the ribbon. Mathematical notation still uses its own glyphs.
const drawings = {
  newSheet: "M4 2.5h8l4 4v11H4z M12 2.5v4h4 M7 12h6 M10 9v6",
  openSheet: "M4 2.5h8l4 4V9 M4 2.5v7 M12 2.5v4h4 M2.5 10.5h15l-2 7h-11z",
  saveSheet: "M5 3h10v5 M5 3v5 M3 10v7h14v-7 M10 7v7 M7.5 11.5 10 14l2.5-2.5",
  saveAs: "M3 3h9l4 4v4 M12 3v4h4 M3 3v14h7 M12 15h5 M14.5 12.5v5",
  closeSheet: "M4 2.5h8l4 4V9 M12 2.5v4h4 M4 2.5v15h5 M12 12l5 5 M17 12l-5 5",
  newProject: "M2.5 6h5l1.5 2h8.5v9h-15z M2.5 6V3h6l1.5 2h6v2 M7 12.5h6 M10 9.5v6",
  openProject: "M2.5 16V5h5l2 2H17v3 M2.5 16l3-6h13l-3 6z",
  saveProject: "M2.5 9V5h5l2 2h8v10h-15v-4 M10 9v5 M7.5 11.5 10 14l2.5-2.5",
  closeProject: "M3 6h4l2 2h8v9H3z M8 11l4 4 M12 11l-4 4",
  convert: "M3 3h7v8H3z M10 7h4v4 M12 9l2 2 2-2 M8 14h4l1.5 1.5H18v3H8z",
  settings: "M3 5h5m4 0h5 M3 10h9m4 0h1 M3 15h2m4 0h8 M8 3v4m4 1v4m-7 1v4",
  importFile: "M11 3h4l3 3v11h-7 M2.5 10h10 M9 6.5l3.5 3.5L9 13.5",
  exportPdf: "M3 3h8l3 3v3 M3 3v14h6 M11 3v3h3 M11 13h7 M15 10l3 3-3 3 M5.5 7.5h3 M5.5 11h2.5",
  print: "M6 8V3h8v5 M6 14H3V8h14v6h-3 M6 12h8v5H6z M14.5 10h.5",
  pack: "M3 6l3-3h8l3 3v11H3z M3 6h14 M10 8v6 M7.5 11.5 10 14l2.5-2.5",
  unpack: "M3 7h4m6 0h4v10H3V7 M10 12V2.5 M7.5 5 10 2.5 12.5 5",
  mathRegion: "M2 6V3h3 M15 3h3v3 M18 14v3h-3 M5 17H2v-3 M5.5 9.5l5 5m0-5-5 5 M12 6.5c0-1.8 3.5-1.8 3.5 0 0 1.1-1.3 1.6-2.4 2.3L12 10h3.5",
  paragraph: "M3 5h14 M3 8.5h10 M3 12h14 M3 15.5h7",
  textBox: "M3 4h14v12H3z M7 8h6 M10 8v5",
  plot: "M3 3v14h14 M5.5 13.5l3.5-4 3 2 4.5-6",
  matrix: "M5 3H3v14h2 M15 3h2v14h-2 M7 6h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1",
  table: "M3 4h14v12H3z M3 8h14 M3 12h14 M9 8v8",
  image: "M3 4h14v12H3z M3 14l4.5-4 3.5 3 2-2 4 4 M13 7h1",
  area: "M7 4H3v12h4 M13 4h4v12h-4 M7 8h6 M7 12h6",
  include: "M4 3h8l4 4v10H4z M12 3v4h4 M6.5 11.5h7 M11 9l2.5 2.5L11 14",
  terminal: "M3 4h14v12H3z M6 7l3 3-3 3 M10 13h4",
  undo: "M7 3 3 7l4 4 M3 7h9a4 4 0 0 1 0 8H8",
  redo: "M13 3l4 4-4 4 M17 7H8a4 4 0 0 0 0 8h4",
  cut: "M6 3v5m0 4v5 M14 3v5m0 4v5 M3 10h3m2 0h4m2 0h3 M9 6l2 2m-2 6 2-2",
  copy: "M5 13H3V3h10v2 M7 7h10v10H7z M10 10h4m-4 4h4",
  paste: "M7 5H4v12h12V5h-3 M7 3h6v4H7z M7 11h6m-6 3h4",
  find: "M8.5 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M12 12l4.5 4.5",
  replace: "M3 6h11m-3-3 3 3-3 3 M17 14H6m3-3-3 3 3 3",
  delete: "M5 6l1 11h8l1-11 M3 6h14 M7 6V3h6v3 M9 9v5m2-5v5",
  select: "M7 3H3v4m10-4h4v4m0 6v4h-4m-6 0H3v-4 M7 7h6v6H7z",
  pageSetup: "M4 3h12v14H4z M7 6h6v8H7z M4 10h3m6 0h3",
  headerFooter: "M4 3h12v14H4z M7 6h6m-6 8h6 M7 10h2m2 0h2",
  pageBreak: "M5 7V3h10v4 M5 13v4h10v-4 M3 10h2m2 0h2m2 0h2m2 0h2",
  addSpace: "M3 5h14m-14 10h14 M10 7v6 M8 9l2-2 2 2m-4 2 2 2 2-2",
  removeSpace: "M3 5h14m-14 10h14 M8 7l2 2 2-2m-4 6 2-2 2 2",
  run: "M4 3h12v14H4z M9 7l4 3-4 3z",
  runAll: "M6 3h10v12 M4 5h10v12H4z M7 8l4 3-4 3z",
  auto: "M15 7a6 6 0 0 0-10-1l-2 2 M3 4v4h4 M5 13a6 6 0 0 0 10 1l2-2 M17 16v-4h-4",
  stop: "M3 3h14v14H3z M7 7h6v6H7z",
  pageView: "M5 2.5h10v15H5z M8 6h4m-4 3h4m-4 3h3",
  draftView: "M3 3h2m2 0h2m2 0h2m2 0h2 M17 6v2m0 2v2m0 2v3 M3 7v10h10 M6.5 8h6m-6 3h4",
  compact: "M3 5h14v10H3z M3 9h14 M8 12h4",
  panel: "M3 4h14v12H3z M12 4v12 M14 7h1m-1 3h1m-1 3h1",
  operators: "M4 6h5 M6.5 3.5v5 M12 6h5 M4.5 12l4 4m0-4-4 4 M12 13h5m-5 3h5",
  symbols: "M3 11c2.5 0 3-6 5.5-6s3 10 5.5 10c1.5 0 2-2 3-4 M3 15h3m8-10h3",
  units: "M3 7h14v6H3z M6 7v3m4-3v2m4-2v3",
  constants: "M5 4h10v12H5z M8 8h4m-4 4h4",
  programming: "M10 3l3 3-3 3-3-3z M10 9v2H5v3m5-3h5v3 M3 14h4v3H3z m10 0h4v3h-4z",
  symbolics: "M5 3H3v6h2m10 2h2v6h-2 M6 6h3m2 8h3 M6 12l7-5m-3 0h3v3",
  keyboard: "M2 5h16v10H2z M5 8h1m2 0h1m2 0h1m2 0h1 M5 11h1m2 1h4m2-1h1",
  help: "M3 4h14v10h-6l-4 3v-3H3z M8 8a2 2 0 0 1 4 0c0 1-2 1-2 2m0 2h.1",
};

export type RibbonIconName = keyof typeof drawings;

export function RibbonIcon({ name }: { name: RibbonIconName }) {
  return (
    <svg className="ribbon-icon" viewBox="0 0 20 20" width="1.1em" height="1.1em"
      fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={drawings[name]} />
    </svg>
  );
}
