import type { PlotAxis, PlotSpec } from "../equavelaApi";

type CartesianAxis = {
  _offset?: number;
  _length?: number;
  _tickround?: number | null;
  p2d?: (pixel: number) => number;
};

type PolarAxis = {
  _rl?: [number, number];
  direction?: "clockwise" | "counterclockwise";
  rotation?: number;
  thetaunit?: string;
  g2c?: (angle: number) => number;
  c2d?: (angle: number, unit?: string) => number;
  l2c?: (radius: number) => number;
};

export type PlotLayout = {
  xaxis?: CartesianAxis;
  yaxis?: CartesianAxis;
  yaxis2?: CartesianAxis;
  polar?: {
    _subplot?: {
      cx: number;
      cy: number;
      radius: number;
      innerRadius: number;
      radialAxis: PolarAxis;
      angularAxis: PolarAxis;
    };
  };
};

/** Compact numeric text, using the axis tick precision when Plotly has calculated it. */
export function formatCoordinate(value: number, tickPrecision?: number | null): string {
  if (!Number.isFinite(value)) return "";
  if (Object.is(value, -0) || value === 0) return "0";
  if (typeof tickPrecision === "number" && Number.isFinite(tickPrecision)) {
    const digits = Math.trunc(tickPrecision);
    if (digits >= 0 && digits <= 12 && Math.abs(value) < 1e21) {
      const fixed = value.toFixed(digits);
      if (Number(fixed) === 0) return "0";
      return digits === 0 ? fixed : fixed.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
    }
    if (digits < 0 && digits >= -12) {
      const place = 10 ** -digits;
      return String(Math.round(value / place) * place);
    }
  }
  return Number(value.toPrecision(6)).toString();
}

function withUnit(value: number, axis: PlotAxis | undefined, tickPrecision?: number | null, fallbackUnit?: string): string {
  const text = formatCoordinate(value, tickPrecision);
  const unit = axis?.unit?.trim() || fallbackUnit;
  return unit ? `${text} ${unit}` : text;
}

function polarAngleText(value: number): string {
  const turn = Math.PI * 2;
  const normalized = ((value % turn) + turn) % turn;
  if (normalized < 1e-9 || turn - normalized < 1e-9) return "0";
  for (let denominator = 1; denominator <= 24; denominator++) {
    const numerator = Math.round((normalized / Math.PI) * denominator);
    if (Math.abs(normalized - (numerator * Math.PI) / denominator) > 1e-8) continue;
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(numerator, denominator);
    const top = numerator / divisor;
    const bottom = denominator / divisor;
    const numeratorText = top === 1 ? "π" : `${top}π`;
    return bottom === 1 ? numeratorText : `${numeratorText}/${bottom}`;
  }
  return formatCoordinate(normalized);
}

function pointAxis(axis: CartesianAxis | undefined, pixel: number): number | null {
  if (!axis?.p2d || axis._offset === undefined || axis._length === undefined) return null;
  if (pixel < axis._offset || pixel > axis._offset + axis._length) return null;
  const value = axis.p2d(pixel - axis._offset);
  return Number.isFinite(value) ? value : null;
}

/** Axis coordinates under a pointer in the graph div's CSS-pixel coordinate system. */
export function cursorCoordinatesAt(
  spec: PlotSpec,
  layout: PlotLayout | undefined,
  pixelX: number,
  pixelY: number,
): string | null {
  if (!layout || !Number.isFinite(pixelX) || !Number.isFinite(pixelY)) return null;
  if (spec.type === "polar") {
    const polar = layout.polar?._subplot;
    const radial = polar?.radialAxis;
    const angular = polar?.angularAxis;
    const range = radial?._rl;
    if (!polar || !radial?.l2c || !angular?.g2c || !angular.c2d || !range) return null;
    const dx = pixelX - polar.cx;
    const dy = polar.cy - pixelY;
    const distance = Math.hypot(dx, dy);
    if (distance > polar.radius) return null;
    const span = polar.radius - polar.innerRadius;
    if (!(span > 0)) return null;
    const radialLinear = range[0] + ((distance - polar.innerRadius) / span) * (range[1] - range[0]);
    const radius = radial.l2c(radialLinear);
    const geometricAngle = Math.atan2(dy, dx);
    const angle = angular.c2d(angular.g2c(geometricAngle), angular.thetaunit);
    if (!Number.isFinite(radius) || !Number.isFinite(angle)) return null;
    const angleAxis = spec.axes.x;
    const radiusAxis = spec.axes.y;
    const angleUnit = angleAxis.unit?.trim() || "rad";
    return `θ = ${polarAngleText(angle)} ${angleUnit}; r = ${withUnit(radius, radiusAxis)}`;
  }
  if (spec.type !== "xy" && spec.type !== "contour") return null;
  const x = pointAxis(layout.xaxis, pixelX);
  const y = pointAxis(layout.yaxis, pixelY);
  if (x === null || y === null) return null;
  const coordinates = [
    `x = ${withUnit(x, spec.axes.x, layout.xaxis?._tickround)}`,
    `y = ${withUnit(y, spec.axes.y, layout.yaxis?._tickround)}`,
  ];
  if (spec.traces.some((trace) => trace.y_axis === "right")) {
    const y2 = pointAxis(layout.yaxis2, pixelY);
    if (y2 !== null) coordinates.push(`y₂ = ${withUnit(y2, spec.axes.y2 ?? spec.axes.y, layout.yaxis2?._tickround)}`);
  }
  return coordinates.join("; ");
}
