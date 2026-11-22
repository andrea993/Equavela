// The information card of a hovered name: value or matrix size,
// unit, and where it is defined. Screen only; positioned in client coordinates.

import { useLayoutEffect, useRef, useState } from "react";
import { ValueView } from "../results/ResultView";
import type { ResultFormat } from "../results/format";
import { S } from "../strings";
import type { DefinitionValue } from "../equavelaApi";
import { fileName } from "../inspect/inspection";
import type { NameInfo } from "../inspect/hover";

export type NameHover = {
  regionId: string;
  start: number;
  end: number;
  name: string;
  /** The label the name is drawn with: only a unit-drawn name is a unit. */
  label?: string;
  /** The name's box in client coordinates. */
  rect: { left: number; top: number; right: number; bottom: number };
};

export default function HoverCard({
  hover,
  info,
  value,
  root,
  pageOf,
  format,
  moduleName = null,
}: {
  hover: NameHover;
  info: NameInfo;
  value: DefinitionValue | undefined;
  root: string;
  pageOf: (regionId: string) => number | null;
  format: ResultFormat;
  /** the worksheet's module name, for the REPL name of the definition. */
  moduleName?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: hover.rect.left, top: hover.rect.bottom + 6 });
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = hover.rect.left;
    let top = hover.rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
    if (top + height > window.innerHeight - 8) top = Math.max(8, hover.rect.top - 6 - height);
    setPlace({ left, top });
  }, [hover, info, value]);

  let body;
  if (info.kind === "definition") {
    const { definition } = info;
    const inside = definition.key.document !== root;
    const page = inside ? null : pageOf(definition.key.region_id);
    const where = inside ? fileName(definition.key.document) : page ? S.hover.region(page) : definition.key.region_id;
    body = (
      <>
        <div className="hover-head">
          <span className="math">{definition.signature}</span>
          {definition.label === "fn" && <span className="tag">{S.hover.function}</span>}
        </div>
        {definition.label === "var" && (
          <div className="hover-value">
            {!value ? (
              <span className="muted">…</span>
            ) : value.error ? (
              <span className="muted">{value.error === "not calculated yet" ? S.hover.notCalculated : value.error}</span>
            ) : value.size ? (
              S.hover.matrix(value.size[0], value.size[1])
            ) : value.value?.type === "matrix" ? (
              S.hover.matrix(value.value.rows, value.value.cols)
            ) : value.value ? (
              <span className="math">
                <ValueView value={value.value} format={format} />
              </span>
            ) : null}
          </div>
        )}
        <div className="hover-where">{S.hover.definedAt(where)}</div>
        {definition.kernel_name && (
          <div className="hover-repl" data-testid="hover-repl">
            {S.hover.repl}{" "}<code>{moduleName ? `Project.${moduleName}.${definition.kernel_name}` : definition.kernel_name}</code>
          </div>
        )}
        {!info.own && <div className="hover-hint">{S.hover.jump}</div>}
      </>
    );
  } else if (info.kind === "unit") {
    body = (
      <div className="hover-head">
        <span className="math">{info.name}</span>
        <span className="tag">{S.hover.unit}</span>
      </div>
    );
  } else if (info.kind === "constant" || info.kind === "system") {
    body = (
      <>
        <div className="hover-head">
          <span className="math">{info.name}</span>
          <span className="tag">{info.kind === "constant" ? S.hover.constant : S.hover.system}</span>
        </div>
        {info.kind === "constant" && info.value !== undefined && (
          <div className="hover-value math">
            <ValueView value={{ type: "real", value: info.value }} format={format} />
          </div>
        )}
      </>
    );
  } else if (info.kind === "builtin") {
    body = (
      <>
        <div className="hover-head">
          <span className="math">{info.entry.signature}</span>
          <span className="tag">{S.hover.builtin}</span>
        </div>
        <div className="hover-where">{info.entry.description}</div>
      </>
    );
  } else {
    body = (
      <div className="hover-head">
        <span className="math">{info.name}</span>
        <span className="tag warn">{S.hover.undefinedName}</span>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="hover-card chrome no-print"
      style={{ left: place.left, top: place.top }}
      role="tooltip"
      data-testid="hover-card"
    >
      {body}
    </div>
  );
}
