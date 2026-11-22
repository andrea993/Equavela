import { useEffect, useState } from "react";
import { chooseBackend, type Backend } from "./backend";
import Workbench from "./Workbench";

/** Picks the backend (real Tauri commands or the browser mock) and shows the window. */
export default function App({ backend }: { backend?: Backend }) {
  const [chosen, setChosen] = useState<Backend | null>(backend ?? null);
  useEffect(() => {
    if (!chosen) void chooseBackend().then(setChosen);
  }, [chosen]);
  return chosen ? <Workbench backend={chosen} /> : null;
}
