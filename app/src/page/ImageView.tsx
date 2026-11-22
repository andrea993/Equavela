// An image region: one `<img src="data:...">` of exactly its size in
// points. The browser never runs script or loads sub-resources in an `<img>`, so even an SVG that
// was not sanitized could do nothing; the print view prints this same element, so an SVG
// stays vector and a raster keeps its pixels.

import { useContext, useEffect, useState } from "react";
import { ptToPx } from "../layout/geometry";
import { S } from "../strings";
import { ImageContext } from "./ImageContext";

type Props = {
  resource: string;
  /** Width and height in points. */
  size: readonly [number, number];
};

export function ImageView({ resource, size }: Props) {
  const env = useContext(ImageContext);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(null);
    setFailed(false);
    if (!env) return;
    env.load(resource).then(
      (value) => live && setUrl(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // `env` changes with every edit; only the resource decides what is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, env === null]);
  const style = { width: ptToPx(size[0]), height: ptToPx(size[1]) };
  return (
    <div className={`image-view${failed ? " failed" : ""}`} style={style} data-testid="image" data-resource={resource}>
      {url ? (
        <img src={url} alt="" draggable={false} width={style.width} height={style.height} />
      ) : (
        <span className="image-note no-print">{failed ? S.page.imageUnavailable : ""}</span>
      )}
    </div>
  );
}
