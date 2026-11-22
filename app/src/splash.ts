// The startup splash: the logo with the version; the main window closes it.
import { version } from "../package.json";

const target = document.getElementById("version");
if (target) target.textContent = version;
