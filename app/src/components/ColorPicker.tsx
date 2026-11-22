// Colour choice of the Text tab: a button that opens a palette of coloured squares, as in
// Paint, and a "More colors…" dialog with the RGB picker (an area to point at with the mouse, a hue bar,
// the red, green and blue fields and the hex code).

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { S } from "../strings";

export type Swatch = { value: string; name: string };

/** The screen eyedropper of Chromium-based webviews (WebView2): absent in WebKitGTK. */
type EyeDropperApi = new () => { open: () => Promise<{ sRGBHex: string }> };
const eyeDropper = (): EyeDropperApi | null => (window as unknown as { EyeDropper?: EyeDropperApi }).EyeDropper ?? null;

/** The colours the user picked with "More colors…" in this session, newest first (at most ten). */
const recentCustom: string[] = [];

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Hue 0..360, saturation and value 0..1. */
export function rgbToHsv(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const d = max - min;
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(
  h: number,
  s: number,
  v: number,
): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const hsvHex = (h: number, s: number, v: number) =>
  rgbToHex(...hsvToRgb(h, s, v));

/** The grid under the named colours: a row of grays, then the hues at five lightness levels. */
const HUES = [0, 30, 55, 120, 175, 210, 260, 290, 325];
export const GRID_COLORS: Swatch[][] = (() => {
  const grays = [
    "#000000",
    "#404040",
    "#808080",
    "#a0a0a0",
    "#c0c0c0",
    "#e0e0e0",
    "#ffffff",
  ].map((value) => ({
    value,
    name: value,
  }));
  // From dark to light: the dark rows lower the value, the light rows lower the saturation.
  const rows = [
    [1, 0.45],
    [1, 0.75],
    [1, 1],
    [0.55, 1],
    [0.25, 1],
  ].map(([s, v]) =>
    HUES.map((h) => {
      const value = hsvHex(h, s!, v!);
      return { value, name: value };
    }),
  );
  return [grays, ...rows];
})();

export function ColorPicker({
  label,
  none,
  colors,
  value,
  disabled,
  title,
  onPick,
  worksheetColors,
  hideLabel = false,
}: {
  label: string;
  none: string;
  colors: Swatch[];
  value: string | null;
  disabled: boolean;
  title: string;
  onPick: (color: string | null) => void;
  /**
   * The colours the worksheet already uses (traces of other plots, texts, math fonts: ), offered as a row
   * so one is taken with one click.
   */
  worksheetColors?: readonly string[];
  /** The label stays the accessible name of the button but is not drawn (a field row that already names it). */
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const palette = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });

  // A press outside the picker, or Escape, closes the palette.
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !root.current?.contains(event.target as Node) &&
            !palette.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const pick = (color: string | null) => {
    setOpen(false);
    onPick(color);
  };
  const pickCustom = (color: string) => {
    const at = recentCustom.indexOf(color);
    if (at >= 0) recentCustom.splice(at, 1);
    recentCustom.unshift(color);
    recentCustom.length = Math.min(recentCustom.length, 10);
    setDialog(false);
    onPick(color);
  };

  return (
    <div className="size-picker color-picker" ref={root} title={title}>
      {!hideLabel && <span className="tool-label">{label}</span>}
      <button
        type="button"
        className="color-button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        // The press must not move the focus away from the text being edited: the selection stays.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          // The ribbon clips what overflows it: the palette is drawn on the body, under the button.
          const box = event.currentTarget.getBoundingClientRect();
          setAt({ top: box.bottom + 2, left: box.left });
          setOpen(!open);
        }}
      >
        <span
          className="color-chip"
          style={{ background: value ?? undefined }}
          data-empty={value === null || undefined}
        />
        <span aria-hidden="true">▾</span>
      </button>
      {open &&
        createPortal(
          <div
            className="color-palette"
            role="dialog"
            aria-label={label}
            ref={palette}
            style={at}
            onMouseDown={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="color-none"
              onClick={() => pick(null)}
            >
              {none}
            </button>
            <div className="color-caption">{S.text.paletteColors}</div>
            <div className="color-row">
              {colors.map((color) => (
                <SwatchButton
                  key={color.value}
                  color={color}
                  active={value === color.value}
                  onPick={pick}
                />
              ))}
            </div>
            {GRID_COLORS.map((row, i) => (
              <div className="color-row" key={i}>
                {row.map((color) => (
                  <SwatchButton
                    key={color.value}
                    color={color}
                    active={value === color.value}
                    onPick={pick}
                  />
                ))}
              </div>
            ))}
            {worksheetColors && worksheetColors.length > 0 && (
              <>
                <div className="color-caption">{S.text.worksheetColors}</div>
                <div className="color-row" data-testid="worksheet-colors">
                  {worksheetColors.map((color) => (
                    <SwatchButton
                      key={color}
                      color={{ value: color, name: color }}
                      active={value === color}
                      onPick={pick}
                    />
                  ))}
                </div>
              </>
            )}
            {recentCustom.length > 0 && (
              <>
                <div className="color-caption">{S.text.recentColors}</div>
                <div className="color-row">
                  {recentCustom.map((color) => (
                    <SwatchButton
                      key={color}
                      color={{ value: color, name: color }}
                      active={value === color}
                      onPick={pick}
                    />
                  ))}
                </div>
              </>
            )}
            <button
              type="button"
              className="color-more"
              onClick={() => {
                setOpen(false);
                setDialog(true);
              }}
            >
              {S.text.moreColors}
            </button>
            {/* The screen eyedropper takes a colour from anywhere, a trace of another plot included; WebKitGTK
                has none, so the row of the worksheet's colours is the way there. */}
            {eyeDropper() && (
              <button
                type="button"
                className="color-more color-eyedropper"
                data-testid="eyedropper"
                onClick={() => {
                  const Dropper = eyeDropper();
                  if (!Dropper) return;
                  setOpen(false);
                  new Dropper()
                    .open()
                    .then(({ sRGBHex }) => pickCustom(sRGBHex.toLowerCase()))
                    .catch(() => undefined);
                }}
              >
                {S.text.eyedropper}
              </button>
            )}
          </div>,
          document.body,
        )}
      {dialog && (
        <ColorDialog
          title={label}
          initial={value ?? "#000000"}
          onOk={pickCustom}
          onCancel={() => setDialog(false)}
        />
      )}
    </div>
  );
}

