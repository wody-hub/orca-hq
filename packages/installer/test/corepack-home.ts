import { homedir } from "node:os";
import { join } from "node:path";

export const preservedCorepackHome = process.env.COREPACK_HOME ?? join(
  process.env.XDG_CACHE_HOME
    ?? process.env.LOCALAPPDATA
    ?? join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
  "node/corepack"
);