function SwatchButton({
  color,
  active,
  onPick,
}: {
  color: Swatch;
  active: boolean;
  onPick: (color: string) => void;
}) {
  return (
    <button
      type="button"
      className={`color-swatch${active ? " active" : ""}`}
      style={{ background: color.value }}
      title={color.name}
      aria-label={color.name}
      aria-pressed={active}
      onClick={() => onPick(color.value)}
    />
  );
}

/** Clamp of a pointer position to a 0..1 fraction of an element. */
function fraction(event: ReactPointerEvent<HTMLElement>): [number, number] {
  const box = event.currentTarget.getBoundingClientRect();
  const f = (p: number, from: number, size: number) =>
    size > 0 ? Math.min(1, Math.max(0, (p - from) / size)) : 0;
  return [
    f(event.clientX, box.left, box.width),
    f(event.clientY, box.top, box.height),
  ];
}

/** The RGB picker: saturation and value on the area, hue on the bar, exact numbers in the fields. */
export function ColorDialog({
  title,
  initial,
  onOk,
  onCancel,
}: {
  title: string;
  initial: string;
  onOk: (color: string) => void;
  onCancel: () => void;
}) {
  const [hsv, setHsv] = useState<[number, number, number]>(() =>
    rgbToHsv(...hexToRgb(initial)),
  );
  const [hexText, setHexText] = useState<string | null>(null);
  const [h, s, v] = hsv;
  const [r, g, b] = hsvToRgb(h, s, v).map(Math.round) as [
    number,
    number,
    number,
  ];
  const hex = rgbToHex(r, g, b);

  const setRgb = (nr: number, ng: number, nb: number) => {
    const [nh, ns, nv] = rgbToHsv(nr, ng, nb);
    // A gray has no hue of its own: the hue the user chose is kept.
    setHsv([ns === 0 || nv === 0 ? h : nh, ns, nv]);
    setHexText(null);
  };
  const drag = (apply: (event: ReactPointerEvent<HTMLElement>) => void) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      apply(event);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.buttons & 1) apply(event);
    },
  });

  const channel = (name: string, value: number, set: (n: number) => void) => (
    <label className="color-channel">
      {name}
      <input
        type="number"
        min={0}
        max={255}
        value={value}
        aria-label={name}
        onChange={(event) =>
          set(
            Math.min(
              255,
              Math.max(0, Math.round(Number(event.target.value)) || 0),
            ),
          )
        }
      />
    </label>
  );

  return (
    <div
      className="dialog-backdrop chrome"
      role="presentation"
      onPointerDown={onCancel}
    >
      <form
        className="dialog color-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} – ${S.text.moreColors}`}
        onPointerDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onOk(hex);
        }}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
      >
        <h2>{S.text.moreColors}</h2>
        <div className="color-picker-body">
          <div
            className="color-area"
            data-testid="color-area"
            style={{
              background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvHex(h, 1, 1)})`,
            }}
            {...drag((event) => {
              const [x, y] = fraction(event);
              setHsv([h, x, 1 - y]);
              setHexText(null);
            })}
          >
            <span
              className="color-area-cursor"
              style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }}
            />
          </div>
          <div
            className="color-hue"
            data-testid="color-hue"
            {...drag((event) => {
              const [, y] = fraction(event);
              setHsv([y * 360, s, v]);
              setHexText(null);
            })}
          >
            <span
              className="color-hue-cursor"
              style={{ top: `${(h / 360) * 100}%` }}
            />
          </div>
          <div className="color-fields">
            <div className="color-compare">
              <span style={{ background: hex }} title={S.text.newColor} />
              <span
                style={{ background: initial }}
                title={S.text.currentColor}
              />
            </div>
            {channel(S.text.red, r, (n) => setRgb(n, g, b))}
            {channel(S.text.green, g, (n) => setRgb(r, n, b))}
            {channel(S.text.blue, b, (n) => setRgb(r, g, n))}
            <label className="color-channel">
              {S.text.hexCode}
              <input
                type="text"
                value={hexText ?? hex}
                aria-label={S.text.hexCode}
                maxLength={7}
                spellCheck={false}
                onChange={(event) => {
                  const text = event.target.value;
                  setHexText(text);
                  const full = /^#?([0-9a-fA-F]{6})$/.exec(text);
                  if (full) setRgb(...hexToRgb(`#${full[1]}`));
                }}
              />
            </label>
          </div>
        </div>
        <div className="dialog-row">
          <button type="submit">{S.text.ok}</button>
          <button type="button" onClick={onCancel}>
            {S.text.cancel}
          </button>
        </div>
      </form>
    </div>
  );
}
